import { createServer } from "node:http";

import { PrismaPg } from "@prisma/adapter-pg";
import { WebSocketServer, type WebSocket } from "ws";

import { PrismaClient } from "@darkview/db";

import { authenticateAgent } from "@/auth/device-token";
import { authenticateClient, isAllowedOrigin } from "@/auth/user-session";
import { AgentLink } from "@/link/agent-link";
import { AgentRelay } from "@/link/agent-relay";
import { CommandListener } from "@/link/command-listener";
import { createPrismaStore } from "@/link/prisma-store";
import { AgentLinkRegistry } from "@/link/registry";
import { HEARTBEAT_INTERVAL_SECONDS } from "@/link/protocol";
import type { ObservatoryRecord } from "@/link/store";
import {
  getStorageConfiguration,
  type StorageConfiguration,
} from "@darkview/storage/config";
import type { RealtimeStore } from "@/link/prisma-store";
import { MissionRelay } from "@/mission/broadcast";
import { MissionChannel } from "@/mission/channel";
import { MissionChannelRegistry } from "@/mission/registry";
import type { ChannelUser } from "@/mission/store";
import { handleInternalRequest } from "@/internal/http";
import { handleStreamRequest } from "@/stream/http";
import { LiveStream } from "@/stream/live-stream";
import { getEnvironment } from "@/env";
import { dispatchPendingEmails, queueSlotReminders } from "@/notifications/email";
import { evaluateEndedSlots, refundExpiredEntitlements } from "@/refunds/entitlements";
import { createSandboxCharger, sweepSubscriptions } from "@/subscriptions/renewals";
import { refreshViewingConditions } from "@/conditions/forecast";
import { openMeteoSource } from "@/conditions/open-meteo";

const AGENT_PATH = "/ws/agent";

/** How often bookings starting within the reminder window are queued (DV-064). */
const REMINDER_SWEEP_INTERVAL_SECONDS = 60;

/** How often the email outbox is delivered (DV-064). */
const EMAIL_DISPATCH_INTERVAL_SECONDS = 30;

/**
 * How often ended slots are judged and thirty-day entitlements refunded (DV-111).
 * Neither is urgent to the minute; both are idempotent.
 */
const ENTITLEMENT_SWEEP_INTERVAL_SECONDS = 60;

/**
 * How often ended subscription periods are expired, cancelled or charged (ADR-022).
 * Idempotent, and nothing about a renewal is urgent to the minute.
 */
const SUBSCRIPTION_SWEEP_INTERVAL_SECONDS = 60;

/**
 * How often viewing conditions are fetched (DV-110). Forecast models update hourly
 * at best, and every fetch is a call against a provider's quota.
 */
const CONDITIONS_REFRESH_INTERVAL_SECONDS = 60 * 60;

/**
 * `ws` hands a binary message as a Buffer, an ArrayBuffer or an array of Buffers
 * depending on how it was framed. One shape reaches the link, so that the length
 * check against the header is comparing the same thing every time.
 */
function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * How often the ADR-009 fallback looks for commands the notification never
 * delivered. A command's own TTL is 30 seconds, so a sweep slower than that would
 * only ever find expired work.
 */
const PENDING_SWEEP_INTERVAL_SECONDS = 15;

/**
 * How often a slot nobody started is closed (ADR-018). Slots are twenty minutes or
 * more, so a minute's lag in marking a no-show costs nothing.
 */
const UNSTARTED_SWEEP_INTERVAL_SECONDS = 60;

/** `/ws/mission/{missionId}`, as the contract's missionClient channel names it. */
const MISSION_PATH = /^\/ws\/mission\/([0-9a-fA-F-]{36})$/;

/**
 * The Darkview realtime service.
 *
 * A separate long-running process, by design and not by preference. The
 * observatory link is a socket held open for hours: a serverless function cannot
 * hold one, and `docs/ENGINEERING.md` forbids trying. The Next.js API app never sees it.
 *
 * The observatory dials out to this service. Nothing here ever dials the
 * observatory, which has no reachable address and no listening port.
 */
