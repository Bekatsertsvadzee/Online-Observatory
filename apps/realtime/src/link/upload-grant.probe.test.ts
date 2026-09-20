import { expect, it } from "vitest";

import { presignUpload } from "@darkview/storage/presign";

import { FAKE_STORAGE } from "@/link/fake-storage";

/**
 * Audit probe, 2026-09-19, now a regression test. ADR-012: the agent uploads a
 * capture through a signed URL. `presign.ts` signed only `host`, so whoever held
 * the grant could PUT any size and any content type for 15 minutes. The agent
 * now declares both, the cloud checks them against the asset kind and signs
 * them, and storage refuses anything else.
 */
it("probe: the upload URL binds the content type and length", async () => {
  const { url } = await presignUpload(
    FAKE_STORAGE,
    "captures/a/b/c/IMAGE",
    new Date("2026-09-19T00:00:00Z"),
    { contentType: "image/jpeg", contentLength: 2_400_000 },
  );
  const signed = new URL(url).searchParams.get("X-Amz-SignedHeaders") ?? "";
  expect(signed.split(";")).toEqual(expect.arrayContaining(["content-type", "content-length"]));
});
