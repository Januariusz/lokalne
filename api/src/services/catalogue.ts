import { and, asc, desc, eq, exists, gte, inArray, like, lte, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { brand, camera, smartphone, smartphoneBuildModel } from "../db/schema.js";
import { publicUrl, variantUrl } from "../lib/storage.js";

export const CAMERA_TYPES = ["wide", "ultrawide", "tele", "macro", "other"] as const;
export const FACINGS      = ["back", "front", "other"] as const;
export const OIS_TYPES    = ["none", "optical", "sensor_shift"] as const;
export const SORTS        = ["name", "trending", "new"] as const;
const DATE_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

const MAX_BRANDS  = 20;
const MAX_CAMERAS = 10;
const MAX_LIMIT   = 50;

/** Warunki dla JEDNEGO aparatu telefonu (wszystkie muszą być spełnione przez ten sam aparat). */
export type CameraFilter = {
  type?: (typeof CAMERA_TYPES)[number];
  facing?: (typeof FACINGS)[number];
  ois?: (typeof OIS_TYPES)[number][];
  eqFocalMin?: number;
  eqFocalMax?: number;
  eqApertureMin?: number;
  eqApertureMax?: number;
  resolutionMin?: number;
  sensorDenominatorMin?: number;
  sensorDenominatorMax?: number;
  variableAperture?: boolean;
  opticalZoom?: boolean;
};

export type CatalogueQuery = {
  q: string;
  brandIds: string[];
  sort: (typeof SORTS)[number];
  verified?: boolean;
  releaseFrom?: string;
  releaseTo?: string;
  page: number;
  limit: number;
  /** Każdy element to osobny aparat; telefon musi mieć aparat spełniający KAŻDY z nich (AND). */
  cameras: CameraFilter[];
};

export type ParseError = { code: string; message: string; field?: string };
type Parsed<T> = { ok: true; value: T } | { ok: false; error: ParseError };

const bad = (code: string, message: string, field?: string): { ok: false; error: ParseError } =>
  ({ ok: false, error: { code, message, field } });

function isOneOf<T extends string>(v: unknown, allowed: readonly T[]): v is T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v);
}

// ── walidacja pojedynczego filtra aparatu (wspólna dla GET i POST /search) ────────────────────────
const NUM_KEYS = [
  "eqFocalMin", "eqFocalMax", "eqApertureMin", "eqApertureMax",
  "resolutionMin", "sensorDenominatorMin", "sensorDenominatorMax",
] as const;

function parseCameraFilter(raw: Record<string, unknown>, fieldPrefix: string): Parsed<CameraFilter> {
  const f: CameraFilter = {};
  if (raw["type"] !== undefined && raw["type"] !== null && raw["type"] !== "") {
    if (!isOneOf(raw["type"], CAMERA_TYPES)) return bad("INVALID_FILTER", `type must be one of: ${CAMERA_TYPES.join(", ")}`, `${fieldPrefix}type`);
    f.type = raw["type"];
  }
  if (raw["facing"] !== undefined && raw["facing"] !== null && raw["facing"] !== "") {
    if (!isOneOf(raw["facing"], FACINGS)) return bad("INVALID_FILTER", `facing must be one of: ${FACINGS.join(", ")}`, `${fieldPrefix}facing`);
    f.facing = raw["facing"];
  }
  if (raw["ois"] !== undefined && raw["ois"] !== null) {
    const list = Array.isArray(raw["ois"]) ? raw["ois"] : [raw["ois"]];
    if (list.length > 0) {
      if (!list.every((o) => isOneOf(o, OIS_TYPES))) {
        return bad("INVALID_FILTER", `ois must be a list of: ${OIS_TYPES.join(", ")}`, `${fieldPrefix}ois`);
      }
      f.ois = [...new Set(list)] as CameraFilter["ois"];
    }
  }
  for (const k of NUM_KEYS) {
    const v = raw[k];
    if (v === undefined || v === null || v === "") continue;
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (!Number.isFinite(n)) return bad("INVALID_FILTER", `${k} must be a number`, `${fieldPrefix}${k}`);
    f[k] = n;
  }
  for (const k of ["variableAperture", "opticalZoom"] as const) {
    const v = raw[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== "boolean") return bad("INVALID_FILTER", `${k} must be a boolean`, `${fieldPrefix}${k}`);
    if (v) f[k] = true; // false = brak filtra
  }
  return { ok: true, value: f };
}

