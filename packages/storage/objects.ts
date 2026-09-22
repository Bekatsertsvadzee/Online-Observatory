import type { HttpRequest } from "@smithy/protocol-http";

import type { StorageConfiguration } from "./config.ts";
import { requestFor, signerFor, urlOf } from "./presign";

/**
 * Listing and deleting objects, for the operator's orphan sweep (ADR-012, #141).
 *
 * Nothing on a customer's or an agent's path uses this. Those hold presigned URLs
 * for one object and one method; this signs with the bucket credential itself, so
 * it is only ever run by an operator, by hand.
 *
 * Signed in the headers rather than presigned: the request is made here and now,
 * by the process holding the credential, so there is no URL to hand anybody.
 */

export type StoredObject = { key: string; size: number; lastModified: Date };

type Fetch = typeof fetch;

async function send(
  configuration: StorageConfiguration,
  request: HttpRequest,
  now: Date,
  fetchImpl: Fetch,
): Promise<Response> {
  const signed = (await signerFor(configuration, { applyChecksum: true }).sign(request, {
    signingDate: now,
  })) as HttpRequest;

  // `host` is set by fetch from the URL, and to the same value that was signed.
  const headers = Object.fromEntries(
    Object.entries(signed.headers).filter(([name]) => name.toLowerCase() !== "host"),
  );
  return fetchImpl(urlOf(signed), { method: signed.method, headers });
}

/**
 * Every object under a prefix, following continuation tokens until the bucket says
 * there are no more. ListObjectsV2 returns at most a thousand keys a page, so a
 * sweep that read one page would call a bucket clean that was merely long.
 */
export async function* listObjects(
  configuration: StorageConfiguration,
  prefix: string,
  now: Date,
  fetchImpl: Fetch = fetch,
): AsyncGenerator<StoredObject> {
  let continuationToken: string | undefined;

  for (;;) {
    const query: Record<string, string> = { "list-type": "2", prefix };
    if (continuationToken) query["continuation-token"] = continuationToken;

    const response = await send(
      configuration,
      requestFor(configuration, "GET", "", {}, query),
      now,
      fetchImpl,
    );
    if (!response.ok) {
      throw new Error(`Listing the bucket failed with HTTP ${response.status}.`);
    }

    const page = parseListPage(await response.text());
    yield* page.objects;

    if (!page.truncated) return;
    if (!page.nextToken) {
      throw new Error("The bucket said the listing continues and gave no token to continue it.");
    }
    continuationToken = page.nextToken;
  }
}

/** Delete one object. S3 answers 204 whether or not it existed. */
export async function deleteObject(
  configuration: StorageConfiguration,
  key: string,
  now: Date,
  fetchImpl: Fetch = fetch,
): Promise<void> {
  const response = await send(
    configuration,
    requestFor(configuration, "DELETE", key),
    now,
    fetchImpl,
  );
  if (!response.ok) {
    throw new Error(`Deleting ${key} failed with HTTP ${response.status}.`);
  }
}

/**
 * One ListObjectsV2 page.
 *
 * A few regular expressions rather than an XML library: the response has a fixed,
 * flat shape, and the keys this sweep can act on are UUIDs and an enum, so nothing
 * in them needs more than the five predefined entities decoded. A key that did
 * would not match the derived shape and would be reported, never deleted.
 */
export function parseListPage(xml: string): {
  objects: StoredObject[];
  truncated: boolean;
  nextToken: string | undefined;
} {
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((match) => {
    const body = match[1];
    const key = field(body, "Key");
    const size = field(body, "Size");
    const lastModified = field(body, "LastModified");
    if (key === undefined || size === undefined || lastModified === undefined) {
      throw new Error("A listed object is missing its Key, Size or LastModified.");
    }
    return { key, size: Number(size), lastModified: new Date(lastModified) };
  });

  return {
    objects,
    truncated: field(xml, "IsTruncated") === "true",
    nextToken: field(xml, "NextContinuationToken"),
  };
}

function field(xml: string, name: string): string | undefined {
  const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match ? decodeEntities(match[1]) : undefined;
}

function decodeEntities(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}