export function createRealtimeServer(
  store: RealtimeStore,
  appUrl: string,
  streamSecret: string,
  storage: StorageConfiguration,
  internalSecret: string,
) {
  const registry = new AgentLinkRegistry();
  const relay = new AgentRelay(store, registry);
  const missions = new MissionChannelRegistry();
  const live = new LiveStream(appUrl, streamSecret);
  const broadcast = new MissionRelay(store, missions, live);
  const httpServer = createServer((request, response) => {
    // ADR-017: the API's read of live telemetry. Synchronous and database-free, so
    // it is answered before the stream handler and cannot reject.
    if (
      handleInternalRequest(
        { registry, secret: internalSecret },
        request,
        response,
        request.headers.authorization,
      )
    ) {
      return;
    }

    // The service's first HTTP surface beyond the upgrade handshake (ADR-011).
    // Everything that is not a live view is still 404, including a stream request
    // that fails any of its checks -- the handler answers those itself so that a
    // refusal is indistinguishable from a path that does not exist.
    void handleStreamRequest({ store, stream: live }, request, response)
      .then((handled) => {
        if (!handled) response.writeHead(404).end();
      })
      .catch((error) => {
        // The database dropping mid-request. Logged and answered, never rethrown:
        // an unhandled rejection ends the process, and this process is also
        // holding the observatory socket.
        console.error("darkview realtime: stream", error);
        if (!response.headersSent) response.writeHead(500).end();
        else response.end();
      });
  });
  const sockets = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    void (async () => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;

      if (path === AGENT_PATH) {
        const observatory = await authenticateAgent(
          store,
          request.headers.authorization,
        );
        if (!observatory) {
          // No detail: an unauthenticated caller learns nothing about which part
          // of the credential was wrong, or whether the observatory exists.
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }

        sockets.handleUpgrade(request, socket, head, (connection) => {
          attach(connection, observatory);
        });
        return;
      }

      const mission = MISSION_PATH.exec(path);
      if (!mission) {
        socket.destroy();
        return;
      }

      // Origin first, before the cookie is even read. A WebSocket handshake is not
      // subject to the same-origin policy, so any page anywhere can open one to
      // this service and the browser will attach the customer's cookies. Refusing
      // here is what stops another site driving a subscription as the customer.
      if (!isAllowedOrigin(request.headers.origin, appUrl)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      const user = await authenticateClient(store, request.headers.cookie, new Date());
      if (!user) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      sockets.handleUpgrade(request, socket, head, (connection) => {
        watch(connection, mission[1], user);
      });
    })().catch((error) => {
      // The database dropping during the token or cookie lookup. Caught for the
      // same reason as every other path in this file: an unhandled rejection
      // ends the process, and the process holds every observatory's socket.
      console.error("darkview realtime: upgrade", error);
      socket.destroy();
    });
  });

  /**
   * The whole authenticated record is handed to the link, not just its id.
   *
   * `mode` in particular is the SIMULATED/REAL flag the hardware-safety rules are
   * built on, so it has to be the database's answer. A literal here would read as
   * true to the first piece of code that consults it and be wrong for any
   * observatory an operator had switched to REAL.
   */
  function attach(connection: WebSocket, observatory: ObservatoryRecord) {
    const link = new AgentLink(
      observatory,
      store,
      (message) => connection.send(JSON.stringify(message)),
      (reason) => connection.close(1000, reason),
      broadcast,
      storage,
    );

    const admission = registry.admit(observatory.id, link);
    if (!admission.admitted) {
      // The incumbent keeps the observatory. This connection is closed without
      // ever being registered, so the running link is untouched.
      connection.close(1008, "observatory already connected");
      return;
    }

    connection.on("message", (data, isBinary) => {
      // The pixels of the live-frame header that arrived immediately before.
      // Routed before the text path so that a binary frame is never handed to the
      // JSON parser, which would refuse it and answer the agent with a
      // BAD_REQUEST for every frame it sent.
      if (isBinary) {
        void link.receiveBinary(toBuffer(data)).catch((error) => {
          console.error("darkview realtime: live frame", error);
        });
        return;
      }

      // Only on the transition. An agent that has just said hello may have missed
      // notifications while it was away, and ADR-009 makes the row the source of
      // truth -- so anything unrelayed goes out once, here.
      //
      // This used to fire on every inbound frame, which is every heartbeat: the
      // safety envelope and the session owner were pushed back down the wire every
      // five seconds, at three queries a time, on an observatory doing nothing.
      // The periodic half of the fallback is the timer below.
      const before = link.currentState;
      void link
        .receive(data.toString())
        .then(() => {
          if (before !== "ONLINE" && link.currentState === "ONLINE") {
            return relay.sweep(observatory.id);
          }
        })
        .catch((error) => {
          // A store rejection while handling one agent message -- a heartbeat
          // during a database blip -- is logged, not left to end the process.
          // The agent gets no ack and replays; every other observatory keeps
          // its link.
          console.error("darkview realtime: agent message", error);
        });
    });
    connection.on("close", () => {
      registry.release(observatory.id, link);
      // Whatever this observatory was streaming is gone with the link, and any
      // response still writing it is closed. Holding the last frame of a dead
      // link would show a customer a still image and call it live.
      live.releaseObservatory(observatory.id);
      void store.markLinkLost(observatory.id, new Date()).catch((error) => {
        console.error("darkview realtime: link lost", error);
      });
    });
  }

  /**
   * One customer watching one mission.
   *
   * The channel is registered before the subscribe is validated, so that a socket
   * that never subscribes is still swept by the idle timer and still removed on
   * close. `dispatch` refuses to send to an unsubscribed channel, so being in the
   * registry early grants it nothing.
   */
  function watch(connection: WebSocket, missionId: string, user: ChannelUser) {
    const channel = new MissionChannel(
      missionId,
      user,
      store,
      (message) => connection.send(JSON.stringify(message)),
      (reason) => connection.close(1000, reason),
      live,
    );

    missions.add(missionId, channel);

    connection.on("message", (data) => {
      // Caught, not left to `void`. A rejection here -- the database dropping
      // mid-subscribe -- would otherwise be an unhandled rejection, and Node
      // exits the process on those. That process also holds the observatory
      // socket, so one customer's message during a database blip would take the
      // telescope link down with it. The customer loses their view; the mission
      // does not lose its link.
      void channel.receive(data.toString()).catch((error) => {
        console.error("darkview realtime: mission channel", error);
        channel.terminate("internal error");
      });
    });
    connection.on("close", () => missions.remove(missionId, channel));
  }

  const heartbeatSweep = setInterval(() => {
    const at = Date.now();
    void registry.expireSilent(at).catch((error) => {
      console.error("darkview realtime: heartbeat sweep", error);
    });
    missions.expireSilent(at);
    // Frames whose mission stopped sending without saying so. Mission end and link
    // loss are released explicitly above; this covers everything that just stops.
    live.releaseStale(at);
  }, HEARTBEAT_INTERVAL_SECONDS * 1000);

  /**
   * ADR-009's fallback poll, which the ADR describes and which did not exist.
   *
   * A `NOTIFY` is not delivered to a listener that was disconnected at that
   * instant, so the unrelayed row has to be swept for. Until now the only thing
   * doing that was the per-message sweep, which was both far too often and gone
   * the moment an agent stopped talking.
   *
   * Slow on purpose: it is a fail-safe, not a schedule. If it routinely finds
   * work, the notification path is broken and this is masking it, which is why it
   * says so.
   */
  const pendingSweep = setInterval(() => {
    for (const observatoryId of registry.observatoryIds()) {
      void relay
        .sweepPendingCommands(observatoryId)
        .then((sent) => {
          if (sent > 0) {
            console.warn(
              `relay fallback sent ${sent} command(s) for ${observatoryId}; ` +
                "the notification path did not deliver them",
            );
          }
        })
        .catch((error) => {
          console.error("darkview realtime: pending sweep", error);
        });
    }
  }, PENDING_SWEEP_INTERVAL_SECONDS * 1000);

  /**
   * ADR-018 §4: a booked slot nobody started closes at its end. Here because this
   * is the only long-lived process; an API that did it on request would leave a
   * mission SCHEDULED for as long as nobody asked about it.
   */
  const unstartedSweep = setInterval(() => {
    void store.closeUnstartedMissions(new Date()).catch((error) => {
      console.error("darkview realtime: no-show sweep", error);
    });
  }, UNSTARTED_SWEEP_INTERVAL_SECONDS * 1000);

  return {
    registry,
    relay,
    missions,
    live,
    listen: (port: number) => httpServer.listen(port),
    close: async () => {
      clearInterval(heartbeatSweep);
      clearInterval(pendingSweep);
      clearInterval(unstartedSweep);
      sockets.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

// Started as its own process. Not imported by the Next.js app -- see
// apps/api holds no agent link, asserted in realtime-is-separate.test.ts.
if (process.env.NODE_ENV !== "test") {
  const environment = getEnvironment();
  const server = createRealtimeServer(
    createPrismaStore(environment.DATABASE_URL),
    environment.APP_URL,
    environment.STREAM_SIGNING_SECRET,
    // ADR-012: a service that cannot sign refuses to start. This throws here,
    // before a socket is accepted, rather than at the first capture of the night.
    getStorageConfiguration(),
    environment.REALTIME_INTERNAL_SECRET,
  );
  server.listen(environment.REALTIME_PORT);

  // ADR-009. The listener is an optimisation over the sweep, so a failure to
  // connect it is logged and retried rather than fatal: commands still reach the
  // agent, just on reconnect instead of immediately.
  const listener = new CommandListener({
    connectionString: environment.DATABASE_URL,
    relay: server.relay,
    onError: (error) => console.error("darkview realtime: listener", error),
  });
  void listener.start();

  // DV-064. Its own client, so the link's store interface stays as narrow as the
  // link needs. Reminders are queued whether or not delivery is configured; an
  // outbox that fills while the mail service is unset is delivered once it is set.
  const notifications = new PrismaClient({
    adapter: new PrismaPg({ connectionString: environment.DATABASE_URL }),
  });
  setInterval(() => {
    void queueSlotReminders(notifications, new Date()).catch((error) => {
      console.error("darkview realtime: slot reminders", error);
    });
  }, REMINDER_SWEEP_INTERVAL_SECONDS * 1000);

  // DV-111, sharing the notifications client: both write to the email outbox.
  setInterval(() => {
    const now = new Date();
    void evaluateEndedSlots(notifications, now)
      .then(() => refundExpiredEntitlements(notifications, now))
      .then(({ unrefundable }) => {
        if (unrefundable > 0) {
          console.error(
            `darkview realtime: ${unrefundable} expired entitlement(s) are on a provider with no refund integration`,
          );
        }
      })
      .catch((error) => {
        console.error("darkview realtime: entitlements", error);
      });
  }, ENTITLEMENT_SWEEP_INTERVAL_SECONDS * 1000);

  // ADR-022 sections 8 and 9. The sandbox is never charged in production (ADR-022
  // section 11), so there the sweep still expires minutes and ends subscriptions
  // but opens no charge, until a real provider's charger exists.
  const charger = environment.NODE_ENV === "production" ? null : createSandboxCharger();
  setInterval(() => {
    void sweepSubscriptions(notifications, { charger, now: new Date() })
      .then(({ unsubmitted }) => {
        if (unsubmitted > 0) {
          console.error(`darkview realtime: ${unsubmitted} renewal charge(s) were not accepted`);
        }
      })
      .catch((error) => {
        console.error("darkview realtime: subscriptions", error);
      });
  }, SUBSCRIPTION_SWEEP_INTERVAL_SECONDS * 1000);

  // DV-110. Advisory only: this writes forecasts and never touches a weather hold.
  // meteoblue goes first in this list once a key and a verified adapter exist.
  const forecastSources = [openMeteoSource({ apiKey: environment.OPEN_METEO_API_KEY })];
  if (!environment.OPEN_METEO_API_KEY) {
    console.warn(
      "darkview realtime: OPEN_METEO_API_KEY is not set; forecasts use the non-commercial endpoint",
    );
  }
  const refreshConditions = () => {
    void refreshViewingConditions(notifications, { sources: forecastSources, now: new Date() })
      .then(({ unavailable, failures }) => {
        for (const failure of failures) console.error(`darkview realtime: conditions ${failure}`);
        if (unavailable > 0) {
          console.error(`darkview realtime: no forecast for ${unavailable} observatory(ies)`);
        }
      })
      .catch((error) => {
        console.error("darkview realtime: conditions", error);
      });
  };
  // Once at start as well: an hour with no stored forecast is an hour reported unknown.
  refreshConditions();
  setInterval(refreshConditions, CONDITIONS_REFRESH_INTERVAL_SECONDS * 1000);

  const webhook =
    environment.NOTIFICATION_WEBHOOK_URL && environment.NOTIFICATION_WEBHOOK_SECRET
      ? { url: environment.NOTIFICATION_WEBHOOK_URL, secret: environment.NOTIFICATION_WEBHOOK_SECRET }
      : null;
  if (webhook) {
    setInterval(() => {
      void dispatchPendingEmails({
        database: notifications,
        webhook,
        now: new Date(),
        voucherCodeSecret: environment.VOUCHER_CODE_SECRET,
      })
        .then((summary) => {
          if (summary.failed > 0) {
            console.error(`darkview realtime: ${summary.failed} email(s) gave up after every retry`);
          }
        })
        .catch((error) => {
          console.error("darkview realtime: email delivery", error);
        });
    }, EMAIL_DISPATCH_INTERVAL_SECONDS * 1000);
  } else {
    console.warn(
      "darkview realtime: NOTIFICATION_WEBHOOK_URL is not set; emails are queued and not sent",
    );
  }

  console.log(
    `darkview realtime listening on :${environment.REALTIME_PORT}${AGENT_PATH}`,
  );
}
