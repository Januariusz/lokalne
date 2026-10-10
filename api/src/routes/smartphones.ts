import { Hono } from "hono";
import { db } from "../db/index.js";
import { smartphone, camera, cameraVideoMode, brand, photo, video } from "../db/schema.js";
import { eq, and, or, like, sql, desc, asc, gte, lte, exists, type SQL } from "drizzle-orm";
import { requireRole, requireAuth, hasRole } from "../middleware/requireAuth.js";
import { publicUrl } from "../lib/storage.js";
import { fail } from "../lib/errors.js";
import type { HonoVariables } from "../types/honoTypes.js";
import { randomUUID } from "node:crypto";

const smartphonesRouter = new Hono<{ Variables: HonoVariables }>();

// Deduplikacja wyświetleń: ten sam IP może zwiększyć licznik tego samego
// telefonu najwyżej raz na 30 minut (w pamięci procesu).
const VIEW_DEDUPE_MS = 30 * 60 * 1000;
const recentViews = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of recentViews) {
    if (now - ts > VIEW_DEDUPE_MS) recentViews.delete(key);
  }
}, 10 * 60 * 1000).unref();

const CAMERA_TYPES = ["wide", "ultrawide", "tele", "macro", "other"] as const;
const FACINGS      = ["back", "front", "other"] as const;
const OIS_TYPES    = ["none", "optical", "sensor_shift"] as const;
const SORTS        = ["name", "trending", "new"] as const;
const NUM_FILTERS  = ["eq_focal_min", "eq_focal_max", "eq_aperture_max", "resolution_min"] as const;
const DATE_RE      = /^\d{4}(-\d{2}(-\d{2})?)?$/;

function isOneOf<T extends string>(v: string, allowed: readonly T[]): v is T {
  return (allowed as readonly string[]).includes(v);
}

function paging(c: { req: { query(name: string): string | undefined } }) {
  const pageRaw  = parseInt(c.req.query("page")  ?? "1",  10);
  const limitRaw = parseInt(c.req.query("limit") ?? "20", 10);
  const page  = Number.isFinite(pageRaw)  ? Math.max(1, pageRaw) : 1;
  const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, limitRaw)) : 20;
  return { page, limit, offset: (page - 1) * limit };
}

async function getSmartphoneDetail(id: string) {
  const rows = await db
    .select({
      phone:        smartphone,
      brandName:    brand.name,
      brandLogoUrl: brand.logoUrl,
    })
    .from(smartphone)
    .leftJoin(brand, eq(smartphone.brandId, brand.id))
    .where(eq(smartphone.id, id));

  const row = rows[0];
  if (!row) return null;

  const cameras = await db.select().from(camera)
    .where(and(eq(camera.smartphoneId, id), eq(camera.status, "approved")));

  const camerasWithModes = await Promise.all(cameras.map(async (cam) => {
    const modes = await db.select().from(cameraVideoMode).where(eq(cameraVideoMode.cameraId, cam.id));
    return { ...cam, videoModes: modes };
  }));

  return {
    ...row.phone,
    verified:     row.phone.verifiedBy !== null,
    imageUrl:     publicUrl(row.phone.imageUrl),
    brandName:    row.brandName,
    brandLogoUrl: publicUrl(row.brandLogoUrl),
    cameras:      camerasWithModes,
  };
}

smartphonesRouter.get("/compare", async (c) => {
  const idsParam = c.req.query("ids") ?? "";
  const ids = idsParam.split(",").filter(Boolean).slice(0, 50);
  if (ids.length < 2) return fail(c, 400, "TOO_FEW_IDS", "Provide at least 2 ids");
  if (ids.length > 4) return fail(c, 400, "TOO_MANY_IDS", "You can compare at most 4 phones");
  const results = await Promise.all(ids.map(id => getSmartphoneDetail(id)));
  return c.json(results.filter(Boolean));
});

