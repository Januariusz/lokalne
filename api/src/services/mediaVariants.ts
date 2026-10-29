import { existsSync } from "node:fs";
import { ne, eq, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { photo, reviewMedia, smartphone } from "../db/schema.js";
import {
  BUCKETS, filePath, locateFile, parseStorageUrl, variantKey, type BucketName, type Variant,
} from "../lib/storage.js";
import { RASTER_EXTS, runImageJob, writeWebpVariant } from "../lib/images.js";

type Spec = { variant: Variant; width: number; quality: number };

/** Jakie miniatury powstają dla danego rodzaju pliku. */
export const VARIANT_SPECS: Record<"photo" | "review" | "device", Spec[]> = {
  photo:  [{ variant: "w480", width: 480, quality: 75 }, { variant: "w1280", width: 1280, quality: 80 }],
  review: [{ variant: "w480", width: 480, quality: 75 }],
  device: [{ variant: "w512", width: 512, quality: 80 }],
};

function extOf(key: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(key);
  return m ? m[1]!.toLowerCase() : "";
}

/**
 * Tworzy brakujące miniatury pliku (w kolejce, jedno przetwarzanie naraz), w tym samym katalogu
 * co oryginał (publicznym albo prywatnym). Zwraca liczbę utworzonych plików.
 * Formaty, których sharp nie obsługuje (HEIC) i filmy są pomijane - klient dostaje wtedy null.
 */
export async function ensureVariants(bucket: BucketName, key: string, kind: keyof typeof VARIANT_SPECS): Promise<number> {
  if (!RASTER_EXTS.has(extOf(key))) return 0;
  return runImageJob(async () => {
    const loc = await locateFile(bucket, key);
    if (!loc) return 0;
    let made = 0;
    for (const s of VARIANT_SPECS[kind]) {
      const dest = filePath(bucket, variantKey(key, s.variant), loc.visibility);
      if (existsSync(dest)) continue;
      try {
        await writeWebpVariant(loc.path, dest, s.width, s.quality);
        made++;
      } catch (err) {
        console.error(`[variants] ${bucket}/${key} ${s.variant} failed:`, (err as Error).message);
      }
    }
    return made;
  });
}

/**
 * Jednorazowe uzupełnienie miniatur dla plików sprzed tej wersji. Startuje w tle po uruchomieniu
 * serwera, przetwarza pliki po kolei i pomija te, które już mają miniatury (można je bezpiecznie
 * powtarzać przy każdym starcie).
 */
export function startVariantBackfill(delayMs = 15_000): void {
  setTimeout(async () => {
    try {
      const jobs: { bucket: BucketName; key: string; kind: keyof typeof VARIANT_SPECS }[] = [];
      const add = (url: string | null, kind: keyof typeof VARIANT_SPECS) => {
        const p = url ? parseStorageUrl(url) : null;
        if (p) jobs.push({ bucket: p.bucket, key: p.key, kind });
      };
      for (const r of await db.select({ u: photo.storageUrl }).from(photo).where(ne(photo.status, "deleted"))) add(r.u, "photo");
      for (const r of await db.select({ u: reviewMedia.storageUrl }).from(reviewMedia).where(eq(reviewMedia.type, "photo"))) add(r.u, "review");
      for (const r of await db.select({ u: smartphone.imageUrl }).from(smartphone).where(isNotNull(smartphone.imageUrl))) {
        if (r.u && parseStorageUrl(r.u)?.bucket === BUCKETS.deviceImages) add(r.u, "device");
      }
      let made = 0;
      for (const j of jobs) made += await ensureVariants(j.bucket, j.key, j.kind);
      if (made > 0) console.log(`[variants] backfill: ${made} thumbnails created for ${jobs.length} files`);
    } catch (err) {
      console.error("[variants] backfill failed:", err);
    }
  }, delayMs).unref();
}
