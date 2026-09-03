import { createServer } from "node:http";

import { WebSocketServer, type WebSocket } from "ws";

import { authenticateAgent } from "@/auth/device-token";
import { AgentLink } from "@/link/agent-link";
import { createPrismaStore } from "@/link/prisma-store";
import { AgentLinkRegistry } from "@/link/registry";
import { HEARTBEAT_INTERVAL_SECONDS } from "@/link/protocol";
import type { LinkStore } from "@/link/store";
import { getEnvironment } from "@/env";

const AGENT_PATH = "/ws/agent";

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
export function createRealtimeServer(store: LinkStore) {
  const registry = new AgentLinkRegistry();
  const httpServer = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    void (async () => {
      if (new URL(request.url ?? "/", "http://localhost").pathname !== AGENT_PATH) {
        socket.destroy();
        return;
      }

      const observatory = await authenticateAgent(store, request.headers.authorization);
      if (!observatory) {
        // No detail: an unauthenticated caller learns nothing about which part
        // of the credential was wrong, or whether the observatory exists.
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      sockets.handleUpgrade(request, socket, head, (connection) => {
        attach(connection, observatory.id);
      });
    })();
  });

  function attach(connection: WebSocket, observatoryId: string) {
    const link = new AgentLink(
      { id: observatoryId, slug: "", mode: "SIMULATED" },
      store,
      (message) => connection.send(JSON.stringify(message)),
      (reason) => connection.close(1000, reason),
    );

    const admission = registry.admit(observatoryId, link);
    if (!admission.admitted) {
      // The incumbent keeps the observatory. This connection is closed without
      // ever being registered, so the running link is untouched.
      connection.close(1008, "observatory already connected");
      return;
    }

    connection.on("message", (data) => {
      void link.receive(data.toString());
    });
    connection.on("close", () => {
      registry.release(observatoryId, link);
      void store.markLinkLost(observatoryId, new Date());
    });
  }

  const sweep = setInterval(() => {
    void registry.expireSilent(Date.now());
  }, HEARTBEAT_INTERVAL_SECONDS * 1000);

  return {
    registry,
    listen: (port: number) => httpServer.listen(port),
    close: async () => {
      clearInterval(sweep);
      sockets.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

// Started as its own process. Not imported by the Next.js app -- see
// apps/api holds no agent link, asserted in realtime-is-separate.test.ts.
if (process.env.NODE_ENV !== "test") {
  const environment = getEnvironment();
  const server = createRealtimeServer(createPrismaStore(environment.DATABASE_URL));
  server.listen(environment.REALTIME_PORT);
  console.log(`darkview realtime listening on :${environment.REALTIME_PORT}${AGENT_PATH}`);
}
