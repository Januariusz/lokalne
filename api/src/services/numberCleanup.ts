import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { camera, cameraVideoMode, photo } from "../db/schema.js";
import { tidyNullable } from "../lib/numbers.js";

const CAMERA_COLS = [
  "focalLengthMm", "aperture", "cropFactor", "pixelPitchUm", "resolutionMp", "activeResolutionMp",
  "apertureNarrow", "focalLengthMaxMm", "sensorDenominator",
] as const;
const PHOTO_COLS = ["exifFocalLength", "exifAperture", "exifShutterSpeed"] as const;

/** Zmienione pola wiersza (tylko te, w których zaokrąglenie coś zmienia). */
function changes<K extends string>(row: Record<K, number | null>, cols: readonly K[]): Partial<Record<K, number | null>> {
  const out: Partial<Record<K, number | null>> = {};
  for (const k of cols) {
    const t = tidyNullable(row[k]);
    if (t !== row[k]) out[k] = t;
  }
  return out;
}

/**
 * Czyści szum float32 w liczbach zapisanych wcześniej (aparaty, tryby wideo, EXIF zdjęć).
 * Bezpieczne przy każdym starcie: wiersze już czyste są pomijane. Zwraca liczbę poprawionych wierszy.
 */
export function tidyStoredNumbers(): number {
  return db.transaction((tx) => {
    let n = 0;
    // zaokrąglenie nigdy nie zamienia liczby na null, więc pola NOT NULL zostają liczbami
    for (const r of tx.select().from(camera).all()) {
      const ch = changes(r, CAMERA_COLS);
      if (Object.keys(ch).length) { tx.update(camera).set(ch as Partial<typeof camera.$inferInsert>).where(eq(camera.id, r.id)).run(); n++; }
    }
    for (const r of tx.select({ id: cameraVideoMode.id, fpsMax: cameraVideoMode.fpsMax }).from(cameraVideoMode).all()) {
      const ch = changes(r, ["fpsMax"] as const);
      if (ch.fpsMax !== undefined) { tx.update(cameraVideoMode).set({ fpsMax: ch.fpsMax! }).where(eq(cameraVideoMode.id, r.id)).run(); n++; }
    }
    for (const r of tx.select({ id: photo.id, exifFocalLength: photo.exifFocalLength, exifAperture: photo.exifAperture, exifShutterSpeed: photo.exifShutterSpeed }).from(photo).all()) {
      const ch = changes(r, PHOTO_COLS);
      if (Object.keys(ch).length) { tx.update(photo).set(ch).where(eq(photo.id, r.id)).run(); n++; }
    }
    return n;
  });
}
