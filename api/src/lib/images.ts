import { open, rename, unlink, stat } from "node:fs/promises";
import sharp from "sharp";

// Jedno przetwarzanie naraz i bez cache libvips: kontener API ma 384 MB RAM.
sharp.cache(false);
sharp.concurrency(1);

// ════════════════════════════════════════════════════════════════════════════
// Rozpoznawanie typu pliku po pierwszych bajtach ("magic bytes"), a nie po tym,
// co zadeklarował klient.
// ════════════════════════════════════════════════════════════════════════════

export type SniffedType =
  | { kind: "image"; ext: "jpg" | "png" | "webp" | "gif" | "heic" | "avif"; mime: string }
  | { kind: "video"; ext: "mp4" | "mov" | "webm"; mime: string };

/** Formaty, które sharp potrafi przetworzyć (miniatury, zmniejszanie). HEIC nie jest obsługiwany. */
export const RASTER_EXTS = new Set(["jpg", "png", "webp", "gif", "avif"]);

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);
const MP4_BRANDS = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "M4A ", "dash", "mmp4", "f4v "]);

export async function sniffFile(path: string): Promise<SniffedType | null> {
  const fh = await open(path, "r");
  try {
    const b = Buffer.alloc(32);
    const { bytesRead } = await fh.read(b, 0, 32, 0);
    if (bytesRead < 12) return null;
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: "image", ext: "jpg", mime: "image/jpeg" };
    if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { kind: "image", ext: "png", mime: "image/png" };
    }
    if (b.toString("ascii", 0, 4) === "GIF8") return { kind: "image", ext: "gif", mime: "image/gif" };
    if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
      return { kind: "image", ext: "webp", mime: "image/webp" };
    }
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { kind: "video", ext: "webm", mime: "video/webm" };
    if (b.toString("ascii", 4, 8) === "ftyp") {
      const brand = b.toString("ascii", 8, 12);
      if (HEIC_BRANDS.has(brand)) return { kind: "image", ext: "heic", mime: "image/heic" };
      if (AVIF_BRANDS.has(brand)) return { kind: "image", ext: "avif", mime: "image/avif" };
      if (brand === "qt  ") return { kind: "video", ext: "mov", mime: "video/quicktime" };
      if (MP4_BRANDS.has(brand) || brand.startsWith("3g")) return { kind: "video", ext: "mp4", mime: "video/mp4" };
    }
    return null;
  } finally {
    await fh.close();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Bezstratne usuwanie metadanych (EXIF z GPS, XMP, IPTC) - piksele nie są ponownie kodowane,
// więc jakość zdjęcia i jego rozmiar się nie zmieniają. Dla JPEG zostaje tylko znacznik orientacji
// (bez niego zdjęcia w pionie wyświetlałyby się obrócone).
// ════════════════════════════════════════════════════════════════════════════

const CHUNK = 1024 * 1024;

async function readAt(fh: Awaited<ReturnType<typeof open>>, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

/** Kopiuje zakres [from, to) pliku źródłowego na koniec pliku docelowego, kawałkami. */
async function copyRange(
  src: Awaited<ReturnType<typeof open>>, dst: Awaited<ReturnType<typeof open>>, from: number, to: number,
) {
  let pos = from;
  while (pos < to) {
    const part = await readAt(src, pos, Math.min(CHUNK, to - pos));
    if (part.length === 0) break;
    await dst.write(part);
    pos += part.length;
  }
}

/** Orientacja (tag 0x0112) z segmentu APP1 "Exif\0\0"; null, gdy jej nie ma. */
function exifOrientation(seg: Buffer): number | null {
  if (seg.length < 14 || seg.toString("binary", 0, 6) !== "Exif\0\0") return null;
  const t = seg.subarray(6);
  const le = t.toString("binary", 0, 2) === "II";
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  try {
    const ifd = u32(4);
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (u16(e) === 0x0112) {
        const v = u16(e + 8);
        return v >= 1 && v <= 8 ? v : null;
      }
    }
  } catch { /* uszkodzony EXIF - traktujemy jak brak */ }
  return null;
}

/** Minimalny segment APP1 z samą orientacją (26 bajtów TIFF). */
function orientationApp1(orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write("II", 0, "binary");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);      // IFD0 zaraz za nagłówkiem
  tiff.writeUInt16LE(1, 8);      // 1 wpis
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);     // SHORT
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt32LE(0, 22);     // brak kolejnego IFD
  const body = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

/**
 * JPEG: usuwa APP1 (EXIF/XMP), APP3-APP13 (m.in. IPTC), APP15, komentarze i APP2 inne niż profil ICC
 * (np. MPF z dodatkowymi obrazami), a także wszystko po znaczniku końca obrazu (EOI), gdzie
 * telefony doklejają podglądy i filmy "motion photo" z własnymi metadanymi.
 * Zostaje: APP0 (JFIF), profil kolorów ICC, APP14 (Adobe), tablice i dane obrazu.
 */
