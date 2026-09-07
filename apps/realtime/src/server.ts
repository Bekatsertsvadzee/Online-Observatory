import { createServer } from "node:http";

import { WebSocketServer, type WebSocket } from "ws";

import { authenticateAgent } from "@/auth/device-token";
import { authenticateClient, isAllowedOrigin } from "@/auth/user-session";
import { AgentLink } from "@/link/agent-link";
import { AgentRelay } from "@/link/agent-relay";
import { CommandListener } from "@/link/command-listener";
import { createPrismaStore } from "@/link/prisma-store";
import { AgentLinkRegistry } from "@/link/registry";
import { HEARTBEAT_INTERVAL_SECONDS } from "@/link/protocol";
import type { ObservatoryRecord } from "@/link/store";
import type { RealtimeStore } from "@/link/prisma-store";
import { MissionRelay } from "@/mission/broadcast";
import { MissionChannel } from "@/mission/channel";
import { MissionChannelRegistry } from "@/mission/registry";
import type { ChannelUser } from "@/mission/store";
import { getEnvironment } from "@/env";

const AGENT_PATH = "/ws/agent";

/** `/ws/mission/{missionId}`, as the contract's missionClient channel names it. */
const MISSION_PATH = /^\/ws\/mission\/([0-9a-fA-F-]{36})$/;

/**
 * The Darkview realtime service.
 *
 * A separate long-running process, by design and not by preference. The
 * observatory link is a socket held open for hours: a serverless function cannot
 * hold one, and `CLAUDE.md` forbids trying. The Next.js API app never sees it.
 *
 * The observatory dials out to this service. Nothing here ever dials the
 * observatory, which has no reachable address and no listening port.
 */
export function createRealtimeServer(store: RealtimeStore, appUrl: string) {
  const registry = new AgentLinkRegistry();
  const relay = new AgentRelay(store, registry);
  const missions = new MissionChannelRegistry();
  const broadcast = new MissionRelay(store, missions);
  const httpServer = createServer((_request, response) => {
    response.writeHead(404).end();
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
    })();
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
    );

    const admission = registry.admit(observatory.id, link);
    if (!admission.admitted) {
      // The incumbent keeps the observatory. This connection is closed without
      // ever being registered, so the running link is untouched.
      connection.close(1008, "observatory already connected");
      return;
    }

    connection.on("message", (data) => {
      void link
        .receive(data.toString())
        // An agent that has just said hello may have missed notifications while it
        // was away. ADR-009: the row is the source of truth, so anything unrelayed
        // for this observatory goes out now.
        .then(() => {
          if (link.currentState === "ONLINE") void relay.sweep(observatory.id);
        });
    });
    connection.on("close", () => {
      registry.release(observatory.id, link);
      void store.markLinkLost(observatory.id, new Date());
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
    void registry.expireSilent(Date.now());
    missions.expireSilent(Date.now());
  }, HEARTBEAT_INTERVAL_SECONDS * 1000);

  return {
    registry,
    relay,
    missions,
    listen: (port: number) => httpServer.listen(port),
    close: async () => {
      clearInterval(heartbeatSweep);
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

  console.log(
    `darkview realtime listening on :${environment.REALTIME_PORT}${AGENT_PATH}`,
  );
}
