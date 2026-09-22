import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { StorageConfiguration } from "@darkview/storage/config";
import { deleteObject, listObjects, parseListPage } from "@darkview/storage/objects";

/**
 * The signed list and delete, against a local stand-in for an S3 endpoint.
 *
 * The stand-in checks that a request is signed in its headers -- it cannot check
 * the signature, which would need the bucket this code exists to reach -- and serves
 * the listing in pages, so continuation is exercised for real over HTTP.
 */
let server: Server;
let storage: StorageConfiguration;
let requests: IncomingMessage[];
let pages: string[];

function page(keys: string[], nextToken?: string) {
  const contents = keys
    .map(
      (key) =>
        `<Contents><Key>${key}</Key><LastModified>2026-09-20T10:00:00.000Z</LastModified>` +
        `<ETag>&quot;x&quot;</ETag><Size>2048</Size></Contents>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>b</Name>` +
    `<IsTruncated>${nextToken ? "true" : "false"}</IsTruncated>` +
    (nextToken ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : "") +
    `${contents}</ListBucketResult>`
  );
}

beforeAll(async () => {
  server = createServer((request, response) => {
    requests.push(request);
    if (request.method === "DELETE") {
      response.writeHead(204).end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const token = url.searchParams.get("continuation-token");
    const index = token === null ? 0 : Number(token);
    response.writeHead(200, { "content-type": "application/xml" }).end(pages[index]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  storage = {
    S3_ENDPOINT: `http://127.0.0.1:${port}`,
    S3_REGION: "eu-central-1",
    S3_BUCKET: "darkview-test",
    S3_ACCESS_KEY_ID: "AKIATESTTESTTESTTEST",
    S3_SECRET_ACCESS_KEY: "a-test-secret-that-signs-nothing-real",
    S3_FORCE_PATH_STYLE: true,
  };
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  requests = [];
  pages = [];
});

const NOW = new Date("2026-09-22T12:00:00.000Z");

describe("listing", () => {
  it("follows continuation tokens across pages", async () => {
    pages = [page(["captures/a", "captures/b"], "1"), page(["captures/c"], "2"), page([])];

    const keys: string[] = [];
    for await (const object of listObjects(storage, "captures/", NOW)) keys.push(object.key);

    expect(keys).toEqual(["captures/a", "captures/b", "captures/c"]);
    expect(requests).toHaveLength(3);
  });

  it("signs each request in its headers, with the payload hash S3 requires", async () => {
    pages = [page(["captures/a"])];

    for await (const _ of listObjects(storage, "captures/", NOW)) void _;

    const [request] = requests;
    expect(request.url).toMatch(/^\/darkview-test\/\?/);
    expect(request.url).toContain("list-type=2");
    expect(request.url).toContain("prefix=captures%2F");
    expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATEST/);
    expect(request.headers["x-amz-content-sha256"]).toBeDefined();
    expect(request.headers["x-amz-date"]).toBe("20260922T120000Z");
  });

  it("reads size and time from the page", () => {
    const { objects } = parseListPage(page(["captures/a"]));

    expect(objects).toEqual([
      {
        key: "captures/a",
        size: 2048,
        lastModified: new Date("2026-09-20T10:00:00.000Z"),
      },
    ]);
  });

  it("refuses a page that says it continues without saying where", async () => {
    pages = [page(["captures/a"]).replace("<IsTruncated>false", "<IsTruncated>true")];

    const drain = async () => {
      for await (const _ of listObjects(storage, "captures/", NOW)) void _;
    };

    await expect(drain()).rejects.toThrow(/no token/);
  });
});

describe("deleting", () => {
  it("sends a signed DELETE for exactly that object", async () => {
    await deleteObject(storage, "captures/a/b", NOW);

    const [request] = requests;
    expect(request.method).toBe("DELETE");
    expect(request.url).toBe("/darkview-test/captures/a/b");
    expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256/);
  });
});