async function stripJpeg(srcPath: string, dstPath: string): Promise<void> {
  const src = await open(srcPath, "r");
  const dst = await open(dstPath, "w");
  try {
    const size = (await src.stat()).size;
    let pos = 2;
    const kept: Buffer[] = [];
    let orientation: number | null = null;
    let sosPos = -1;

    while (pos + 4 <= size) {
      const h = await readAt(src, pos, 4);
      if (h[0] !== 0xff) throw new Error("JPEG: expected a marker");
      if (h[1] === 0xff) { pos += 1; continue; }                    // bajty wypełnienia
      const m = h[1]!;
      if (m === 0xda) { sosPos = pos; break; }                      // początek danych obrazu
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { pos += 2; continue; }
      const len = h.readUInt16BE(2);
      const seg = await readAt(src, pos, 2 + len);
      const data = seg.subarray(4);
      let keep: boolean;
      if (m === 0xe0 || m === 0xee) keep = true;                    // JFIF, Adobe
      else if (m === 0xe1) { orientation ??= exifOrientation(data); keep = false; }
      else if (m === 0xe2) keep = data.toString("binary", 0, 12) === "ICC_PROFILE\0";
      else if (m >= 0xe3 && m <= 0xef) keep = false;
      else if (m === 0xfe) keep = false;                            // komentarz
      else keep = true;                                             // DQT, SOF, DHT, DRI...
      if (keep) kept.push(seg);
      pos += 2 + len;
    }
    if (sosPos < 0) throw new Error("JPEG: no image data");

    // Szukamy końca obrazu (EOI): segmenty z długością przeskakujemy, w danych skompresowanych
    // 0xFF jest zawsze zakończone 0x00 albo znacznikiem RSTn.
    let end = size;
    {
      let state = 0;          // 0 dane, 1 po 0xFF, 2 długość (hi), 3 długość (lo)
      let hi = 0;
      let skip = 0;
      let p = sosPos;
      outer: while (p < size) {
        const chunk = await readAt(src, p, Math.min(CHUNK, size - p));
        if (chunk.length === 0) break;
        let i = 0;
        while (i < chunk.length) {
          if (skip > 0) {
            const n = Math.min(skip, chunk.length - i);
            skip -= n; i += n;
            continue;
          }
          const b = chunk[i]!;
          if (state === 0) { if (b === 0xff) state = 1; }
          else if (state === 1) {
            if (b === 0xd9) { end = p + i + 1; break outer; }
            if (b === 0x00 || (b >= 0xd0 && b <= 0xd7)) state = 0;
            else if (b !== 0xff) state = 2;
          } else if (state === 2) { hi = b; state = 3; }
          else { skip = ((hi << 8) | b) - 2; state = 0; }
          i++;
        }
        p += chunk.length;
      }
    }

    // SOI, APP0 (jeśli jest pierwszy), sama orientacja, reszta zachowanych segmentów, dane obrazu.
    await dst.write(Buffer.from([0xff, 0xd8]));
    let rest = kept;
    if (kept[0] && kept[0][1] === 0xe0) { await dst.write(kept[0]); rest = kept.slice(1); }
    if (orientation !== null && orientation !== 1) await dst.write(orientationApp1(orientation));
    for (const seg of rest) await dst.write(seg);
    await copyRange(src, dst, sosPos, end);
  } finally {
    await src.close();
    await dst.close();
  }
}

const PNG_DROP = new Set(["eXIf", "tEXt", "iTXt", "zTXt", "tIME"]);

/** PNG: usuwa fragmenty z metadanymi (eXIf, tEXt, iTXt, zTXt, tIME) i dane po IEND. */
async function stripPng(srcPath: string, dstPath: string): Promise<void> {
  const src = await open(srcPath, "r");
  const dst = await open(dstPath, "w");
  try {
    const size = (await src.stat()).size;
    await dst.write(await readAt(src, 0, 8));
    let pos = 8;
    while (pos + 8 <= size) {
      const h = await readAt(src, pos, 8);
      const len = h.readUInt32BE(0);
      const type = h.toString("ascii", 4, 8);
      const total = 12 + len;
      if (!PNG_DROP.has(type)) await copyRange(src, dst, pos, Math.min(size, pos + total));
      pos += total;
      if (type === "IEND") break;
    }
  } finally {
    await src.close();
    await dst.close();
  }
}

