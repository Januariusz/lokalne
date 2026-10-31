import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { eq, and, ne, desc, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { photo, video, camera } from "../db/schema.js";
import { requireAuth, requireRole } from "../middleware/requireAuth.js";
import {
  storeFile, TMP_DIR, storageUrl, type Visibility, publicUrl, mediaUrl, deleteStoredObject, BUCKETS, type BucketName,
  variantUrl,
} from "../lib/storage.js";
import { fail } from "../lib/errors.js";
import { tidyNumber } from "../lib/numbers.js";
import { parseMultipartUpload, UploadError, type ParsedUpload } from "../lib/multipart.js";
import type { HonoVariables } from "../types/honoTypes.js";
import { randomUUID } from "node:crypto";
import { sniffFile, stripMetadataInPlace, downscaleInPlace, readDimensions, runImageJob } from "../lib/images.js";
import { ensureVariants } from "../services/mediaVariants.js";
import { phoneSummaries } from "../services/phones.js";

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

function optionalNumber(fields: Record<string, string>, key: string): number | null {
  const raw = fields[key];
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? tidyNumber(n) : null;
}

/**
 * Zdjęcia/wideo oraz media recenzji lądują w katalogu PRYWATNYM i stają się publiczne dopiero po
 * weryfikacji (moderator) albo opublikowaniu recenzji. Obrazy urządzeń (moderator) są od razu publiczne.
 */
async function putFile(
  bucket: BucketName, objectKey: string, upload: ParsedUpload, visibility: Visibility = "private",
) {
  // Caddy ustala Content-Type po rozszerzeniu pliku, a rozszerzenie pochodzi z rozpoznanej zawartości.
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

const REVIEW_IMAGE_MAX = PHOTO_MAX;           // obrazy w recenzjach: pełna rozdzielczość (filmy mają limit VIDEO_MAX)
const DEVICE_IMAGE_SIDE = 1600;            // dłuższy bok zdjęcia telefonu w katalogu

const unsupported = (c: Ctx, what: string) =>
  fail(c, 400, "UNSUPPORTED_MEDIA_TYPE", `Unsupported file type. Accepted: ${what}`);

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

    // typ pliku z jego zawartości, nie z nagłówka klienta
    const type = await sniffFile(upload.file.path);
    if (!type || type.kind !== "image") return unsupported(c, "JPEG, PNG, WebP, GIF, HEIC, AVIF");

    // Z EXIF zostają dane aparatu (model, obiektyw, ogniskowa, przysłona, czas, ISO, data);
    // GPS, numery seryjne i dane właściciela są usuwane.
    await stripMetadataInPlace(upload.file.path, type.ext, "camera");

    const objectKey = `${cameraId}/${randomUUID()}.${type.ext}`;
    const stored = storageUrl(BUCKETS.photos, objectKey);
    await putFile(BUCKETS.photos, objectKey, upload);

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
    await ensureVariants(BUCKETS.photos, objectKey, "photo");
    return c.json({
      id: newPhoto.id, status: "pending", objectKey,
      thumbUrl: variantUrl(stored, "w480", false),
      mediumUrl: variantUrl(stored, "w1280", false),
    }, 201);
  } finally {
    await upload.cleanup();
  }
});

/**
 * Zdjęcia wgrane przez zalogowanego użytkownika (do galerii aparatów), najnowsze na górze.
 * ?status=pending|verified, ?cameraId=, ?smartphoneId=, ?page= (od 1), ?limit= (domyślnie 30, maks. 100).
 * Oczekujące zdjęcia mają podpisane linki (ważne 1-2 h), zweryfikowane - publiczne.
 */
