import { expect, it } from "vitest";

import { presignUpload } from "@darkview/storage/presign";

import { FAKE_STORAGE } from "@/link/fake-storage";

/**
 * What an upload grant actually permits (ADR-012).
 *
 * `presign.ts` once signed `host` and nothing else, so whoever held the grant
 * could PUT any size and any content type at that key for fifteen minutes -- and
 * the holder is the least-trusted machine we operate. The agent now declares
 * both, the cloud checks them against the asset kind and signs them, and storage
 * refuses anything else.
 */
it("the upload URL binds the content type and length", async () => {
  const { url } = await presignUpload(
    FAKE_STORAGE,
    "captures/a/b/c/IMAGE",
    new Date("2026-09-19T00:00:00Z"),
    { contentType: "image/jpeg", contentLength: 2_400_000 },
  );
  const signed = new URL(url).searchParams.get("X-Amz-SignedHeaders") ?? "";
  expect(signed.split(";")).toEqual(expect.arrayContaining(["content-type", "content-length"]));
});
