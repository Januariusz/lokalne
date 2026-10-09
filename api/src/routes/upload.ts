import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { photo, video, camera } from "../db/schema.js";
import { requireAuth, requireRole } from "../middleware/requireAuth.js";
import {
  storeFile, TMP_DIR, storageUrl, type Visibility, publicUrl, mediaUrl, deleteStoredObject, BUCKETS, type BucketName,
} from "../lib/storage.js";
import { fail } from "../lib/errors.js";
import { parseMultipartUpload, UploadError, type ParsedUpload } from "../lib/multipart.js";
import type { HonoVariables } from "../types/honoTypes.js";
import { randomUUID } from "node:crypto";

const uploadRouter = new Hono<{ Variables: HonoVariables }>();
type Ctx = Context<{ Variables: HonoVariables }>;

const PHOTO_MAX = 60 * 1024 * 1024;
const VIDEO_MAX = 300 * 1024 * 1024;

const photoLimit = bodyLimit({
  maxSize: PHOTO_MAX,
  onError: (c) => fail(c, 413, "FILE_TOO_LARGE", "Photo file is too large (max 60 MB)"),
});

const videoLimit = bodyLimit({
  maxSize: VIDEO_MAX,
  onError: (c) => fail(c, 413, "FILE_TOO_LARGE", "Video file is too large (max 300 MB)"),
});

/**
 * Odbiera upload strumieniowo (plik ląduje na dysku tymczasowym, nie w RAM).
 * UWAGA dla klientów: pola wymagane (np. cameraId, widthPx, heightPx) muszą być
 * wysłane PRZED polem "file".
 */
async function receive(c: Ctx, maxFileBytes: number, required: string[]) {
  try {
    const upload = await parseMultipartUpload(c.req.raw, { maxFileBytes, required, tmpDir: TMP_DIR });
    return { upload } as const;
  } catch (err) {
    if (err instanceof UploadError) {
      return { error: fail(c, err.status, err.code, err.message) } as const;
    }
    throw err;
  }
}

/** Typ MIME z multipart; "text/plain" to domyślna wartość busboy, gdy klient nie podał typu. */
function mimeOr(upload: ParsedUpload, fallback: string): string {
  const m = upload.file.mimeType;
  return m && m !== "text/plain" ? m : fallback;
}

