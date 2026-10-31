import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { photo } from "../db/schema.js";

export const CAMERA_TYPES = ["wide", "ultrawide", "tele", "macro", "other"] as const;
export const FACINGS      = ["back", "front", "other"] as const;
export const OIS_TYPES    = ["none", "optical", "sensor_shift"] as const;

export type CameraSpec = {
  type: (typeof CAMERA_TYPES)[number];
  facing: (typeof FACINGS)[number];
  focalLengthMm: number;
  aperture: number;
  cropFactor: number;
  pixelPitchUm: number;
  resolutionMp: number;
  activeResolutionMp: number;
  afZones: number | null;
  ois: (typeof OIS_TYPES)[number] | null;
  variableAperture: boolean;
  apertureNarrow: number | null;
  opticalZoom: boolean;
  focalLengthMaxMm: number | null;
  sensorFormat: string | null;
  sensorDenominator: number | null;
  photoWidthPx: number | null;
  photoHeightPx: number | null;
  aspectRatio: string | null;
  note: string | null;
};

// Rozmiar matrycy bez znaku cala: "1/1.28", "1/2.55", "1" albo "1.5".
const SENSOR_FORMAT_RE = /^(1\/\d+(\.\d+)?|\d+(\.\d+)?)$/;
// Proporcje matrycy: "4:3", "3:2", "1:1", "16:9" (dopuszczalne też części dziesiętne, np. "1.91:1").
const ASPECT_RATIO_RE = /^\d+(\.\d+)?:\d+(\.\d+)?$/;
const NOTE_MAX = 500;
const PHOTO_PX_MAX = 30000;

/**
 * Mianownik rozmiaru matrycy do porównań liczbowych: "1/1.28" -> 1.28, "1" -> 1, "1.5" -> 0.6667.
 * Większa wartość = mniejsza matryca. null, gdy format jest pusty albo niepoprawny.
 */
export function sensorDenominatorOf(format: string | null | undefined): number | null {
  if (!format || !SENSOR_FORMAT_RE.test(format)) return null;
  const v = format.startsWith("1/") ? Number(format.slice(2)) : 1 / Number(format);
  return Number.isFinite(v) && v > 0 ? Math.round(v * 10000) / 10000 : null;
}

/** Pole tekstowe opcjonalne: brak / null / "" => null; inaczej string po trim(). */
function optText(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false };
  const t = v.trim();
  return { ok: true, value: t === "" ? null : t };
}

export type VideoModeInput = { widthPx: number; heightPx: number; fpsMax: number; note: string | null };

export type Invalid = { ok: false; field: string; message: string };

const RANGES = {
  focalLengthMm:      [0.5, 100],
  aperture:           [0.5, 32],
  cropFactor:         [1, 20],
  pixelPitchUm:       [0.1, 10],
  resolutionMp:       [0.1, 500],
  activeResolutionMp: [0.1, 500],
} as const;

