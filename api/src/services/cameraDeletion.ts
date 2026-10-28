import { inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { camera, photo, video } from "../db/schema.js";
import { deleteStoredObject } from "../lib/storage.js";

/**
 * Usuwa aparaty razem z ich zdjęciami i filmami.
 * Zdjęcia i filmy mają klucz obcy do aparatu z ON DELETE RESTRICT, więc trzeba je usunąć najpierw;
 * tryby wideo (camera_video_mode) znikają kaskadowo razem z aparatem.
 * Wiersze są usuwane w jednej transakcji, a pliki z dysku dopiero po niej
 * (błąd sprzątania plików nie cofa usunięcia z bazy).
 */
export async function deleteCamerasWithMedia(cameraIds: string[]) {
  if (cameraIds.length === 0) return { cameras: 0, photos: 0, videos: 0 };

  const files: string[] = [];
  const counts = db.transaction((tx) => {
    const photos = tx.select({ storageUrl: photo.storageUrl }).from(photo)
      .where(inArray(photo.cameraId, cameraIds)).all();
    const videos = tx.select({ storageUrl: video.storageUrl }).from(video)
      .where(inArray(video.cameraId, cameraIds)).all();
    for (const m of [...photos, ...videos]) files.push(m.storageUrl);

    tx.delete(photo).where(inArray(photo.cameraId, cameraIds)).run();
    tx.delete(video).where(inArray(video.cameraId, cameraIds)).run();
    const removed = tx.delete(camera).where(inArray(camera.id, cameraIds)).run();
    return { cameras: removed.changes, photos: photos.length, videos: videos.length };
  });

  const results = await Promise.allSettled(files.map((u) => deleteStoredObject(u)));
  for (const r of results) {
    if (r.status === "rejected") console.error("[camera-delete] storage cleanup failed:", r.reason);
  }
  return counts;
}
