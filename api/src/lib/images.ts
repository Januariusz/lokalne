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
// Bezstratne usuwanie metadanych - piksele nie są ponownie kodowane, więc jakość zdjęcia
// się nie zmienia. Dwa tryby:
//  - "camera": z EXIF zostają tylko dane o zdjęciu i aparacie (model, obiektyw, ogniskowa,
//    przysłona, czas, ISO, data); znikają GPS, numery seryjne, właściciel, MakerNote, XMP, IPTC,
//    miniatura w EXIF i dane doklejone za obrazem,
//  - "orientation": zostaje tylko znacznik orientacji (bez niego zdjęcia w pionie byłyby obrócone).
// ════════════════════════════════════════════════════════════════════════════

export type MetadataMode = "camera" | "orientation";

// Dozwolone tagi IFD0: producent, model, orientacja, rozdzielczość, oprogramowanie, data zapisu.
// Odrzucane m.in.: Artist, Copyright, HostComputer, ImageDescription, wskaźnik GPS (0x8825).
const IFD0_KEEP = new Set([0x010f, 0x0110, 0x0112, 0x011a, 0x011b, 0x0128, 0x0131, 0x0132, 0x0213]);
// Dozwolone tagi Exif IFD: parametry ekspozycji, daty i strefy czasowe, ogniskowe, obiektyw.
// Odrzucane m.in.: MakerNote, UserComment, ImageUniqueID, CameraOwnerName, BodySerialNumber,
// LensSerialNumber, wskaźnik Interoperability.
const EXIF_KEEP = new Set([
  0x829a, 0x829d, 0x8822, 0x8827, 0x8830, 0x8832, 0x9000, 0x9003, 0x9004, 0x9010, 0x9011, 0x9012,
  0x9101, 0x9201, 0x9202, 0x9203, 0x9204, 0x9205, 0x9206, 0x9207, 0x9208, 0x9209, 0x920a, 0x9214,
  0x9290, 0x9291, 0x9292, 0xa000, 0xa001, 0xa002, 0xa003, 0xa217, 0xa300, 0xa301, 0xa401, 0xa402,
  0xa403, 0xa404, 0xa405, 0xa406, 0xa407, 0xa408, 0xa409, 0xa40a, 0xa40c, 0xa432, 0xa433, 0xa434, 0xa460,
]);
const EXIF_IFD_POINTER = 0x8769;
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
const MAX_VALUE_BYTES = 4096;

type TiffEntry = { tag: number; type: number; count: number; raw: Buffer };

/**
 * Buduje nowy blok TIFF (EXIF) zawierający tylko dozwolone tagi. Kolejność bajtów jak w oryginale,
 * więc wartości są kopiowane bez przeliczania. Bez IFD1 (miniatura) i bez GPS.
 * Zwraca null, gdy EXIF jest uszkodzony albo nie zostaje w nim nic do zachowania.
 */