const hasConditions = (f: CameraFilter) => Object.keys(f).length > 0;

function parsePaging(pageRaw: unknown, limitRaw: unknown): { page: number; limit: number } {
  const p = Number(pageRaw ?? 1), l = Number(limitRaw ?? 20);
  return {
    page:  Number.isFinite(p) ? Math.max(1, Math.floor(p)) : 1,
    limit: Number.isFinite(l) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(l))) : 20,
  };
}

function validateCommon(q: CatalogueQuery): Parsed<CatalogueQuery> {
  if (q.brandIds.length > MAX_BRANDS) return bad("INVALID_FILTER", `At most ${MAX_BRANDS} brands`, "brand_id");
  if (q.cameras.length > MAX_CAMERAS) return bad("INVALID_FILTER", `At most ${MAX_CAMERAS} camera filters`, "cameras");
  for (const [name, v] of [["release_from", q.releaseFrom], ["release_to", q.releaseTo]] as const) {
    if (v && !DATE_RE.test(v)) return bad("INVALID_FILTER", `${name} must look like YYYY, YYYY-MM or YYYY-MM-DD`, name);
  }
  return { ok: true, value: q };
}

/** Parametry z adresu GET /api/smartphones (stare nazwy zostają, listy po przecinku albo powtórzone). */
export function parseCatalogueQuery(
  query: (name: string) => string | undefined,
  queries: (name: string) => string[] | undefined,
): Parsed<CatalogueQuery> {
  const list = (name: string) =>
    (queries(name) ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);

  const sortRaw = query("sort");
  const sort = sortRaw === undefined || sortRaw === "" ? "name" : sortRaw;
  if (!isOneOf(sort, SORTS)) return bad("INVALID_SORT", `sort must be one of: ${SORTS.join(", ")}`, "sort");

  const verifiedRaw = query("verified") || undefined;
  if (verifiedRaw !== undefined && verifiedRaw !== "true" && verifiedRaw !== "false") {
    return bad("INVALID_FILTER", "verified must be true or false", "verified");
  }

  const cam = parseCameraFilter({
    type: query("camera_type"),
    facing: query("facing"),
    ois: list("ois"),
    eqFocalMin: query("eq_focal_min"),
    eqFocalMax: query("eq_focal_max"),
    eqApertureMin: query("eq_aperture_min"),
    eqApertureMax: query("eq_aperture_max"),
    resolutionMin: query("resolution_min"),
    sensorDenominatorMin: query("sensor_den_min"),
    sensorDenominatorMax: query("sensor_den_max"),
    variableAperture: query("variable_aperture") === "true" ? true : undefined,
    opticalZoom: query("optical_zoom") === "true" ? true : undefined,
  }, "");
  if (!cam.ok) {
    // w adresie pola mają nazwy z podkreśleniami
    const map: Record<string, string> = {
      type: "camera_type", eqFocalMin: "eq_focal_min", eqFocalMax: "eq_focal_max",
      eqApertureMin: "eq_aperture_min", eqApertureMax: "eq_aperture_max", resolutionMin: "resolution_min",
      sensorDenominatorMin: "sensor_den_min", sensorDenominatorMax: "sensor_den_max",
    };
    const field = cam.error.field ?? "";
    return bad(cam.error.code, cam.error.message.replace(field, map[field] ?? field), map[field] ?? field);
  }

  return validateCommon({
    q: (query("q") ?? "").trim(),
    brandIds: [...new Set(list("brand_id"))],
    sort,
    verified: verifiedRaw === undefined ? undefined : verifiedRaw === "true",
    releaseFrom: query("release_from") || undefined,
    releaseTo: query("release_to") || undefined,
    ...parsePaging(query("page"), query("limit")),
    cameras: hasConditions(cam.value) ? [cam.value] : [],
  });
}

