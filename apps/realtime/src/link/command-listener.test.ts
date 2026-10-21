import { describe, expect, it, vi } from "vitest";

import type { AgentRelay } from "@/link/agent-relay";
import { CommandListener } from "@/link/command-listener";

/**
 * The listener relays notifications in the order PostgreSQL delivered them.
 *
 * Found by running the stack end to end: `POST /missions/{id}/start` notifies the
 * session owner and then the opening GOTO inside one transaction. Each relay reads
 * its own row before dispatching, and when both reads were in flight at once the
 * command's answer could come back first. The agent, not yet told who owned the
 * mission, refused the GOTO with NO_ACTIVE_MISSION and the mission was FAILED
 * 270 ms after the customer pressed start. The e2e suite never saw it because it
 * chains `relay.handle` calls itself; production fired them concurrently.
 */
function listenerWith(
  relay: Pick<AgentRelay, "handle">,
  onError?: (error: unknown) => void,
) {
  return new CommandListener({
    connectionString: "postgresql://unused",
    relay: relay as AgentRelay,
    onError,
  });
}

describe("CommandListener relays notifications in arrival order", () => {
  it("does not let a fast relay overtake a slow one that arrived first", async () => {
    const started: string[] = [];
    const finished: string[] = [];
    let releaseSession: () => void = () => undefined;

    const relay = {
      handle: vi.fn(async (raw: string) => {
        const { kind } = JSON.parse(raw) as { kind: string };
        started.push(kind);
        if (kind === "SESSION") {
          // The session row read is the slow one this time.
          await new Promise<void>((resolve) => {
            releaseSession = resolve;
          });
        }
        finished.push(kind);
        return "SENT" as const;
      }),
    };

    const listener = listenerWith(relay);
    const first = listener.enqueue(
      JSON.stringify({
        kind: "SESSION",
        observatoryId: "o",
        missionId: "m",
        sessionId: "s",
      }),
    );
    const second = listener.enqueue(
      JSON.stringify({ kind: "COMMAND", commandId: "c", observatoryId: "o" }),
    );

    // The command must not even start until the session relay has finished.
    await Promise.resolve();
    expect(started).toEqual(["SESSION"]);

    releaseSession();
    await first;
    await second;

    expect(started).toEqual(["SESSION", "COMMAND"]);
    expect(finished).toEqual(["SESSION", "COMMAND"]);
  });

  it("reports a failed relay and still relays the ones behind it", async () => {
    const errors: unknown[] = [];
    const handled: string[] = [];
    const relay = {
      handle: vi.fn(async (raw: string) => {
        const { kind } = JSON.parse(raw) as { kind: string };
        if (kind === "ENVELOPE") throw new Error("database went away");
        handled.push(kind);
        return "SENT" as const;
      }),
    };

    const listener = listenerWith(relay, (error) => errors.push(error));
    await listener.enqueue(JSON.stringify({ kind: "ENVELOPE", observatoryId: "o" }));
    await listener.enqueue(
      JSON.stringify({ kind: "COMMAND", commandId: "c", observatoryId: "o" }),
    );

    expect(errors).toHaveLength(1);
    expect(handled).toEqual(["COMMAND"]);
  });
});
