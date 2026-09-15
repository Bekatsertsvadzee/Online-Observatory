import { assertDetailCarriesNoSecret } from "./audit";
import type { Prisma } from "./generated/prisma/client.ts";
import type { EmailNotificationKind } from "./generated/prisma/enums.ts";

/**
 * Queue one email (DV-064).
 *
 * Here for the reason `recordAuditEvent` is: the API confirms bookings and sets
 * weather holds, the realtime service records captures and sends reminders, and
 * both write to the same outbox.
 *
 * Pass the transaction client when there is a transaction, so the email and the
 * event share a fate. The payload is ids only, and is held to the same no-secrets
 * rule as audit detail.
 *
 * Returns whether a row was written. False is the dedupe key doing its job -- the
 * same event queued a second time -- not an error.
 */
export type EmailOutboxWriter = Pick<Prisma.TransactionClient, "emailNotification">;

export async function queueEmail(
  writer: EmailOutboxWriter,
  email: {
    userId: string;
    kind: EmailNotificationKind;
    dedupeKey: string;
    payload: Record<string, string>;
  },
): Promise<boolean> {
  assertDetailCarriesNoSecret(email.payload);

  const { count } = await writer.emailNotification.createMany({
    data: [
      {
        userId: email.userId,
        kind: email.kind,
        dedupeKey: email.dedupeKey,
        payload: email.payload as Prisma.InputJsonObject,
      },
    ],
    skipDuplicates: true,
  });
  return count === 1;
}
