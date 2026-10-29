import { mkdir, rm, rename, copyFile, unlink, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Prosty magazyn plików na dysku (zastępuje MinIO/S3).
 *   STORAGE_DIR/files/<bucket>/<klucz>    – pliki PUBLICZNE, serwowane przez Caddy pod /media/*
 *   STORAGE_DIR/private/<bucket>/<klucz>  – pliki prywatne (niezweryfikowane zdjęcia/wideo, media
 *                                           nieopublikowanych recenzji); Caddy ich nie widzi,
 *                                           API wydaje do nich podpisane, krótkotrwałe linki
 *   STORAGE_DIR/tmp                     – pliki tymczasowe uploadu (ten sam wolumen => atomowy rename)
 * W bazie trzymamy adresy `storage://bucket/klucz` (stare `minio://` nadal są rozpoznawane).
 */
export const STORAGE_DIR = resolve(process.env["STORAGE_DIR"] ?? "./storage");
export const FILES_DIR = join(STORAGE_DIR, "files");
export const PRIVATE_DIR = join(STORAGE_DIR, "private");
export const TMP_DIR = join(STORAGE_DIR, "tmp");

export type Visibility = "public" | "private";

export const BUCKETS = {
  photos:        "photos",
  videos:        "videos",
  reviewMedia:   "review-media",
  deviceImages:  "device-images",
} as const;

export type BucketName = (typeof BUCKETS)[keyof typeof BUCKETS];

const BUCKET_NAMES = Object.values(BUCKETS) as string[];

export async function ensureStorageDirs(): Promise<void> {
  // przy starcie nic jeszcze nie jest wysyłane, więc resztki po awarii można bezpiecznie usunąć
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
  for (const b of BUCKET_NAMES) {
    await mkdir(join(FILES_DIR, b), { recursive: true });
    await mkdir(join(PRIVATE_DIR, b), { recursive: true });
  }
}

export function storageUrl(bucket: BucketName, objectKey: string): string {
  return `storage://${bucket}/${objectKey}`;
}

const PUBLIC_MEDIA_URL = (
  process.env["PUBLIC_MEDIA_URL"] ?? process.env["PUBLIC_MINIO_URL"] ?? "http://localhost/media"
).replace(/\/+$/, "");

export function publicUrl(url: string | null): string | null {
  if (!url) return null;
  const parsed = parseStorageUrl(url);
  if (parsed) return `${PUBLIC_MEDIA_URL}/${parsed.bucket}/${parsed.key}`;
  return url; // zwykłe http(s) bez zmian
}

export function parseStorageUrl(url: string): { bucket: BucketName; key: string } | null {
  const m = /^(?:storage|minio):\/\/([^/]+)\/(.+)$/.exec(url);
  if (!m) return null;
  const bucket = m[1]!;
  const key = m[2]!;
  if (!BUCKET_NAMES.includes(bucket) || !isSafeKey(key)) return null;
  return { bucket: bucket as BucketName, key };
}

function isSafeKey(key: string): boolean {
  if (!key || key.includes("\0") || key.includes("\\") || key.startsWith("/")) return false;
  return key.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** Ścieżka na dysku; rzuca błąd, gdy klucz próbuje wyjść poza katalog bucketa. */
export function filePath(bucket: BucketName, key: string, visibility: Visibility = "public"): string {
  if (!BUCKET_NAMES.includes(bucket) || !isSafeKey(key)) {
    throw new Error(`Unsafe storage path: ${bucket}/${key}`);
  }
  const root = join(visibility === "public" ? FILES_DIR : PRIVATE_DIR, bucket);
  const full = resolve(root, key);
  if (!full.startsWith(root + sep)) throw new Error(`Unsafe storage path: ${bucket}/${key}`);
  return full;
}

async function isFile(p: string): Promise<boolean> {
  try { return (await stat(p)).isFile(); } catch { return false; }
}

/** Gdzie plik faktycznie leży (publiczny ma pierwszeństwo); null, gdy go nie ma. */
export async function locateFile(
  bucket: BucketName, key: string,
): Promise<{ path: string; visibility: Visibility } | null> {
  const pub = filePath(bucket, key, "public");
  if (await isFile(pub)) return { path: pub, visibility: "public" };
  const priv = filePath(bucket, key, "private");
  if (await isFile(priv)) return { path: priv, visibility: "private" };
  return null;
}

/** Przenosi gotowy plik tymczasowy do magazynu (rename; przy EXDEV kopia + usunięcie). */
export async function storeFile(
  bucket: BucketName, key: string, srcPath: string, visibility: Visibility = "public",
): Promise<void> {
  const dest = filePath(bucket, key, visibility);
  await mkdir(dirname(dest), { recursive: true });
  try {
    await rename(srcPath, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await copyFile(srcPath, dest);
    await unlink(srcPath).catch(() => {});
  }
}

// ── Warianty obrazów (miniatury) ──────────────────────────────────────────────
// Leżą obok oryginału, w tym samym katalogu (publicznym albo prywatnym):
//   photos/<cam>/<uuid>.jpg -> photos/<cam>/<uuid>.w480.webp, photos/<cam>/<uuid>.w1280.webp
export const VARIANTS = ["w480", "w1280", "w512"] as const;
export type Variant = (typeof VARIANTS)[number];

export function variantKey(key: string, variant: Variant): string {
  return `${key.replace(/\.[^./]+$/, "")}.${variant}.webp`;
}

/** Przenosi istniejący plik (razem z wariantami) między katalogiem publicznym a prywatnym. */
export async function setVisibility(bucket: BucketName, key: string, visibility: Visibility): Promise<void> {
  const other: Visibility = visibility === "public" ? "private" : "public";
  const dest = filePath(bucket, key, visibility);
  if (!(await isFile(dest))) {
    await mkdir(dirname(dest), { recursive: true });
    await rename(filePath(bucket, key, other), dest); // ENOENT, gdy pliku nie ma w żadnym miejscu
  }
  for (const v of VARIANTS) {
    const vk = variantKey(key, v);
    const src = filePath(bucket, vk, other);
    if (await isFile(src)) await rename(src, filePath(bucket, vk, visibility));
  }
}

/** Trwale usuwa plik i jego warianty (z obu katalogów). Brak pliku nie jest błędem. */
export async function deleteStoredObject(url: string): Promise<void> {
  const parsed = parseStorageUrl(url);
  if (!parsed) return;
  const keys = [parsed.key, ...VARIANTS.map((v) => variantKey(parsed.key, v))];
  for (const k of keys) {
    for (const vis of ["public", "private"] as const) {
      try {
        await unlink(filePath(parsed.bucket, k, vis));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  }
}

/**
 * Adres wariantu (miniatury) do pokazania klientowi albo null, gdy wariantu jeszcze nie ma
 * (stare pliki przed uzupełnieniem, formaty bez miniatur, np. HEIC). Klient używa wtedy oryginału.
 */
export function variantUrl(url: string | null, variant: Variant, isPublic: boolean): string | null {
  if (!url) return null;
  const parsed = parseStorageUrl(url);
  if (!parsed) return null;
  const vk = variantKey(parsed.key, variant);
  let path: string;
  try { path = filePath(parsed.bucket, vk, isPublic ? "public" : "private"); } catch { return null; }
  if (!existsSync(path)) return null;
  const vUrl = storageUrl(parsed.bucket, vk);
  return isPublic ? publicUrl(vUrl) : signedUrl(vUrl);
}

export async function objectExists(bucket: BucketName, key: string): Promise<boolean> {
  return (await locateFile(bucket, key)) !== null;
}

// ── Podpisane linki do plików prywatnych ─────────────────────────────────────
const API_BASE = (process.env["API_BASE_URL"] ?? "http://localhost:3000").replace(/\/+$/, "");
const SIGN_SECRET = process.env["BETTER_AUTH_SECRET"] ?? "dev-only-insecure-secret";
const SIGNED_URL_TTL_S = 60 * 60;

function sign(bucket: string, key: string, exp: number): string {
  return createHmac("sha256", SIGN_SECRET).update(`${bucket}/${key}:${exp}`).digest("hex");
}

export function verifySignature(bucket: string, key: string, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(sign(bucket, key, exp), "hex");
  let given: Buffer;
  try { given = Buffer.from(sig, "hex"); } catch { return false; }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Link do pliku prywatnego, ważny godzinę. Wydawać go tylko po sprawdzeniu uprawnień. */
export function signedUrl(url: string | null): string | null {
  if (!url) return null;
  const parsed = parseStorageUrl(url);
  if (!parsed) return url;
  // Czas wygaśnięcia zaokrąglony do pełnej godziny (link ważny 1-2 h): w tym oknie adres jest
  // stały, więc aplikacje mogą trzymać obraz w cache zamiast pobierać go przy każdym odświeżeniu.
  const nowS = Math.floor(Date.now() / 1000);
  const exp = (Math.floor(nowS / SIGNED_URL_TTL_S) + 2) * SIGNED_URL_TTL_S;
  const path = parsed.key.split("/").map(encodeURIComponent).join("/");
  return `${API_BASE}/api/media/private/${parsed.bucket}/${path}?exp=${exp}&sig=${sign(parsed.bucket, parsed.key, exp)}`;
}

/** Adres do pokazania klientowi: plik publiczny => /media/..., prywatny => podpisany link. */
export function mediaUrl(url: string | null, isPublic: boolean): string | null {
  return isPublic ? publicUrl(url) : signedUrl(url);
}