const bad = (field: string, message: string): Invalid => ({ ok: false, field, message });

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Waliduje KOMPLETNĄ specyfikację aparatu (przy edycji: istniejące wartości scalone ze zmianami). */
export function validateCameraSpec(input: Record<string, unknown>): { ok: true; data: CameraSpec } | Invalid {
  const type = input["type"];
  if (typeof type !== "string" || !(CAMERA_TYPES as readonly string[]).includes(type)) {
    return bad("type", `type must be one of: ${CAMERA_TYPES.join(", ")}`);
  }
  const facing = input["facing"];
  if (typeof facing !== "string" || !(FACINGS as readonly string[]).includes(facing)) {
    return bad("facing", `facing must be one of: ${FACINGS.join(", ")}`);
  }

  const out: Record<string, number> = {};
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    const n = num(input[key]);
    if (n === null || n < min || n > max) return bad(key, `${key} must be a number between ${min} and ${max}`);
    out[key] = n;
  }
  if (out["activeResolutionMp"]! > out["resolutionMp"]!) {
    return bad("activeResolutionMp", "activeResolutionMp cannot exceed resolutionMp");
  }

  // afZones i ois: brak albo null = nieznane (0 / "none" znaczą "na pewno brak").
  const afRaw = input["afZones"] ?? null;
  const afZones = afRaw === null ? null : num(afRaw);
  if (afRaw !== null && (afZones === null || !Number.isInteger(afZones) || afZones < 0 || afZones > 100000)) {
    return bad("afZones", "afZones must be null or an integer between 0 and 100000");
  }

  const ois = input["ois"] ?? null;
  if (ois !== null && (typeof ois !== "string" || !(OIS_TYPES as readonly string[]).includes(ois))) {
    return bad("ois", `ois must be null or one of: ${OIS_TYPES.join(", ")}`);
  }

  const variableAperture = input["variableAperture"] ?? false;
  const opticalZoom = input["opticalZoom"] ?? false;
  if (typeof variableAperture !== "boolean") return bad("variableAperture", "variableAperture must be a boolean");
  if (typeof opticalZoom !== "boolean") return bad("opticalZoom", "opticalZoom must be a boolean");

  let apertureNarrow: number | null = null;
  if (variableAperture) {
    apertureNarrow = num(input["apertureNarrow"]);
    if (apertureNarrow === null || apertureNarrow <= out["aperture"]! || apertureNarrow > 64) {
      return bad("apertureNarrow", "apertureNarrow must be a number greater than aperture (max 64)");
    }
  }
  let focalLengthMaxMm: number | null = null;
  if (opticalZoom) {
    focalLengthMaxMm = num(input["focalLengthMaxMm"]);
    if (focalLengthMaxMm === null || focalLengthMaxMm <= out["focalLengthMm"]! || focalLengthMaxMm > 1000) {
      return bad("focalLengthMaxMm", "focalLengthMaxMm must be a number greater than focalLengthMm (max 1000)");
    }
  }

  // ── pola dodatkowe (opcjonalne) ──
  const sf = optText(input["sensorFormat"]);
  if (!sf.ok || (sf.value !== null && (sf.value.length > 16 || !SENSOR_FORMAT_RE.test(sf.value)))) {
    return bad("sensorFormat", 'sensorFormat must look like "1/1.28" or "1" (no inch sign)');
  }
  if (sf.value !== null && Number(sf.value.split("/").pop()) <= 0) {
    return bad("sensorFormat", "sensorFormat must be greater than 0");
  }

  const px = (key: "photoWidthPx" | "photoHeightPx"): number | null | Invalid => {
    const v = input[key];
    if (v === undefined || v === null) return null;
    const n = num(v);
    if (n === null || !Number.isInteger(n) || n < 1 || n > PHOTO_PX_MAX) {
      return bad(key, `${key} must be an integer between 1 and ${PHOTO_PX_MAX}`);
    }
    return n;
  };
  let photoWidthPx = px("photoWidthPx");
  if (photoWidthPx !== null && typeof photoWidthPx === "object") return photoWidthPx;
  let photoHeightPx = px("photoHeightPx");
  if (photoHeightPx !== null && typeof photoHeightPx === "object") return photoHeightPx;
  // Dłuższy bok zawsze jako szerokość: zdjęcie w pionie (np. 3000x4000) zamieniamy na 4000x3000.
  if (photoWidthPx !== null && photoHeightPx !== null && photoHeightPx > photoWidthPx) {
    [photoWidthPx, photoHeightPx] = [photoHeightPx, photoWidthPx];
  }

  const ar = optText(input["aspectRatio"]);
  if (!ar.ok || (ar.value !== null && (ar.value.length > 16 || !ASPECT_RATIO_RE.test(ar.value)))) {
    return bad("aspectRatio", 'aspectRatio must look like "4:3", "3:2" or "1:1"');
  }
  if (ar.value !== null && ar.value.split(":").some((p) => Number(p) <= 0)) {
    return bad("aspectRatio", "aspectRatio parts must be greater than 0");
  }

  const nt = optText(input["note"]);
  if (!nt.ok || (nt.value !== null && nt.value.length > NOTE_MAX)) {
    return bad("note", `note must be a string of at most ${NOTE_MAX} characters`);
  }

  return {
    ok: true,
    data: {
      type: type as CameraSpec["type"],
      facing: facing as CameraSpec["facing"],
      focalLengthMm: out["focalLengthMm"]!,
      aperture: out["aperture"]!,
      cropFactor: out["cropFactor"]!,
      pixelPitchUm: out["pixelPitchUm"]!,
      resolutionMp: out["resolutionMp"]!,
      activeResolutionMp: out["activeResolutionMp"]!,
      afZones,
      ois: ois as CameraSpec["ois"],
      variableAperture,
      apertureNarrow,
      opticalZoom,
      focalLengthMaxMm,
      sensorFormat: sf.value,
      sensorDenominator: sensorDenominatorOf(sf.value),
      photoWidthPx,
      photoHeightPx,
      aspectRatio: ar.value,
      note: nt.value,
    },
  };
}

