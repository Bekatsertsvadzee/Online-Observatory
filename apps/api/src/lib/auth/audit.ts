import "server-only";

import { createHmac } from "node:crypto";

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
  await getDatabase().auditLog.create({
    data: {
      category: "AUTH",
      action: type,
      actorUserId: options.userId,
      actorHash: options.actor ? hashAuditActor(options.actor) : undefined,
    },
  });
}