/** Treść POST /api/smartphones/search. */
export function parseCatalogueBody(body: unknown): Parsed<CatalogueQuery> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("INVALID_BODY", "Request body must be a JSON object");
  const b = body as Record<string, unknown>;

  const sort = b["sort"] === undefined || b["sort"] === null || b["sort"] === "" ? "name" : b["sort"];
  if (!isOneOf(sort, SORTS)) return bad("INVALID_SORT", `sort must be one of: ${SORTS.join(", ")}`, "sort");

  if (b["q"] !== undefined && b["q"] !== null && typeof b["q"] !== "string") return bad("INVALID_FILTER", "q must be a string", "q");
  if (b["verified"] !== undefined && b["verified"] !== null && typeof b["verified"] !== "boolean") {
    return bad("INVALID_FILTER", "verified must be a boolean", "verified");
  }
  const brandIds = b["brandIds"] ?? [];
  if (!Array.isArray(brandIds) || !brandIds.every((x) => typeof x === "string")) {
    return bad("INVALID_FILTER", "brandIds must be a list of strings", "brandIds");
  }
  const camsRaw = b["cameras"] ?? [];
  if (!Array.isArray(camsRaw)) return bad("INVALID_FILTER", "cameras must be a list", "cameras");
  const cameras: CameraFilter[] = [];
  for (let i = 0; i < camsRaw.length; i++) {
    const item = camsRaw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) return bad("INVALID_FILTER", "Each camera filter must be an object", `cameras[${i}]`);
    const parsed = parseCameraFilter(item as Record<string, unknown>, `cameras[${i}].`);
    if (!parsed.ok) return parsed;
    if (hasConditions(parsed.value)) cameras.push(parsed.value);
  }
  for (const k of ["releaseFrom", "releaseTo"] as const) {
    if (b[k] !== undefined && b[k] !== null && typeof b[k] !== "string") return bad("INVALID_FILTER", `${k} must be a string`, k);
  }

  return validateCommon({
    q: typeof b["q"] === "string" ? b["q"].trim() : "",
    brandIds: [...new Set(brandIds as string[])].filter(Boolean),
    sort,
    verified: typeof b["verified"] === "boolean" ? b["verified"] : undefined,
    releaseFrom: (b["releaseFrom"] as string | undefined) || undefined,
    releaseTo: (b["releaseTo"] as string | undefined) || undefined,
    ...parsePaging(b["page"], b["limit"]),
    cameras,
  });
}

// ── budowanie zapytania ───────────────────────────────────────────────────────────────────────────
// Ekwiwalent = wartość * crop factor. Rozmiar matrycy: mianownik formatu ("1/1.28" -> 1.28);
// gdy aparat nie ma podanego formatu, przybliżenie z crop factora (1" ~ crop 2.7).
const EQ_FOCAL      = sql`(${camera.focalLengthMm} * ${camera.cropFactor})`;
const EQ_APERTURE   = sql`(${camera.aperture} * ${camera.cropFactor})`;
const EQ_APERTURE_N = sql`(COALESCE(${camera.apertureNarrow}, ${camera.aperture}) * ${camera.cropFactor})`;
const SENSOR_DEN    = sql`COALESCE(${camera.sensorDenominator}, ${camera.cropFactor} / 2.7)`;

function cameraConds(f: CameraFilter): SQL[] {
  const c: SQL[] = [];
  if (f.type)   c.push(eq(camera.type, f.type));
  if (f.facing) c.push(eq(camera.facing, f.facing));
  if (f.ois)    c.push(f.ois.length === 1 ? eq(camera.ois, f.ois[0]!) : inArray(camera.ois, f.ois));
  if (f.variableAperture) c.push(eq(camera.variableAperture, true));
  if (f.opticalZoom)      c.push(eq(camera.opticalZoom, true));
  if (f.eqFocalMin !== undefined)    c.push(sql`${EQ_FOCAL} >= ${f.eqFocalMin}`);
  if (f.eqFocalMax !== undefined)    c.push(sql`${EQ_FOCAL} <= ${f.eqFocalMax}`);
  // zakres przysłony aparatu [najszersza, najwęższa] musi przecinać się z [min, max]
  if (f.eqApertureMax !== undefined) c.push(sql`${EQ_APERTURE} <= ${f.eqApertureMax}`);
  if (f.eqApertureMin !== undefined) c.push(sql`${EQ_APERTURE_N} >= ${f.eqApertureMin}`);
  if (f.resolutionMin !== undefined) c.push(gte(camera.resolutionMp, f.resolutionMin));
  if (f.sensorDenominatorMin !== undefined) c.push(sql`${SENSOR_DEN} >= ${f.sensorDenominatorMin}`);
  if (f.sensorDenominatorMax !== undefined) c.push(sql`${SENSOR_DEN} <= ${f.sensorDenominatorMax}`);
  return c;
}

