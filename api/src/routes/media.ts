import { Hono } from "hono";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { Readable } from "node:stream";
import { fail } from "../lib/errors.js";
import { BUCKETS, locateFile, verifySignature, type BucketName } from "../lib/storage.js";

/**
 * Pliki prywatne (niezweryfikowane zdjęcia/wideo, media nieopublikowanych recenzji).
 * Dostęp wyłącznie przez podpisany link wydany przez API komuś, kto ma do tego uprawnienia
 * (patrz mediaUrl() w lib/storage.ts). Pliki publiczne serwuje bezpośrednio Caddy pod /media/*.
 */
const mediaRouter = new Hono();

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
};

mediaRouter.get("/private/:bucket/*", async (c) => {
  const bucket = c.req.param("bucket") as string;
  const prefix = `/private/${bucket}/`;
  const raw = c.req.path.slice(c.req.path.indexOf(prefix) + prefix.length);
  let key: string;
  try { key = decodeURIComponent(raw); } catch { return fail(c, 404, "NOT_FOUND", "Not found"); }

  const exp = Number(c.req.query("exp"));
  const sig = c.req.query("sig") ?? "";
  if (!(Object.values(BUCKETS) as string[]).includes(bucket) || !verifySignature(bucket, key, exp, sig)) {
    return fail(c, 403, "INVALID_SIGNATURE", "Invalid or expired link");
  }

  let located;
  try { located = await locateFile(bucket as BucketName, key); } catch { located = null; }
  if (!located) return fail(c, 404, "NOT_FOUND", "Not found");

  const size = (await stat(located.path)).size;
  const type = MIME[extname(key).toLowerCase()] ?? "application/octet-stream";
  const headers: Record<string, string> = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
  if (range && (range[1] || range[2])) {
    let start = range[1] ? parseInt(range[1], 10) : size - parseInt(range[2]!, 10);
    let end   = range[1] && range[2] ? parseInt(range[2], 10) : size - 1;
    start = Math.max(0, start); end = Math.min(size - 1, end);
    if (start > end) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    }
    const body = Readable.toWeb(createReadStream(located.path, { start, end })) as unknown as ReadableStream;
    return new Response(body, {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }

  const body = Readable.toWeb(createReadStream(located.path)) as unknown as ReadableStream;
  return new Response(body, { status: 200, headers: { ...headers, "Content-Length": String(size) } });
});

export { mediaRouter };
