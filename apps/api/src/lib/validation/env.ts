import "server-only";

import { z } from "zod";

const serverEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.url().startsWith("postgresql://"),
  APP_URL: z.url(),
  AUTH_SECRET: z.string().min(32),
  EMAIL_VERIFICATION_WEBHOOK_URL: z.url().optional(),
  EMAIL_VERIFICATION_WEBHOOK_SECRET: z.string().min(32).optional(),
  /**
   * How many proxies sit in front of this app. Decides how far from the right of
   * `X-Forwarded-For` the real client address is. Zero means the header is not
   * trusted at all, which is the only safe default: the left of that header is
   * written by the caller.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(8).default(0),
  /**
   * Signs the sandbox payment provider's callbacks (DV-056). Optional because a
   * deployment with no sandbox has no use for it; the webhook route refuses a
   * SANDBOX callback outright when it is unset rather than accepting one
   * unsigned. Never read in production, where SANDBOX is refused before this.
   */
  PAYMENT_SANDBOX_WEBHOOK_SECRET: z.string().min(32).optional(),
  /**
   * Where the API reads live operator telemetry from the realtime service, and the
   * secret it presents there (ADR-017). An origin, not a path. Optional: unset,
   * `GET /admin/observatories/{observatoryId}/state` answers 503 and nothing else is affected.
   */
  REALTIME_INTERNAL_URL: z.url().optional(),
  REALTIME_INTERNAL_SECRET: z.string().min(32).optional(),
  /**
   * How old a stored forecast hour may be before it is reported UNKNOWN (DV-110).
   * The realtime service refreshes hourly, so the default tolerates two missed
   * fetches. Unknown is never reported as clear, so a smaller value only shows
   * unknown sooner.
   */
  VIEWING_CONDITIONS_MAX_AGE_MINUTES: z.coerce.number().int().min(60).max(1440).default(180),
});

export type ServerEnvironment = z.infer<typeof serverEnvironmentSchema>;

export function getServerEnvironment(): ServerEnvironment {
  const result = serverEnvironmentSchema.safeParse(process.env);

  if (!result.success) {
    throw new Error(`Invalid server environment: ${z.prettifyError(result.error)}`);
  }

  return result.data;
}
