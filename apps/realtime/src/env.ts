import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.url().startsWith("postgresql://"),
  REALTIME_PORT: z.coerce.number().int().positive().default(4001),
});

export type RealtimeEnvironment = z.infer<typeof schema>;

export function getEnvironment(): RealtimeEnvironment {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    throw new Error(`Invalid realtime environment: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
