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
});

export type RealtimeEnvironment = z.infer<typeof schema>;

export function getEnvironment(): RealtimeEnvironment {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    throw new Error(`Invalid realtime environment: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