/** WebP: usuwa fragmenty EXIF i XMP, czyści ich flagi w VP8X i poprawia rozmiar RIFF. */
async function stripWebp(srcPath: string, dstPath: string): Promise<void> {
  const src = await open(srcPath, "r");
  const dst = await open(dstPath, "w");
  try {
    const size = (await src.stat()).size;
    const riffEnd = Math.min(size, 8 + (await readAt(src, 4, 4)).readUInt32LE(0));
    const chunks: { pos: number; total: number; fourcc: string }[] = [];
    let pos = 12;
    while (pos + 8 <= riffEnd) {
      const h = await readAt(src, pos, 8);
      const fourcc = h.toString("ascii", 0, 4);
      const len = h.readUInt32LE(4);
      const total = 8 + len + (len % 2);
      chunks.push({ pos, total, fourcc });
      pos += total;
    }
    const keep = chunks.filter((c) => c.fourcc !== "EXIF" && c.fourcc !== "XMP ");
    const riffSize = 4 + keep.reduce((s, c) => s + c.total, 0);
    const head = Buffer.alloc(12);
    head.write("RIFF", 0, "ascii");
    head.writeUInt32LE(riffSize, 4);
    head.write("WEBP", 8, "ascii");
    await dst.write(head);
    for (const c of keep) {
      if (c.fourcc === "VP8X") {
        const vp8x = await readAt(src, c.pos, c.total);
        vp8x[8] = vp8x[8]! & ~0x0c; // flagi EXIF (0x08) i XMP (0x04)
        await dst.write(vp8x);
      } else {
        await copyRange(src, dst, c.pos, Math.min(size, c.pos + c.total));
      }
    }
  } finally {
    await src.close();
    await dst.close();
  }
}

/**
 * Usuwa metadane z pliku w miejscu (bezstratnie). Zwraca false, gdy format nie jest obsługiwany
 * (GIF nie ma EXIF; HEIC/AVIF zostają bez zmian) albo plik jest uszkodzony - wtedy plik się nie zmienia.
 */
export async function stripMetadataInPlace(path: string, ext: string): Promise<boolean> {
  const fn = ext === "jpg" ? stripJpeg : ext === "png" ? stripPng : ext === "webp" ? stripWebp : null;
  if (!fn) return false;
  const tmp = `${path}.strip`;
  try {
    await fn(path, tmp);
    if ((await stat(tmp)).size === 0) throw new Error("empty output");
    await rename(tmp, path);
    return true;
  } catch (err) {
    console.error("[images] metadata strip failed:", err);
    await unlink(tmp).catch(() => {});
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Przetwarzanie obrazów przez sharp - zawsze po jednym naraz (kolejka).
// ════════════════════════════════════════════════════════════════════════════

let queue: Promise<unknown> = Promise.resolve();

/** Uruchamia zadanie na obrazach w kolejce (jedno naraz), żeby nie przekroczyć limitu pamięci. */
export function runImageJob<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job);
  queue = next.catch(() => undefined);
  return next;
}

const INPUT = { sequentialRead: true, failOn: "none" as const, limitInputPixels: 200_000_000 };

/** Miniatura WebP o podanej szerokości (bez powiększania), zapisywana atomowo. */
export async function writeWebpVariant(srcPath: string, destPath: string, width: number, quality: number) {
  const tmp = `${destPath}.tmp`;
  try {
    await sharp(srcPath, INPUT).rotate().resize({ width, withoutEnlargement: true }).webp({ quality }).toFile(tmp);
    await rename(tmp, destPath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Zmniejsza obraz do maksymalnego boku i koduje go ponownie w tym samym formacie
 * (sharp nie przepisuje metadanych, więc EXIF/GPS znikają). GIF-y zostają bez zmian (animacje).
 * Zwraca wymiary wyniku.
 */
export async function downscaleInPlace(path: string, ext: string, maxSide: number): Promise<{ width: number; height: number } | null> {
  if (!["jpg", "png", "webp", "avif"].includes(ext)) return readDimensions(path);
  const tmp = `${path}.resized`;
  try {
    let img = sharp(path, INPUT).rotate().resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true });
    img = ext === "jpg" ? img.jpeg({ quality: 85, mozjpeg: true })
        : ext === "png" ? img.png({ compressionLevel: 9 })
        : ext === "webp" ? img.webp({ quality: 85 })
        : img.avif({ quality: 60 });
    const info = await img.toFile(tmp);
    await rename(tmp, path);
    return { width: info.width, height: info.height };
  } catch (err) {
    console.error("[images] downscale failed:", err);
    await unlink(tmp).catch(() => {});
    return readDimensions(path);
  }
}

/** Wymiary obrazu z uwzględnieniem orientacji; null, gdy sharp nie umie go odczytać (np. HEIC). */
export async function readDimensions(path: string): Promise<{ width: number; height: number } | null> {
  try {
    const m = await sharp(path, INPUT).metadata();
    if (!m.width || !m.height) return null;
    const rotated = (m.orientation ?? 1) >= 5;
    return rotated ? { width: m.height, height: m.width } : { width: m.width, height: m.height };
  } catch {
    return null;
  }
}
