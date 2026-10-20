// A minimal S3-compatible object store for running the stack locally without MinIO:
// path-style PUT/GET/HEAD/DELETE on /bucket/key plus ListObjectsV2. Signatures are not
// checked. Development tooling only; never a product component.
import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_S3_PORT ?? 9000);
const objects = new Map(); // key -> { body: Buffer, type: string, modified: Date }
let puts = 0,
  gets = 0;

function esc(s) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const bucket = parts[0];
  const key = parts.slice(1).join("/");

  if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
    const prefix = url.searchParams.get("prefix") ?? "";
    const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const contents = keys
      .map((k) => {
        const o = objects.get(k);
        return `<Contents><Key>${esc(k)}</Key><Size>${o.body.length}</Size><LastModified>${o.modified.toISOString()}</LastModified></Contents>`;
      })
      .join("");
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(
      `<?xml version="1.0"?><ListBucketResult><Name>${esc(bucket ?? "")}</Name><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
    );
    return;
  }

  if (req.method === "PUT") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      objects.set(key, {
        body: Buffer.concat(chunks),
        type: req.headers["content-type"] ?? "application/octet-stream",
        modified: new Date(),
      });
      puts++;
      res.writeHead(200, { etag: '"fake"' });
      res.end();
    });
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    const o = objects.get(key);
    if (!o) {
      res.writeHead(404);
      res.end();
      return;
    }
    gets++;
    res.writeHead(200, { "content-type": o.type, "content-length": o.body.length });
    res.end(req.method === "HEAD" ? undefined : o.body);
    return;
  }

  if (req.method === "DELETE") {
    objects.delete(key);
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(405);
  res.end();
}).listen(PORT, "127.0.0.1", () => {
  console.log(`fake-s3 listening on 127.0.0.1:${PORT}`);
});

setInterval(() => {
  console.log(`fake-s3 objects=${objects.size} puts=${puts} gets=${gets}`);
}, 60_000).unref();
