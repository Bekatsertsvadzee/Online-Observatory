import type { StorageConfiguration } from "@darkview/storage/config";

/**
 * Object storage configuration for tests.
 *
 * Not a credential and cannot become one: the endpoint does not resolve and the
 * key is not an account. Any URL signed with it is refused by every real
 * endpoint, which is the point -- these tests assert what a grant *permits*, and
 * none of them reaches a bucket.
 *
 * One fixture rather than one per suite, so that a change to the shape of the
 * configuration is a single edit instead of eight that drift.
 */
export const FAKE_STORAGE: StorageConfiguration = {
  S3_ENDPOINT: "https://s3.example.test",
  S3_REGION: "eu-central-1",
  S3_BUCKET: "darkview-test",
  S3_ACCESS_KEY_ID: "AKIATESTTESTTESTTEST",
  S3_SECRET_ACCESS_KEY: "a-test-secret-that-signs-nothing-real",
  S3_FORCE_PATH_STYLE: false,
};
