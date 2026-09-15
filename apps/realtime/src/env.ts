import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.url().startsWith("postgresql://"),
  REALTIME_PORT: z.coerce.number().int().positive().default(4001),
  /**
   * The web app's origin. The only origin a mission-channel handshake may come
   * from. No default: a permissive fallback here would silently disable the check
   * that stops another site opening a subscription as a signed-in customer.
   */
  APP_URL: z.url(),
  /**
   * The key that signs live-view stream URLs (ADR-011).
   *
   * No default, for the same reason as APP_URL: a fallback would leave the
   * signature check running against a value anybody reading this repository
   * knows, which is worse than not signing at all because it looks like it works.
   *
   * The length floor matches AUTH_SECRET. An HMAC is only as strong as its key,
   * and a short one is guessable regardless of the algorithm.
   */
  STREAM_SIGNING_SECRET: z.string().min(32),
  /**
   * The secret the API presents on `/internal/*` (ADR-017). No default and a
   * 32-character floor, for the reasons above; separate from both secrets above
   * so it can be rotated alone.
   */
  REALTIME_INTERNAL_SECRET: z.string().min(32),
  /**
   * Where email notifications are delivered, and the key that signs them (DV-064).
   * Optional: unset, emails are still queued in the outbox and nothing is sent,
   * which a restart with both set then catches up on. Both or neither.
   */
  NOTIFICATION_WEBHOOK_URL: z.url().optional(),
  NOTIFICATION_WEBHOOK_SECRET: z.string().min(32).optional(),
}).refine(
  (environment) =>
    Boolean(environment.NOTIFICATION_WEBHOOK_URL) ===
    Boolean(environment.NOTIFICATION_WEBHOOK_SECRET),
  {
    message: "NOTIFICATION_WEBHOOK_URL and NOTIFICATION_WEBHOOK_SECRET are set together.",
    path: ["NOTIFICATION_WEBHOOK_URL"],
  },
);

export type RealtimeEnvironment = z.infer<typeof schema>;

export function getEnvironment(): RealtimeEnvironment {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    throw new Error(`Invalid realtime environment: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
