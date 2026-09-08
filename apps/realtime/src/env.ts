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
});

export type RealtimeEnvironment = z.infer<typeof schema>;

export function getEnvironment(): RealtimeEnvironment {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    throw new Error(`Invalid realtime environment: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
