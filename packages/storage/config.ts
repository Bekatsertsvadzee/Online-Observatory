import { z } from "zod";

/**
 * Object storage, as ADR-012 decided it: S3-compatible, private, and never
 * addressed by a public path.
 *
 * The provider is deliberately not decided here. Presigning is identical across
 * AWS S3, Cloudflare R2, Backblaze B2 and MinIO, so this configuration is the
 * only thing that changes when one is chosen.
 *
 * Nothing has a default. ADR-012: "A service that cannot sign must refuse to
 * start rather than serve a Collection whose every download is broken." The same
 * reasoning as `STREAM_SIGNING_SECRET` -- a fallback credential is worse than a
 * missing one, because it looks like it works.
 */
const schema = z.object({
  /**
   * The endpoint's origin, e.g. `https://s3.eu-central-1.amazonaws.com` or an R2
   * or MinIO endpoint. The bucket is not part of it; how the bucket reaches the
   * URL is `S3_FORCE_PATH_STYLE`'s business.
   */
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  /**
   * Path style puts the bucket in the path (`https://host/bucket/key`) rather
   * than in the hostname (`https://bucket.host/key`).
   *
   * This one does have a default, because it is not a credential and getting it
   * wrong fails loudly and immediately rather than silently. MinIO wants `true`;
   * AWS S3 wants `false` and refuses path style on buckets created since 2020.
   */
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export type StorageConfiguration = z.infer<typeof schema>;

export function getStorageConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): StorageConfiguration {
  const result = schema.safeParse(environment);
  if (!result.success) {
    // The message names the variables and never their values: this function is
    // the one place the secret access key is in scope.
    throw new Error(
      `Object storage is not configured (ADR-012): ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
