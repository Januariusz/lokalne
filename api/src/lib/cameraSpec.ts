import { and, eq, ne } from "drizzle-orm";
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
  afZones: number;
  ois: (typeof OIS_TYPES)[number];
  variableAperture: boolean;
  apertureNarrow: number | null;
  opticalZoom: boolean;
  focalLengthMaxMm: number | null;
};

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

  const afRaw = input["afZones"] ?? 0;
  const afZones = num(afRaw);
  if (afZones === null || !Number.isInteger(afZones) || afZones < 0 || afZones > 100000) {
    return bad("afZones", "afZones must be an integer between 0 and 100000");
  }

  const ois = input["ois"] ?? "none";
  if (typeof ois !== "string" || !(OIS_TYPES as readonly string[]).includes(ois)) {
    return bad("ois", `ois must be one of: ${OIS_TYPES.join(", ")}`);
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
    if (f === null || f < 1 || f > 1000) return bad("videoModes.fpsMax", "fpsMax must be a number between 1 and 1000");
    const note = o["note"];
    if (note !== undefined && note !== null && (typeof note !== "string" || note.length > 128)) {
      return bad("videoModes.note", "note must be a string of at most 128 characters");
    }
    data.push({ widthPx: w, heightPx: h, fpsMax: f, note: (note as string | null | undefined) ?? null });
  }
  return { ok: true, data };
}

const MIN_SAMPLE_VALUES = 2;

/**
 * Aparat ze zmienną przysłoną / zoomem optycznym wymaga zdjęć wykonanych przy co najmniej
 * dwóch różnych wartościach (przysłona i/lub ogniskowa z EXIF). Liczą się zdjęcia niepodlegające usunięciu.
 */
export async function sampleCoverage(
  cameraId: string, flags: { variableAperture: boolean; opticalZoom: boolean },
) {
  const rows = await db.select({ a: photo.exifAperture, f: photo.exifFocalLength })
    .from(photo).where(and(eq(photo.cameraId, cameraId), ne(photo.status, "deleted")));
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