export function sanitizeExifTiff(t: Buffer): Buffer | null {
  try {
    const order = t.toString("binary", 0, 2);
    if (order !== "II" && order !== "MM") return null;
    const le = order === "II";
    const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
    const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
    if (u16(2) !== 42) return null;

    const readIfd = (off: number, keep: Set<number>): { entries: TiffEntry[]; exifPtr: number | null } => {
      const entries: TiffEntry[] = [];
      let exifPtr: number | null = null;
      const n = u16(off);
      if (n > 1000) throw new Error("too many entries");
      for (let i = 0; i < n; i++) {
        const e = off + 2 + i * 12;
        const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        if (tag === EXIF_IFD_POINTER) { exifPtr = u32(e + 8); continue; }
        if (!keep.has(tag)) continue;
        const size = (TYPE_SIZE[type] ?? 0) * count;
        if (size === 0 || size > MAX_VALUE_BYTES) continue;
        const at = size <= 4 ? e + 8 : u32(e + 8);
        if (at + size > t.length) continue;
        entries.push({ tag, type, count, raw: Buffer.from(t.subarray(at, at + size)) });
      }
      return { entries, exifPtr };
    };

    const ifd0 = readIfd(u32(4), IFD0_KEEP);
    const exif = ifd0.exifPtr !== null && ifd0.exifPtr < t.length ? readIfd(ifd0.exifPtr, EXIF_KEEP).entries : [];
    if (ifd0.entries.length === 0 && exif.length === 0) return null;

    const w16 = (b: Buffer, o: number, v: number) => (le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o));
    const w32 = (b: Buffer, o: number, v: number) => (le ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o));

    const ifd0Entries = ifd0.entries.length + (exif.length ? 1 : 0);
    const ifd0Size = 2 + ifd0Entries * 12 + 4;
    const exifOff = 8 + ifd0Size;
    const exifSize = exif.length ? 2 + exif.length * 12 + 4 : 0;
    let dataOff = exifOff + exifSize;
    const blocks: Buffer[] = [];

    const writeIfd = (entries: TiffEntry[], extraPointer: number | null): Buffer => {
      const all = [...entries];
      const n = all.length + (extraPointer !== null ? 1 : 0);
      const b = Buffer.alloc(2 + n * 12 + 4);
      w16(b, 0, n);
      const rows: { tag: number; write: (o: number) => void }[] = all.map((en) => ({
        tag: en.tag,
        write: (o) => {
          w16(b, o, en.tag); w16(b, o + 2, en.type); w32(b, o + 4, en.count);
          if (en.raw.length <= 4) en.raw.copy(b, o + 8);
          else {
            w32(b, o + 8, dataOff);
            const padded = en.raw.length % 2 ? Buffer.concat([en.raw, Buffer.alloc(1)]) : en.raw;
            blocks.push(padded);
            dataOff += padded.length;
          }
        },
      }));
      if (extraPointer !== null) {
        rows.push({ tag: EXIF_IFD_POINTER, write: (o) => { w16(b, o, EXIF_IFD_POINTER); w16(b, o + 2, 4); w32(b, o + 4, 1); w32(b, o + 8, extraPointer); } });
      }
      rows.sort((a, c) => a.tag - c.tag).forEach((r, i) => r.write(2 + i * 12));
      w32(b, 2 + n * 12, 0); // brak kolejnego IFD (miniatura IFD1 odpada)
      return b;
    };

    const head = Buffer.alloc(8);
    head.write(order, 0, "binary");
    w16(head, 2, 42);
    w32(head, 4, 8);
    const ifd0Buf = writeIfd(ifd0.entries, exif.length ? exifOff : null);
    const exifBuf = exif.length ? writeIfd(exif, null) : Buffer.alloc(0);
    return Buffer.concat([head, ifd0Buf, exifBuf, ...blocks]);
  } catch {
    return null;
  }
}

/** Minimalny TIFF z samą orientacją. */
function orientationTiff(orientation: number): Buffer {
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
  return tiff;
}

/** Oczyszczony TIFF wg trybu; null = nic nie zostaje. */
function cleanTiff(tiff: Buffer, mode: MetadataMode): Buffer | null {
  if (mode === "camera") {
    const cleaned = sanitizeExifTiff(tiff);
    if (cleaned) return cleaned;
  }
  const o = tiffOrientation(tiff);
  return o !== null && o !== 1 ? orientationTiff(o) : null;
}

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

/** Orientacja (tag 0x0112) z bloku TIFF; null, gdy jej nie ma. */
function tiffOrientation(t: Buffer): number | null {
  if (t.length < 8) return null;
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

/** Segment APP1 "Exif" z podanym blokiem TIFF. */
function exifApp1(tiff: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

/**
 * JPEG: zastępuje EXIF oczyszczoną wersją (tryb), usuwa XMP, APP3-APP13 (m.in. IPTC), APP15, komentarze i APP2 inne niż profil ICC
 * (np. MPF z dodatkowymi obrazami), a także wszystko po znaczniku końca obrazu (EOI), gdzie
 * telefony doklejają podglądy i filmy "motion photo" z własnymi metadanymi.
 * Zostaje: APP0 (JFIF), profil kolorów ICC, APP14 (Adobe), tablice i dane obrazu.
 */
async function stripJpeg(srcPath: string, dstPath: string, mode: MetadataMode): Promise<void> {
  const src = await open(srcPath, "r");
  const dst = await open(dstPath, "w");
  try {
    const size = (await src.stat()).size;
    let pos = 2;
    const kept: Buffer[] = [];
    let exifTiff: Buffer | null = null;
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
      else if (m === 0xe1) {
        if (exifTiff === null && data.toString("binary", 0, 6) === "Exif\0\0") exifTiff = Buffer.from(data.subarray(6));
        keep = false;
      }
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

    // SOI, APP0 (jeśli jest pierwszy), oczyszczony EXIF, reszta zachowanych segmentów, dane obrazu.
    await dst.write(Buffer.from([0xff, 0xd8]));
    let rest = kept;
    if (kept[0] && kept[0][1] === 0xe0) { await dst.write(kept[0]); rest = kept.slice(1); }
    let cleaned = exifTiff ? cleanTiff(exifTiff, mode) : null;
    if (cleaned && cleaned.length > 65000) cleaned = exifTiff ? cleanTiff(exifTiff, "orientation") : null;
    if (cleaned) await dst.write(exifApp1(cleaned));
    for (const seg of rest) await dst.write(seg);
    await copyRange(src, dst, sosPos, end);
  } finally {
    await src.close();
    await dst.close();
  }
}

const PNG_DROP = new Set(["tEXt", "iTXt", "zTXt", "tIME"]);

const CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tbl[n] = c >>> 0;
  }
  return tbl;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** PNG: usuwa tekst i czas (tEXt, iTXt, zTXt, tIME), oczyszcza eXIf (tryb), usuwa dane po IEND. */
async function stripPng(srcPath: string, dstPath: string, mode: MetadataMode): Promise<void> {
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
      if (type === "eXIf") {
        const data = len <= 1024 * 1024 ? await readAt(src, pos + 8, len) : null;
        const cleaned = data ? cleanTiff(data, mode) : null;
        if (cleaned) {
          const typeAndData = Buffer.concat([Buffer.from("eXIf", "ascii"), cleaned]);
          const out = Buffer.alloc(12 + cleaned.length);
          out.writeUInt32BE(cleaned.length, 0);
          typeAndData.copy(out, 4);
          out.writeUInt32BE(crc32(typeAndData), 8 + cleaned.length);
          await dst.write(out);
        }
      } else if (!PNG_DROP.has(type)) await copyRange(src, dst, pos, Math.min(size, pos + total));
      pos += total;
      if (type === "IEND") break;
    }
  } finally {
    await src.close();
    await dst.close();
  }
}