function optionalNumber(fields: Record<string, string>, key: string): number | null {
  const raw = fields[key];
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Zdjęcia/wideo oraz media recenzji lądują w katalogu PRYWATNYM i stają się publiczne dopiero po
 * weryfikacji (moderator) albo opublikowaniu recenzji. Obrazy urządzeń (moderator) są od razu publiczne.
 */
async function putFile(
  bucket: BucketName, objectKey: string, upload: ParsedUpload, mimeType: string,
  visibility: Visibility = "private",
) {
  // mimeType nie jest zapisywany: Caddy ustala Content-Type po rozszerzeniu pliku.
  void mimeType;
  await storeFile(bucket, objectKey, upload.file.path, visibility);
}

/** Jeśli zapis rekordu się nie uda, nie zostawiamy osieroconego pliku na dysku. */
async function removeOrphan(url: string) {
  try {
    await deleteStoredObject(url);
  } catch (err) {
    console.error("[upload] could not remove orphaned object:", err);
  }
}

uploadRouter.post("/photo/upload", requireAuth, photoLimit, async (c) => {
  const user = c.get("user");
  const r = await receive(c, PHOTO_MAX, ["cameraId", "widthPx", "heightPx"]);
  if ("error" in r) return r.error;
  const { upload } = r;

  try {
    const cameraId = upload.fields["cameraId"] ?? "";
    const widthPx  = Number(upload.fields["widthPx"]);
    const heightPx = Number(upload.fields["heightPx"]);

    if (!cameraId || !widthPx || !heightPx) {
      return fail(c, 400, "MISSING_FIELDS", "cameraId, widthPx and heightPx are required");
    }

    const cam = await db.select({ id: camera.id }).from(camera).where(eq(camera.id, cameraId));
    if (!cam[0]) return fail(c, 404, "CAMERA_NOT_FOUND", "Camera not found");

    const mimeType = mimeOr(upload, "image/jpeg");
    const ext = mimeType === "image/png" ? "png"
              : mimeType === "image/webp" ? "webp"
              : "jpg";
    const objectKey = `${cameraId}/${randomUUID()}.${ext}`;
    const stored = storageUrl(BUCKETS.photos, objectKey);

    await putFile(BUCKETS.photos, objectKey, upload, mimeType);

    const newPhoto = {
      id:               randomUUID(),
      uploaderId:       user.id,
      cameraId,
      storageUrl:       stored,
      exifFocalLength:  optionalNumber(upload.fields, "exifFocalLength"),
      exifAperture:     optionalNumber(upload.fields, "exifAperture"),
      exifIso:          optionalNumber(upload.fields, "exifIso"),
      exifShutterSpeed: optionalNumber(upload.fields, "exifShutterSpeed"),
      widthPx,
      heightPx,
      uploadDate:       new Date(),
      status:           "pending" as const,
    };

    try {
      await db.insert(photo).values(newPhoto);
    } catch (err) {
      await removeOrphan(stored);
      throw err;
    }
    return c.json({ id: newPhoto.id, status: "pending", objectKey }, 201);
  } finally {
    await upload.cleanup();
  }
});

uploadRouter.post("/video/upload", requireAuth, videoLimit, async (c) => {
  const user = c.get("user");
  const r = await receive(c, VIDEO_MAX, ["cameraId", "widthPx", "heightPx", "fps"]);
  if ("error" in r) return r.error;
  const { upload } = r;

  try {
    const cameraId = upload.fields["cameraId"] ?? "";
    const widthPx  = Number(upload.fields["widthPx"]);
    const heightPx = Number(upload.fields["heightPx"]);
    const fps      = Number(upload.fields["fps"]);

    if (!cameraId || !widthPx || !heightPx || !fps) {
      return fail(c, 400, "MISSING_FIELDS", "cameraId, widthPx, heightPx and fps are required");
    }

    const cam = await db.select({ id: camera.id }).from(camera).where(eq(camera.id, cameraId));
    if (!cam[0]) return fail(c, 404, "CAMERA_NOT_FOUND", "Camera not found");

    const mimeType = mimeOr(upload, "video/mp4");
    const ext = mimeType.includes("quicktime") ? "mov"
              : mimeType.includes("webm") ? "webm"
              : "mp4";
    const objectKey = `${cameraId}/${randomUUID()}.${ext}`;
    const stored = storageUrl(BUCKETS.videos, objectKey);

    await putFile(BUCKETS.videos, objectKey, upload, mimeType);

    const newVideo = {
      id:         randomUUID(),
      uploaderId: user.id,
      cameraId,
      storageUrl: stored,
      widthPx,
      heightPx,
      fps,
      uploadDate: new Date(),
      status:     "pending" as const,
    };

    try {
      await db.insert(video).values(newVideo);
    } catch (err) {
      await removeOrphan(stored);
      throw err;
    }
    return c.json({ id: newVideo.id, status: "pending", objectKey }, 201);
  } finally {
    await upload.cleanup();
  }
});

uploadRouter.post("/review-media/upload", requireAuth, photoLimit, async (c) => {
  const r = await receive(c, PHOTO_MAX, []);
  if ("error" in r) return r.error;
  const { upload } = r;

  try {
    const mimeType = mimeOr(upload, "image/jpeg");
    const ext = mimeType.includes("png") ? "png"
              : mimeType.includes("webp") ? "webp"
              : mimeType.includes("mov") ? "mov"
              : mimeType.includes("webm") ? "webm"
              : mimeType.includes("video") ? "mp4" : "jpg";

    const objectKey = `${randomUUID()}.${ext}`;
    await putFile(BUCKETS.reviewMedia, objectKey, upload, mimeType);

    const stored = storageUrl(BUCKETS.reviewMedia, objectKey);
    // plik jest prywatny do czasu opublikowania recenzji; autor dostaje podpisany link do podglądu
    return c.json({ objectKey, storageUrl: stored, url: mediaUrl(stored, false) }, 201);
  } finally {
    await upload.cleanup();
  }
});

uploadRouter.post("/device-image/upload", requireRole("moderator"), photoLimit, async (c) => {
  const r = await receive(c, PHOTO_MAX, []);
  if ("error" in r) return r.error;
  const { upload } = r;

  try {
    const mimeType = mimeOr(upload, "image/jpeg");
    const ext = mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg";
    const objectKey = `${randomUUID()}.${ext}`;
    await putFile(BUCKETS.deviceImages, objectKey, upload, mimeType, "public");

    const stored = storageUrl(BUCKETS.deviceImages, objectKey);
    return c.json({ objectKey, storageUrl: stored, url: publicUrl(stored) }, 201);
  } finally {
    await upload.cleanup();
  }
});

export { uploadRouter };