/**
 * Katalog telefonów.
 *   q               - fraza; każde słowo musi pasować do nazwy modelu LUB nazwy marki
 *   brand_id        - dokładna marka
 *   sort            - name (domyślnie) | trending (wg wyświetleń) | new (wg daty premiery)
 *   camera_type     - wide | ultrawide | tele | macro | other
 *   facing          - back | front | other
 *   ois             - none | optical | sensor_shift
 *   eq_focal_min/max - ekwiwalent ogniskowej (mm, po przeliczeniu na pełną klatkę)
 *   eq_aperture_max - maksymalny ekwiwalentny numer przysłony (f * crop factor)
 *   resolution_min  - minimalna rozdzielczość matrycy (Mpx)
 *   variable_aperture / optical_zoom - "true": tylko aparaty ze zmienną przysłoną / zoomem optycznym
 *   verified        - "true": tylko telefony zweryfikowane przez moderatora
 *   release_from/to - zakres daty premiery (YYYY, YYYY-MM lub YYYY-MM-DD)
 * Filtry aparatu muszą być spełnione przez JEDEN zatwierdzony aparat danego telefonu.
 */
smartphonesRouter.get("/", async (c) => {
  const q       = (c.req.query("q") ?? "").trim();
  const brandId = c.req.query("brand_id");
  const { page, limit, offset } = paging(c);

  const sortRaw = c.req.query("sort");
  const sort = sortRaw === undefined || sortRaw === "" ? "name" : sortRaw;
  if (!isOneOf(sort, SORTS)) {
    return fail(c, 400, "INVALID_SORT", `sort must be one of: ${SORTS.join(", ")}`);
  }

  const cameraTypeRaw = c.req.query("camera_type") || undefined;
  if (cameraTypeRaw !== undefined && !isOneOf(cameraTypeRaw, CAMERA_TYPES)) {
    return fail(c, 400, "INVALID_FILTER", `camera_type must be one of: ${CAMERA_TYPES.join(", ")}`);
  }
  const cameraType = cameraTypeRaw as (typeof CAMERA_TYPES)[number] | undefined;

  const facingRaw = c.req.query("facing") || undefined;
  if (facingRaw !== undefined && !isOneOf(facingRaw, FACINGS)) {
    return fail(c, 400, "INVALID_FILTER", `facing must be one of: ${FACINGS.join(", ")}`);
  }
  const facing = facingRaw as (typeof FACINGS)[number] | undefined;

  const oisRaw = c.req.query("ois") || undefined;
  if (oisRaw !== undefined && !isOneOf(oisRaw, OIS_TYPES)) {
    return fail(c, 400, "INVALID_FILTER", `ois must be one of: ${OIS_TYPES.join(", ")}`);
  }
  const ois = oisRaw as (typeof OIS_TYPES)[number] | undefined;

  const nums: Partial<Record<(typeof NUM_FILTERS)[number], number>> = {};
  for (const name of NUM_FILTERS) {
    const raw = c.req.query(name);
    if (raw === undefined || raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fail(c, 400, "INVALID_FILTER", `${name} must be a number`);
    nums[name] = n;
  }

  const releaseFrom = c.req.query("release_from");
  const releaseTo   = c.req.query("release_to");
  for (const [name, v] of [["release_from", releaseFrom], ["release_to", releaseTo]] as const) {
    if (v && !DATE_RE.test(v)) {
      return fail(c, 400, "INVALID_FILTER", `${name} must look like YYYY, YYYY-MM or YYYY-MM-DD`);
    }
  }

  const flag = (name: string) => c.req.query(name) === "true";

  const conds: SQL[] = [];
  if (flag("verified")) conds.push(sql`${smartphone.verifiedBy} IS NOT NULL`);

  // Wyszukiwanie po modelu i marce: "samsung s24" => "samsung" (marka) + "s24" (model)
  for (const token of q.split(/\s+/).filter(Boolean).slice(0, 5)) {
    const pattern = `%${token}%`;
    conds.push(or(like(smartphone.modelName, pattern), like(brand.name, pattern))!);
  }

  if (brandId)     conds.push(eq(smartphone.brandId, brandId));
  if (releaseFrom) conds.push(gte(smartphone.releaseDate, releaseFrom));
  if (releaseTo)   conds.push(lte(smartphone.releaseDate, releaseTo));

  const camConds: SQL[] = [];
  if (cameraType) camConds.push(eq(camera.type, cameraType));
  if (facing)     camConds.push(eq(camera.facing, facing));
  if (ois)        camConds.push(eq(camera.ois, ois));
  if (flag("variable_aperture")) camConds.push(eq(camera.variableAperture, true));
  if (flag("optical_zoom"))      camConds.push(eq(camera.opticalZoom, true));
  if (nums.eq_focal_min !== undefined)
    camConds.push(sql`${camera.focalLengthMm} * ${camera.cropFactor} >= ${nums.eq_focal_min}`);
  if (nums.eq_focal_max !== undefined)
    camConds.push(sql`${camera.focalLengthMm} * ${camera.cropFactor} <= ${nums.eq_focal_max}`);
  if (nums.eq_aperture_max !== undefined)
    camConds.push(sql`${camera.aperture} * ${camera.cropFactor} <= ${nums.eq_aperture_max}`);
  if (nums.resolution_min !== undefined)
    camConds.push(gte(camera.resolutionMp, nums.resolution_min));

  if (camConds.length > 0) {
    conds.push(exists(
      db.select({ one: sql`1` }).from(camera)
        .where(and(eq(camera.smartphoneId, smartphone.id), eq(camera.status, "approved"), ...camConds)),
    ));
  }

  const where = conds.length > 0 ? and(...conds) : undefined;

  // Stabilna kolejność (drugi klucz + id), żeby paginacja nie gubiła ani nie dublowała rekordów.
  const orderBy =
    sort === "trending" ? [desc(smartphone.viewCount), desc(smartphone.createdAt), asc(smartphone.id)]
  : sort === "new"      ? [desc(smartphone.releaseDate), desc(smartphone.createdAt), asc(smartphone.id)]
  :                       [asc(smartphone.modelName), asc(smartphone.id)];

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
    .limit(limit)
    .offset(offset);

  const totalRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(smartphone)
    .leftJoin(brand, eq(smartphone.brandId, brand.id))
    .where(where);

  const data = rows.map(({ verifiedBy, ...r }) => ({ ...r, verified: verifiedBy !== null, imageUrl: publicUrl(r.imageUrl) }));
  return c.json({ data, page, limit, total: totalRows[0]?.n ?? 0, sort });
});


// Tylko odczyt: nie zwiększa viewCount (patrz POST /:id/view).
smartphonesRouter.get("/:id", async (c) => {
  const id = c.req.param("id") as string;
  const detail = await getSmartphoneDetail(id);
  if (!detail) return fail(c, 404, "NOT_FOUND", "Not found");
  return c.json(detail);
});


// Galeria zdjęć: photo nie ma smartphoneId, więc join idzie przez camera.
smartphonesRouter.get("/:id/photos", async (c) => {
  const id = c.req.param("id") as string;
  const { page, limit, offset } = paging(c);

  const rows = await db
    .select({
      id:         photo.id,
      cameraId:   photo.cameraId,
      cameraType: camera.type,
      facing:     camera.facing,
      storageUrl: photo.storageUrl,
      widthPx:    photo.widthPx,
      heightPx:   photo.heightPx,
      uploadDate: photo.uploadDate,
    })
    .from(photo)
    .innerJoin(camera, eq(photo.cameraId, camera.id))
    .where(and(eq(camera.smartphoneId, id), eq(photo.status, "verified")))
    .orderBy(desc(photo.uploadDate), asc(photo.id))
    .limit(limit)
    .offset(offset);

  return c.json({
    data: rows.map(({ storageUrl, ...r }) => ({ ...r, url: publicUrl(storageUrl) })),
    page,
    limit,
  });
});

// Galeria wideo: analogicznie do zdjęć.
smartphonesRouter.get("/:id/videos", async (c) => {
  const id = c.req.param("id") as string;
  const { page, limit, offset } = paging(c);

  const rows = await db
    .select({
      id:         video.id,
      cameraId:   video.cameraId,
      cameraType: camera.type,
      facing:     camera.facing,
      storageUrl: video.storageUrl,
      widthPx:    video.widthPx,
      heightPx:   video.heightPx,
      fps:        video.fps,
      uploadDate: video.uploadDate,
    })
    .from(video)
    .innerJoin(camera, eq(video.cameraId, camera.id))
    .where(and(eq(camera.smartphoneId, id), eq(video.status, "verified")))
    .orderBy(desc(video.uploadDate), asc(video.id))
    .limit(limit)
    .offset(offset);

  return c.json({
    data: rows.map(({ storageUrl, ...r }) => ({ ...r, url: publicUrl(storageUrl) })),
    page,
    limit,
  });
});


// Liczy wyświetlenie. Frontend woła to raz, przy wejściu na ekran szczegółów.
smartphonesRouter.post("/:id/view", async (c) => {
  const id = c.req.param("id") as string;

  const viewer = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const key = `${viewer}::${id}`;
  const now = Date.now();

  const last = recentViews.get(key);
  if (last && now - last < VIEW_DEDUPE_MS) {
    return c.json({ counted: false });
  }

  const updated = await db.update(smartphone)
    .set({ viewCount: sql`${smartphone.viewCount} + 1` })
    .where(eq(smartphone.id, id))
    .returning({ id: smartphone.id });

  if (!updated[0]) return fail(c, 404, "NOT_FOUND", "Not found");

  recentViews.set(key, now);
  return c.json({ counted: true });
});


// Dodawanie telefonu do katalogu.
//  - zwykły użytkownik (BPMN 2.4: "My phone" -> "Submit camera data"): zakłada wpis NIEZWERYFIKOWANY
//    (verifiedBy = null); moderator potwierdza go później przez PATCH /:id,
//  - moderator/administrator ("Add device"): wpis od razu zweryfikowany.
// Marka: brandId albo brandName (marka jest dopasowywana bez względu na wielkość liter, a gdy jej
// nie ma - tworzona; aplikacja mobilna zna tylko napis z Build.MANUFACTURER).
// Ten sam model tej samej marki nie zostanie zdublowany: API zwraca istniejący wpis (200, existing:true).
const NEW_PHONES_PER_DAY = 10; // limit dla kont poniżej moderatora (ochrona przed zaśmiecaniem katalogu)

smartphonesRouter.post("/", requireAuth, async (c) => {
  const user = c.get("user");
  const isStaff = hasRole(user.role, "moderator");

  const body = await c.req.json<{
    brandId?: unknown; brandName?: unknown; modelName?: unknown; imageUrl?: unknown; releaseDate?: unknown;
  }>().catch(() => null);
  if (!body) return fail(c, 400, "INVALID_BODY", "Request body must be valid JSON");

  const modelName = typeof body.modelName === "string" ? body.modelName.trim() : "";
  const brandName = typeof body.brandName === "string" ? body.brandName.trim() : "";
  const brandIdIn = typeof body.brandId === "string" ? body.brandId : "";
  if (!modelName || (!brandIdIn && !brandName)) {
    return fail(c, 400, "MISSING_FIELDS", "modelName and brandId (or brandName) are required");
  }
  if (modelName.length > 128 || brandName.length > 128) {
    return fail(c, 400, "INVALID_FIELD", "modelName and brandName can be at most 128 characters", { field: modelName.length > 128 ? "modelName" : "brandName" });
  }
  if (body.releaseDate !== undefined && body.releaseDate !== null &&
      (typeof body.releaseDate !== "string" || !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(body.releaseDate))) {
    return fail(c, 400, "INVALID_FIELD", "releaseDate must be YYYY, YYYY-MM or YYYY-MM-DD", { field: "releaseDate" });
  }
  // zdjęcie urządzenia może ustawić tylko moderator (upload /device-image jest dla moderatora)
  const imageUrl = isStaff && typeof body.imageUrl === "string" ? body.imageUrl : null;

  // marka
  let brandId = brandIdIn;
  if (brandId) {
    const b = await db.select({ id: brand.id }).from(brand).where(eq(brand.id, brandId));
    if (!b[0]) return fail(c, 404, "BRAND_NOT_FOUND", "Brand not found");
  } else {
    const found = await db.select({ id: brand.id }).from(brand)
      .where(sql`lower(${brand.name}) = ${brandName.toLowerCase()}`);
    if (found[0]) {
      brandId = found[0].id;
    } else {
      brandId = randomUUID();
      await db.insert(brand).values({ id: brandId, name: brandName, logoUrl: null });
    }
  }

  // duplikat: ta sama marka + ten sam model (bez względu na wielkość liter)
  const dup = (await db.select().from(smartphone).where(and(
    eq(smartphone.brandId, brandId),
    sql`lower(${smartphone.modelName}) = ${modelName.toLowerCase()}`,
  )))[0];
  if (dup) return c.json({ ...dup, imageUrl: publicUrl(dup.imageUrl), verified: dup.verifiedBy !== null, existing: true }, 200);

  if (!isStaff) {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const n = (await db.select({ n: sql<number>`count(*)` }).from(smartphone)
      .where(and(eq(smartphone.addedBy, user.id), gte(smartphone.createdAt, since))))[0]?.n ?? 0;
    if (n >= NEW_PHONES_PER_DAY) {
      return fail(c, 429, "PHONE_LIMIT_REACHED", `You can add at most ${NEW_PHONES_PER_DAY} new phones per day`);
    }
  }

  const newPhone = {
    id:          randomUUID(),
    brandId,
    addedBy:     user.id,
    verifiedBy:  (isStaff ? user.id : null) as string | null,
    modelName,
    imageUrl,
    releaseDate: (body.releaseDate as string | null | undefined) ?? null,
    viewCount:   0,
    createdAt:   new Date(),
  };

  await db.insert(smartphone).values(newPhone);
  return c.json({ ...newPhone, verified: newPhone.verifiedBy !== null, existing: false }, 201);
});


smartphonesRouter.patch("/:id", requireRole("moderator"), async (c) => {
  const user = c.get("user");

  const id = c.req.param("id") as string;

  const existing = await db.select({ id: smartphone.id }).from(smartphone).where(eq(smartphone.id, id));
  if (!existing[0]) return fail(c, 404, "NOT_FOUND", "Not found");

  const body = await c.req.json<Partial<{
    modelName: string; imageUrl: string; releaseDate: string; brandId: string;
  }>>();

  const updates: Partial<typeof smartphone.$inferInsert> = { verifiedBy: user.id };
  if (body.modelName)                  updates.modelName   = body.modelName.trim();
  if (body.imageUrl !== undefined)     updates.imageUrl    = body.imageUrl;
  if (body.releaseDate !== undefined)  updates.releaseDate = body.releaseDate;
  if (body.brandId)                    updates.brandId     = body.brandId;

  await db.update(smartphone).set(updates).where(eq(smartphone.id, id));
  return c.json({ ok: true });
});


smartphonesRouter.delete("/:id", requireRole("admin"), async (c) => {
  await db.delete(smartphone).where(eq(smartphone.id, c.req.param("id") as string));
  return c.json({ ok: true });
});

export { smartphonesRouter };
