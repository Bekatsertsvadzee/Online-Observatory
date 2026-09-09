import { describe, expect, it } from "vitest";

import type { StorageConfiguration } from "@darkview/storage/config";
import { captureObjectKey } from "@darkview/storage/keys";
import {
  DOWNLOAD_URL_TTL_SECONDS,
  presignDownload,
  presignUpload,
  UPLOAD_URL_TTL_SECONDS,
} from "@darkview/storage/presign";

/**
 * What this repository owns about presigning, and what it does not.
 *
 * SigV4 itself is `@smithy/signature-v4`, AWS's own implementation, so nothing
 * here tries to prove that a signature is correctly computed -- there is no way
 * to prove that offline without the bucket this code exists to reach, and a
 * hand-pinned "expected signature" would be a constant nobody can check.
 *
 * What is ours is *what gets signed*: which object, which method, for how long,
 * and against which bucket. Those are the things a mistake here would get wrong,
 * and every one of them is observable in the URL.
 */
const CONFIGURATION: StorageConfiguration = {
  S3_ENDPOINT: "https://s3.eu-central-1.example.com",
  S3_REGION: "eu-central-1",
  S3_BUCKET: "darkview-captures",
  S3_ACCESS_KEY_ID: "AKIAEXAMPLEEXAMPLE00",
  S3_SECRET_ACCESS_KEY: "an-example-secret-that-is-not-a-real-key",
  S3_FORCE_PATH_STYLE: false,
};

const NOW = new Date("2026-12-15T18:00:00.000Z");

const KEY = captureObjectKey({
  observatoryId: "11111111-1111-4111-8111-111111111111",
  missionId: "22222222-2222-4222-8222-222222222222",
  commandId: "33333333-3333-4333-8333-333333333333",
  kind: "IMAGE",
});

describe("what an upload grant permits", () => {
  it("names one object, one method and an expiry", async () => {
    const { url, expiresAt } = await presignUpload(CONFIGURATION, KEY, NOW);
    const parsed = new URL(url);

    expect(parsed.host).toBe("darkview-captures.s3.eu-central-1.example.com");
    expect(parsed.pathname).toBe(`/${KEY}`);
    expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe(String(UPLOAD_URL_TTL_SECONDS));
    expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt).toEqual(new Date(NOW.getTime() + UPLOAD_URL_TTL_SECONDS * 1000));
  });

  it("signs against the region and the day it was minted", async () => {
    const { url } = await presignUpload(CONFIGURATION, KEY, NOW);
    const credential = new URL(url).searchParams.get("X-Amz-Credential");

    expect(credential).toBe(
      "AKIAEXAMPLEEXAMPLE00/20261215/eu-central-1/s3/aws4_request",
    );
  });

  it("expires sooner than an hour, because it is held by the least-trusted machine", async () => {
    // ADR-012: the presigned PUT is the whole of the observatory's authority
    // over the bucket. Long enough to push a FITS from a domestic uplink; not
    // long enough to be worth stealing.
    expect(UPLOAD_URL_TTL_SECONDS).toBeLessThanOrEqual(15 * 60);
    expect(DOWNLOAD_URL_TTL_SECONDS).toBeLessThan(UPLOAD_URL_TTL_SECONDS);
  });
});

describe("what the signature actually covers", () => {
  // Each of these changes one thing and expects a different signature. Together
  // they are the evidence that the URL is bound to the object, the bucket, the
  // method and the clock -- rather than being a signature over something else
  // with the interesting parts pasted alongside it.
  const signatureOf = async (url: string) =>
    new URL(url).searchParams.get("X-Amz-Signature");

  it("differs between two objects", async () => {
    const other = captureObjectKey({
      observatoryId: "11111111-1111-4111-8111-111111111111",
      missionId: "22222222-2222-4222-8222-222222222222",
      commandId: "33333333-3333-4333-8333-333333333333",
      kind: "FITS",
    });

    expect(await signatureOf((await presignUpload(CONFIGURATION, KEY, NOW)).url)).not.toBe(
      await signatureOf((await presignUpload(CONFIGURATION, other, NOW)).url),
    );
  });

  it("differs between PUT and GET, so a read grant is not a write grant", async () => {
    expect(await signatureOf((await presignUpload(CONFIGURATION, KEY, NOW)).url)).not.toBe(
      await signatureOf((await presignDownload(CONFIGURATION, KEY, NOW)).url),
    );
  });

  it("differs between two buckets", async () => {
    const elsewhere = { ...CONFIGURATION, S3_BUCKET: "somebody-elses-bucket" };

    expect(await signatureOf((await presignUpload(CONFIGURATION, KEY, NOW)).url)).not.toBe(
      await signatureOf((await presignUpload(elsewhere, KEY, NOW)).url),
    );
  });

  it("differs under a different secret", async () => {
    const rotated = { ...CONFIGURATION, S3_SECRET_ACCESS_KEY: "a different secret key" };

    expect(await signatureOf((await presignUpload(CONFIGURATION, KEY, NOW)).url)).not.toBe(
      await signatureOf((await presignUpload(rotated, KEY, NOW)).url),
    );
  });

  it("is the same for the same inputs, so nothing hidden varies", async () => {
    // Guards the guard: if signatures were random, every assertion above would
    // pass while proving nothing at all.
    expect(await signatureOf((await presignUpload(CONFIGURATION, KEY, NOW)).url)).toBe(
      await signatureOf((await presignUpload(CONFIGURATION, KEY, NOW)).url),
    );
  });
});

describe("where the bucket goes in the URL", () => {
  it("puts it in the path when path style is forced", async () => {
    // MinIO wants this, AWS refuses it on buckets created since 2020. The host
    // is part of the signature, so getting it wrong is a refused request rather
    // than a subtle one.
    const { url } = await presignUpload(
      { ...CONFIGURATION, S3_FORCE_PATH_STYLE: true },
      KEY,
      NOW,
    );
    const parsed = new URL(url);

    expect(parsed.host).toBe("s3.eu-central-1.example.com");
    expect(parsed.pathname).toBe(`/darkview-captures/${KEY}`);
  });
});

describe("the key the cloud derives", () => {
  it("is built only from identifiers the cloud already holds", () => {
    expect(KEY).toBe(
      "captures/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333/IMAGE",
    );
  });

  it("refuses anything that is not a UUID", () => {
    // ADR-012 has the cloud derive the key precisely so a compromised agent
    // cannot choose to write over another customer's object. These identifiers
    // come from the database and from a uuid-typed contract, so this should
    // never fire -- but "should never" is not a check, and the cost of being
    // wrong is an object written outside its prefix.
    expect(() =>
      captureObjectKey({
        observatoryId: "../../etc",
        missionId: "22222222-2222-4222-8222-222222222222",
        commandId: "33333333-3333-4333-8333-333333333333",
        kind: "IMAGE",
      }),
    ).toThrow(/not a UUID/);
  });
});
