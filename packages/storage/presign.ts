import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";

import type { StorageConfiguration } from "./config.ts";

/**
 * Presigned S3 URLs: the agent's only authority over the bucket, and the
 * customer's only path to their own image.
 *
 * The signing itself is `@smithy/signature-v4`, AWS's own implementation, rather
 * than a hand-rolled SigV4. That is a deliberate line: an error in canonical
 * request construction produces a URL that looks right and is refused, and there
 * is no way to prove a bespoke implementation correct here without the very
 * bucket this code exists to reach. What this module owns, and what its tests
 * hold it to, is *what* gets signed -- the method, the object, the expiry -- not
 * how a signature is computed.
 *
 * The full S3 client is deliberately not a dependency. It is 3.3 MB to build a
 * URL; the signer is 106 KB and works identically against R2, B2 and MinIO,
 * which is what ADR-012 requires of this code.
 */

/**
 * How long a minted URL lives.
 *
 * Two values, because the two grants are not the same risk. An upload URL is
 * handed to the least-trusted machine we operate and permits a write, so it is
 * short: long enough for a mini-PC on a domestic uplink to push a FITS, and not
 * an hour. A download URL is handed to the customer who already owns the object
 * and permits only a read.
 */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

function signerFor(configuration: StorageConfiguration) {
  return new SignatureV4({
    service: "s3",
    region: configuration.S3_REGION,
    credentials: {
      accessKeyId: configuration.S3_ACCESS_KEY_ID,
      secretAccessKey: configuration.S3_SECRET_ACCESS_KEY,
    },
    sha256: Sha256,
    // S3 encodes the path once. The default double-encodes, which is right for
    // most AWS services and produces a signature S3 rejects for any key with a
    // character needing escape.
    uriEscapePath: false,
    applyChecksum: false,
  });
}

/**
 * Where the bucket goes.
 *
 * Virtual-host style puts it in the hostname, path style in the path. Both are
 * signed the same way; what differs is the host header, which is part of the
 * signature -- so getting this wrong is a refused request rather than a subtle
 * one.
 */
function requestFor(
  configuration: StorageConfiguration,
  method: "PUT" | "GET",
  key: string,
  extraHeaders: Record<string, string> = {},
) {
  const endpoint = new URL(configuration.S3_ENDPOINT);
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");

  const hostname = configuration.S3_FORCE_PATH_STYLE
    ? endpoint.hostname
    : `${configuration.S3_BUCKET}.${endpoint.hostname}`;

  const path = configuration.S3_FORCE_PATH_STYLE
    ? `/${configuration.S3_BUCKET}/${encodedKey}`
    : `/${encodedKey}`;

  return new HttpRequest({
    protocol: endpoint.protocol,
    hostname,
    port: endpoint.port ? Number(endpoint.port) : undefined,
    method,
    path,
    headers: {
      host: endpoint.port ? `${hostname}:${endpoint.port}` : hostname,
      ...extraHeaders,
    },
  });
}

function urlOf(signed: HttpRequest) {
  const query = Object.entries(signed.query ?? {})
    .flatMap(([name, value]) =>
      (Array.isArray(value) ? value : [value]).map(
        (each) => `${encodeURIComponent(name)}=${encodeURIComponent(String(each))}`,
      ),
    )
    .join("&");

  const port = signed.port ? `:${signed.port}` : "";
  return `${signed.protocol}//${signed.hostname}${port}${signed.path}${query ? `?${query}` : ""}`;
}

export type PresignedUrl = { url: string; expiresAt: Date };

/** What the agent has declared it is about to write. */
export type UploadShape = { contentType: string; contentLength: number };

/**
 * One object, one method, one shape, minutes.
 *
 * This is the whole of the observatory's authority over object storage. It holds
 * no bucket credential, so a stolen mini-PC yields a revocable device token and
 * nothing that reads or overwrites another customer's images.
 *
 * The media type and the exact length are signed alongside the key, not merely
 * checked before signing. A signature covers the headers it was given and
 * nothing else, so a URL signed over `host` alone permits any body of any size
 * at that key for as long as it lives -- and the party holding it is the least
 * trusted machine we operate. Signing them puts the limit in the grant itself,
 * where storage enforces it without this service being in the path.
 */
export async function presignUpload(
  configuration: StorageConfiguration,
  key: string,
  now: Date,
  shape: UploadShape,
  ttlSeconds = UPLOAD_URL_TTL_SECONDS,
): Promise<PresignedUrl> {
  const signed = await signerFor(configuration).presign(
    requestFor(configuration, "PUT", key, {
      "content-type": shape.contentType,
      "content-length": String(shape.contentLength),
    }),
    {
      expiresIn: ttlSeconds,
      signingDate: now,
      // Both must be in the signature rather than hoisted into the query string,
      // which is what the signer does by default with anything it is not told to
      // sign. A hoisted header is a suggestion; a signed one is a condition.
      unsignableHeaders: new Set<string>(),
      signableHeaders: new Set(["host", "content-type", "content-length"]),
    },
  );

  return {
    url: urlOf(signed as HttpRequest),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
  };
}

/** The customer's read of their own object, after the API's ownership check. */
export async function presignDownload(
  configuration: StorageConfiguration,
  key: string,
  now: Date,
  ttlSeconds = DOWNLOAD_URL_TTL_SECONDS,
): Promise<PresignedUrl> {
  const signed = await signerFor(configuration).presign(
    requestFor(configuration, "GET", key),
    { expiresIn: ttlSeconds, signingDate: now },
  );

  return {
    url: urlOf(signed as HttpRequest),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
  };
}