function whereOf(q: CatalogueQuery): SQL | undefined {
  const conds: SQL[] = [];
  if (q.verified === true)  conds.push(sql`${smartphone.verifiedBy} IS NOT NULL`);
  if (q.verified === false) conds.push(sql`${smartphone.verifiedBy} IS NULL`);

  // Wyszukiwanie: każde słowo musi pasować do modelu, marki albo kodu modelu ("samsung s24", "SM-S928B")
  for (const token of q.q.split(/\s+/).filter(Boolean).slice(0, 5)) {
    const pattern = `%${token}%`;
    conds.push(or(
      like(smartphone.modelName, pattern),
      like(brand.name, pattern),
      exists(db.select({ one: sql`1` }).from(smartphoneBuildModel)
        .where(and(eq(smartphoneBuildModel.smartphoneId, smartphone.id), like(smartphoneBuildModel.buildModel, pattern)))),
    )!);
  }

  if (q.brandIds.length === 1) conds.push(eq(smartphone.brandId, q.brandIds[0]!));
  if (q.brandIds.length > 1)   conds.push(inArray(smartphone.brandId, q.brandIds));
  if (q.releaseFrom) conds.push(gte(smartphone.releaseDate, q.releaseFrom));
  if (q.releaseTo)   conds.push(lte(smartphone.releaseDate, q.releaseTo));

  // każdy filtr aparatu = osobny EXISTS (telefon musi mieć np. i szeroki, i tele)
  for (const f of q.cameras) {
    conds.push(exists(
      db.select({ one: sql`1` }).from(camera)
        .where(and(eq(camera.smartphoneId, smartphone.id), eq(camera.status, "approved"), ...cameraConds(f))),
    ));
  }
  return conds.length > 0 ? and(...conds) : undefined;
}

/** Element listy katalogu (wspólny kształt dla listy, wyszukiwania i ulubionych). */
export function listItem<T extends { imageUrl: string | null; verifiedBy?: string | null }>(r: T) {
  const { verifiedBy, ...rest } = r;
  return {
    ...rest,
    verified: verifiedBy !== null && verifiedBy !== undefined,
    imageUrl: publicUrl(r.imageUrl),
    imageThumbUrl: variantUrl(r.imageUrl, "w512", true), imageMediumUrl: variantUrl(r.imageUrl, "w1024", true),
  };
}

export async function searchCatalogue(q: CatalogueQuery) {
  const where = whereOf(q);
  // Stabilna kolejność (drugi klucz + id), żeby paginacja nie gubiła ani nie dublowała rekordów.
  // Nazwa bez rozróżniania wielkości liter: "iPhone" i "realme" trafiają na właściwe miejsce.
  const orderBy =
    q.sort === "trending" ? [desc(smartphone.viewCount), desc(smartphone.createdAt), asc(smartphone.id)]
  : q.sort === "new"      ? [desc(smartphone.releaseDate), desc(smartphone.createdAt), asc(smartphone.id)]
  :                         [sql`${smartphone.modelName} COLLATE NOCASE`, asc(smartphone.id)];

  const rows = await db
    .select({
      id:          smartphone.id,
      modelName:   smartphone.modelName,
      imageUrl:    smartphone.imageUrl,
      releaseDate: smartphone.releaseDate,
      viewCount:   smartphone.viewCount,
      brandId:     smartphone.brandId,
      brandName:   brand.name,
      verifiedBy:  smartphone.verifiedBy,
      createdAt:   smartphone.createdAt,
    })
    .from(smartphone)
    .leftJoin(brand, eq(smartphone.brandId, brand.id))
    .where(where)
    .orderBy(...orderBy)
    .limit(q.limit)
    .offset((q.page - 1) * q.limit);

  const totalRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(smartphone)
    .leftJoin(brand, eq(smartphone.brandId, brand.id))
    .where(where);

  return { data: rows.map(listItem), page: q.page, limit: q.limit, total: totalRows[0]?.n ?? 0, sort: q.sort };
}