uploadRouter.get("/photos/mine", requireAuth, async (c) => {
  const user = c.get("user");
  const q = c.req.query();
  const page = q["page"] === undefined ? 1 : Number(q["page"]);
  const limit = q["limit"] === undefined ? 30 : Number(q["limit"]);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return fail(c, 400, "INVALID_PAGE", "page must be >= 1 and limit between 1 and 100");
  }
  const conds: SQL[] = [eq(photo.uploaderId, user.id), ne(photo.status, "deleted")];
  if (q["status"] !== undefined) {
    if (q["status"] !== "pending" && q["status"] !== "verified") {
      return fail(c, 400, "INVALID_FIELD", "status must be pending or verified", { field: "status" });
    }
    conds.push(eq(photo.status, q["status"]));
  }
  if (q["cameraId"]) conds.push(eq(photo.cameraId, q["cameraId"]));
  if (q["smartphoneId"]) conds.push(eq(camera.smartphoneId, q["smartphoneId"]));
  const where = and(...conds);

  const rows = await db.select({
    id: photo.id, cameraId: photo.cameraId, smartphoneId: camera.smartphoneId,
    cameraType: camera.type, facing: camera.facing, status: photo.status, storageUrl: photo.storageUrl,
    widthPx: photo.widthPx, heightPx: photo.heightPx,
    exifFocalLength: photo.exifFocalLength, exifAperture: photo.exifAperture,
    exifIso: photo.exifIso, exifShutterSpeed: photo.exifShutterSpeed, uploadDate: photo.uploadDate,
  }).from(photo).innerJoin(camera, eq(photo.cameraId, camera.id))
    .where(where).orderBy(desc(photo.uploadDate), desc(sql`${photo}.rowid`))
    .limit(limit).offset((page - 1) * limit);
  const total = (await db.select({ n: sql<number>`count(*)` }).from(photo)
    .innerJoin(camera, eq(photo.cameraId, camera.id)).where(where))[0]?.n ?? 0;
  const phones = await phoneSummaries(rows.map((r) => r.smartphoneId));

  c.header("Cache-Control", "private, no-cache");
  return c.json({
    data: rows.map(({ storageUrl: s, ...r }) => {
      const pub = r.status === "verified";
      return {
        ...r,
        phone: phones.get(r.smartphoneId) ?? null,
        url: mediaUrl(s, pub),
        thumbUrl: variantUrl(s, "w480", pub),
        mediumUrl: variantUrl(s, "w1280", pub),
      };
    }),
    page, limit, total,
  });
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

    const type = await sniffFile(upload.file.path);
    if (!type || type.kind !== "video") return unsupported(c, "MP4, MOV, WebM");

    const objectKey = `${cameraId}/${randomUUID()}.${type.ext}`;
    const stored = storageUrl(BUCKETS.videos, objectKey);

    await putFile(BUCKETS.videos, objectKey, upload);

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

// Obraz albo film do recenzji. Obraz: maks. 60 MB, w pełnej rozdzielczości (bez ponownego kodowania),
// z danymi aparatu w EXIF (bez GPS i numerów seryjnych) i miniaturami 480 px oraz 1280 px.
uploadRouter.post("/review-media/upload", requireAuth, videoLimit, async (c) => {
  const r = await receive(c, VIDEO_MAX, []);
  if ("error" in r) return r.error;
  const { upload } = r;

  try {
    const type = await sniffFile(upload.file.path);
    if (!type) return unsupported(c, "JPEG, PNG, WebP, GIF, HEIC, AVIF, MP4, MOV, WebM");

    let dims: { width: number; height: number } | null = null;
    if (type.kind === "image") {
      if (upload.file.size > REVIEW_IMAGE_MAX) {
        return fail(c, 413, "FILE_TOO_LARGE", "Review image is too large (max 60 MB)");
      }
      await stripMetadataInPlace(upload.file.path, type.ext, "camera");
      dims = await runImageJob(() => readDimensions(upload.file.path));
    }

    const objectKey = `${randomUUID()}.${type.ext}`;
    await putFile(BUCKETS.reviewMedia, objectKey, upload);
    const stored = storageUrl(BUCKETS.reviewMedia, objectKey);
    if (type.kind === "image") await ensureVariants(BUCKETS.reviewMedia, objectKey, "review");

    // plik jest prywatny do czasu opublikowania recenzji; autor dostaje podpisany link do podglądu
    return c.json({
      objectKey,
      storageUrl: stored,
      url: mediaUrl(stored, false),
      type: type.kind === "image" ? "photo" : "video",
      widthPx: dims?.width ?? null,
      heightPx: dims?.height ?? null,
      thumbUrl: variantUrl(stored, "w480", false),
      mediumUrl: variantUrl(stored, "w1280", false),
    }, 201);
  } finally {
    await upload.cleanup();
  }
});

// Zdjęcie telefonu do katalogu (moderator): zmniejszane do 1600 px, bez metadanych, z miniaturami 512 i 1024 px.
uploadRouter.post("/device-image/upload", requireRole("moderator"), photoLimit, async (c) => {
  const r = await receive(c, PHOTO_MAX, []);
  if ("error" in r) return r.error;
  const { upload } = r;

  try {
    const type = await sniffFile(upload.file.path);
    if (!type || type.kind !== "image" || type.ext === "heic") return unsupported(c, "JPEG, PNG, WebP, GIF, AVIF");

    await stripMetadataInPlace(upload.file.path, type.ext, "orientation");
    await runImageJob(() => downscaleInPlace(upload.file.path, type.ext, DEVICE_IMAGE_SIDE));

    const objectKey = `${randomUUID()}.${type.ext}`;
    await putFile(BUCKETS.deviceImages, objectKey, upload, "public");
    const stored = storageUrl(BUCKETS.deviceImages, objectKey);
    await ensureVariants(BUCKETS.deviceImages, objectKey, "device");

    return c.json({
      objectKey, storageUrl: stored, url: publicUrl(stored),
      imageThumbUrl: variantUrl(stored, "w512", true), imageMediumUrl: variantUrl(stored, "w1024", true),
    }, 201);
  } finally {
    await upload.cleanup();
  }
});

export { uploadRouter };
