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
});

export type ServerEnvironment = z.infer<typeof serverEnvironmentSchema>;

export function getServerEnvironment(): ServerEnvironment {
  const result = serverEnvironmentSchema.safeParse(process.env);

  if (!result.success) {
    throw new Error(`Invalid server environment: ${z.prettifyError(result.error)}`);
  }

  return result.data;
}