/** WebP: usuwa XMP, oczyszcza EXIF (tryb), poprawia flagi w VP8X i rozmiar RIFF. */
async function stripWebp(srcPath: string, dstPath: string, mode: MetadataMode): Promise<void> {
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
    // Nowy fragment EXIF (albo brak). Niektóre programy zapisują go z prefiksem "Exif\0\0".
    let exifChunk: Buffer | null = null;
    const exifSrc = chunks.find((c) => c.fourcc === "EXIF");
    if (exifSrc && exifSrc.total <= 1024 * 1024 + 9) {
      let tiff = (await readAt(src, exifSrc.pos + 8, exifSrc.total - 8));
      tiff = tiff.subarray(0, (await readAt(src, exifSrc.pos + 4, 4)).readUInt32LE(0));
      if (tiff.toString("binary", 0, 6) === "Exif\0\0") tiff = tiff.subarray(6);
      const cleaned = cleanTiff(Buffer.from(tiff), mode);
      if (cleaned) {
        const pad = cleaned.length % 2;
        exifChunk = Buffer.alloc(8 + cleaned.length + pad);
        exifChunk.write("EXIF", 0, "ascii");
        exifChunk.writeUInt32LE(cleaned.length, 4);
        cleaned.copy(exifChunk, 8);
      }
    }
    const hasVp8x = chunks.some((c) => c.fourcc === "VP8X");
    if (!hasVp8x) exifChunk = null; // prosty WebP bez VP8X nie może mieć EXIF
    const keep = chunks.filter((c) => c.fourcc !== "EXIF" && c.fourcc !== "XMP ");
    const riffSize = 4 + keep.reduce((s, c) => s + c.total, 0) + (exifChunk?.length ?? 0);
    const head = Buffer.alloc(12);
    head.write("RIFF", 0, "ascii");
    head.writeUInt32LE(riffSize, 4);
    head.write("WEBP", 8, "ascii");
    await dst.write(head);
    for (const c of keep) {
      if (c.fourcc === "VP8X") {
        const vp8x = await readAt(src, c.pos, c.total);
        vp8x[8] = (vp8x[8]! & ~0x0c) | (exifChunk ? 0x08 : 0); // flagi EXIF (0x08) i XMP (0x04)
        await dst.write(vp8x);
      } else {
        await copyRange(src, dst, c.pos, Math.min(size, c.pos + c.total));
      }
    }
    if (exifChunk) await dst.write(exifChunk); // EXIF na końcu, zgodnie ze specyfikacją kontenera
  } finally {
    await src.close();
    await dst.close();
  }
}

/**
 * Usuwa metadane z pliku w miejscu (bezstratnie). Domyślnie zostawia dane aparatu ("camera").
 * Zwraca false, gdy format nie jest obsługiwany (GIF nie ma EXIF; HEIC/AVIF zostają bez zmian)
 * albo plik jest uszkodzony - wtedy plik się nie zmienia.
 */
export async function stripMetadataInPlace(path: string, ext: string, mode: MetadataMode = "camera"): Promise<boolean> {
  const fn = ext === "jpg" ? stripJpeg : ext === "png" ? stripPng : ext === "webp" ? stripWebp : null;
  if (!fn) return false;
  const tmp = `${path}.strip`;
  try {
    await fn(path, tmp, mode);
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
