import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { db } from "../db/index.js";
import { photo, video } from "../db/schema.js";
import { requireAuth, requireRole } from "../middleware/requireAuth.js";
import { uploadStream, storageUrl, BUCKETS } from "../lib/minio.js";
import type { HonoVariables } from "../types/honoTypes.js";
import { randomUUID } from "node:crypto";

const uploadRouter = new Hono<{ Variables: HonoVariables }>();




const photoLimit = bodyLimit({
  maxSize: 60 * 1024 * 1024,
  onError: (c) => c.json({ error: "Plik ze zdjęciem jest za duży (max 60 MB)" }, 413),
});


const videoLimit = bodyLimit({
  maxSize: 300 * 1024 * 1024,
  onError: (c) => c.json({ error: "Plik wideo jest za duży (max 300 MB)" }, 413),
});



uploadRouter.post("/photo/upload", requireAuth, photoLimit, async (c) => {
  const user = c.get("user");
  const formData = await c.req.formData();

  const file = formData.get("file") as File;
  const cameraId = formData.get("cameraId") as string;
  const widthPx = Number(formData.get("widthPx"));
  const heightPx = Number(formData.get("heightPx"));

  if (!file || !cameraId || !widthPx || !heightPx) {
    return c.json({ error: "file, cameraId, widthPx, and heightPx are required" }, 400);
  }

  const mimeType = file.type || "image/jpeg";
  const ext = mimeType === "image/png" ? "png"
  : mimeType === "image/webp" ? "webp"
  : "jpg";
  const objectKey = `${cameraId}/${randomUUID()}.${ext}`;

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  await uploadStream(BUCKETS.photos, objectKey, buffer, file.size, mimeType);

  const exifFocalLength = formData.has("exifFocalLength") ? Number(formData.get("exifFocalLength")) : null;
  const exifAperture = formData.has("exifAperture") ? Number(formData.get("exifAperture")) : null;
  const exifIso = formData.has("exifIso") ? Number(formData.get("exifIso")) : null;
  const exifShutterSpeed = formData.has("exifShutterSpeed") ? Number(formData.get("exifShutterSpeed")) : null;

  const newPhoto = {
    id:               randomUUID(),
                  uploaderId:       user.id,
                  cameraId,
                  storageUrl:       storageUrl(BUCKETS.photos, objectKey),
                  exifFocalLength,
                  exifAperture,
                  exifIso,
                  exifShutterSpeed,
                  widthPx,
                  heightPx,
                  uploadDate:       new Date(),
                  status:           "pending" as const,
  };

  await db.insert(photo).values(newPhoto);
  return c.json({ id: newPhoto.id, status: "pending", objectKey }, 201);
});


uploadRouter.post("/video/upload", requireAuth, videoLimit, async (c) => {
  const user = c.get("user");
  const formData = await c.req.formData();

  const file = formData.get("file") as File;
  const cameraId = formData.get("cameraId") as string;
  const widthPx = Number(formData.get("widthPx"));
  const heightPx = Number(formData.get("heightPx"));
  const fps = Number(formData.get("fps"));

  if (!file || !cameraId || !widthPx || !heightPx || !fps) {
    return c.json({ error: "file, cameraId, widthPx, heightPx, and fps are required" }, 400);
  }

  const mimeType = file.type || "video/mp4";
  const ext = mimeType.includes("quicktime") ? "mov"
  : mimeType.includes("webm") ? "webm"
  : "mp4";
  const objectKey = `${cameraId}/${randomUUID()}.${ext}`;

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  await uploadStream(BUCKETS.videos, objectKey, buffer, file.size, mimeType);

  const newVideo = {
    id:         randomUUID(),
                  uploaderId: user.id,
                  cameraId,
                  storageUrl: storageUrl(BUCKETS.videos, objectKey),
                  widthPx,
                  heightPx,
                  fps,
                  uploadDate: new Date(),
                  status:     "pending" as const,
  };

  await db.insert(video).values(newVideo);
  return c.json({ id: newVideo.id, status: "pending", objectKey }, 201);
});



uploadRouter.post("/review-media/upload", requireAuth, photoLimit, async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file") as File;
  if (!file) return c.json({ error: "file required" }, 400);

  const mimeType = file.type || "image/jpeg";
  const ext = mimeType.includes("png") ? "png"
  : mimeType.includes("webp") ? "webp"
  : mimeType.includes("mov") ? "mov"
  : mimeType.includes("webm") ? "webm"
  : mimeType.includes("video") ? "mp4" : "jpg";

  const objectKey = `${randomUUID()}.${ext}`;
  const arrayBuffer = await file.arrayBuffer();
  await uploadStream(BUCKETS.reviewMedia, objectKey, Buffer.from(arrayBuffer), file.size, mimeType);

  return c.json({ objectKey, storageUrl: storageUrl(BUCKETS.reviewMedia, objectKey) }, 201);
});

uploadRouter.post("/device-image/upload", requireRole("moderator"), photoLimit, async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file") as File;
  if (!file) return c.json({ error: "file required" }, 400);

  const mimeType = file.type || "image/jpeg";
  const ext = mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg";
  const objectKey = `${randomUUID()}.${ext}`;
  const arrayBuffer = await file.arrayBuffer();
  await uploadStream(BUCKETS.deviceImages, objectKey, Buffer.from(arrayBuffer), file.size, mimeType);

  return c.json({ objectKey, storageUrl: storageUrl(BUCKETS.deviceImages, objectKey) }, 201);
});

export { uploadRouter };