export function validateVideoModes(input: unknown): { ok: true; data: VideoModeInput[] } | Invalid {
  if (input === undefined || input === null) return { ok: true, data: [] };
  if (!Array.isArray(input) || input.length > 30) return bad("videoModes", "videoModes must be an array of at most 30 items");
  const data: VideoModeInput[] = [];
  for (const m of input) {
    const o = (m ?? {}) as Record<string, unknown>;
    const w = num(o["widthPx"]), h = num(o["heightPx"]), f = num(o["fpsMax"]);
    if (w === null || !Number.isInteger(w) || w < 1 || w > 16384) return bad("videoModes.widthPx", "widthPx must be an integer between 1 and 16384");
    if (h === null || !Number.isInteger(h) || h < 1 || h > 16384) return bad("videoModes.heightPx", "heightPx must be an integer between 1 and 16384");
    if (f === null || f < 1 || f > 10000) return bad("videoModes.fpsMax", "fpsMax must be a number between 1 and 10000");
    const note = o["note"];
    if (note !== undefined && note !== null && (typeof note !== "string" || note.length > 128)) {
      return bad("videoModes.note", "note must be a string of at most 128 characters");
    }
    data.push({ widthPx: w, heightPx: h, fpsMax: f, note: (note as string | null | undefined) ?? null });
  }
  return { ok: true, data };
}

const MIN_SAMPLE_VALUES = 2;

type SampleRow = { a: number | null; f: number | null };

function coverageOf(rows: SampleRow[], flags: { variableAperture: boolean; opticalZoom: boolean }) {
  const apertureValues = new Set(rows.filter(r => r.a !== null).map(r => Math.round(r.a! * 100)));
  const focalLengthValues = new Set(rows.filter(r => r.f !== null).map(r => Math.round(r.f! * 10)));
  const satisfied =
    (!flags.variableAperture || apertureValues.size >= MIN_SAMPLE_VALUES) &&
    (!flags.opticalZoom || focalLengthValues.size >= MIN_SAMPLE_VALUES);
  return {
    required: MIN_SAMPLE_VALUES,
    needsApertureSamples: flags.variableAperture,
    needsZoomSamples: flags.opticalZoom,
    apertureValues: apertureValues.size,
    focalLengthValues: focalLengthValues.size,
    satisfied,
  };
}

/** Pokrycie próbkami dla wielu aparatów jednym zapytaniem (listy /mine, /pending). */
export async function sampleCoverageMany<T extends { id: string; variableAperture: boolean; opticalZoom: boolean }>(cams: T[]) {
  const byCam = new Map<string, SampleRow[]>();
  if (cams.length > 0) {
    const rows = await db.select({ cameraId: photo.cameraId, a: photo.exifAperture, f: photo.exifFocalLength })
      .from(photo).where(and(inArray(photo.cameraId, cams.map((c) => c.id)), ne(photo.status, "deleted")));
    for (const r of rows) byCam.set(r.cameraId, [...(byCam.get(r.cameraId) ?? []), r]);
  }
  return new Map(cams.map((c) => [c.id, coverageOf(byCam.get(c.id) ?? [], c)]));
}

/**
 * Aparat ze zmienną przysłoną / zoomem optycznym wymaga zdjęć wykonanych przy co najmniej
 * dwóch różnych wartościach (przysłona i/lub ogniskowa z EXIF). Liczą się zdjęcia niepodlegające usunięciu.
 */
export async function sampleCoverage(
  cameraId: string, flags: { variableAperture: boolean; opticalZoom: boolean },
) {
  const rows = await db.select({ a: photo.exifAperture, f: photo.exifFocalLength })
    .from(photo).where(and(eq(photo.cameraId, cameraId), ne(photo.status, "deleted")));
  return coverageOf(rows, flags);
}
