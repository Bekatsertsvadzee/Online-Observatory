import "server-only";

import { createHmac } from "node:crypto";

import { recordAuditEvent } from "@darkview/db/audit";
import type { AuthEventType } from "@darkview/db/enums";

import { getDatabase } from "@/lib/db/client";
import { getServerEnvironment } from "@/lib/validation/env";

export function hashAuditActor(value: string) {
  return createHmac("sha256", getServerEnvironment().AUTH_SECRET)
    .update(value)
    .digest("base64url");
}

export async function recordAuthEvent(
  type: AuthEventType,
  options: { userId?: string; actor?: string } = {},
) {
  // No transaction: an authentication attempt is not written anywhere else, so
  // there is nothing for the row to be atomic with.
  await recordAuditEvent(
    {
      category: "AUTH",
      action: type,
      actorUserId: options.userId,
      actorHash: options.actor ? hashAuditActor(options.actor) : undefined,
    },
    getDatabase(),
  );
}
