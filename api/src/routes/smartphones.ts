import { Hono, type Context } from "hono";
import { etag } from "hono/etag";
import { db } from "../db/index.js";
import { smartphone, camera, brand, photo, video, smartphoneBuildModel } from "../db/schema.js";
import { eq, and, sql, desc, asc, gte, type SQL } from "drizzle-orm";
import { requireRole, requireAuth, hasRole } from "../middleware/requireAuth.js";
import { publicUrl, variantUrl, deleteStoredObject } from "../lib/storage.js";
import { detachPhoneFromReviews } from "../services/reviewPhones.js";
import { deleteCamerasWithMedia } from "../services/cameraDeletion.js";
import {
  parseCatalogueQuery, parseCatalogueBody, searchCatalogue, catalogueFacets, FACINGS, type ParseError,
} from "../services/catalogue.js";
import {
  getSmartphoneDetail, getSmartphoneDetails, parseBuildModels, findPhoneIdByBuildModels,
  attachFreeBuildModels, buildModelConflicts, replaceBuildModels, mergeSmartphones, buildModelKey,
} from "../services/phones.js";
import { fail } from "../lib/errors.js";
import type { HonoVariables } from "../types/honoTypes.js";
import { randomUUID } from "node:crypto";

const smartphonesRouter = new Hono<{ Variables: HonoVariables }>();
type Ctx = Context<{ Variables: HonoVariables }>;

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

// Katalog nie zawiera danych zależnych od użytkownika, więc odpowiedzi mogą być krótko
// przechowywane w cache klienta; ETag pozwala odświeżyć je odpowiedzią 304 bez treści.
// Czasy są krótkie, żeby zmiany moderatora (weryfikacja, nowe aparaty) były szybko widoczne.
const CATALOGUE_CACHE = "public, max-age=30, stale-while-revalidate=120";
function publicCache(c: Ctx) { c.header("Cache-Control", CATALOGUE_CACHE); }

const DATE_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

function paging(c: { req: { query(name: string): string | undefined } }) {
  const pageRaw  = parseInt(c.req.query("page")  ?? "1",  10);
  const limitRaw = parseInt(c.req.query("limit") ?? "20", 10);
  const page  = Number.isFinite(pageRaw)  ? Math.max(1, pageRaw) : 1;
  const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, limitRaw)) : 20;
  return { page, limit, offset: (page - 1) * limit };
}

const parseFail = (c: Ctx, e: ParseError) =>
  fail(c, 400, e.code, e.message, e.field ? { field: e.field } : undefined);

/**
 * Zakresy filtrów wyszukiwarki z wartości obecnych w katalogu (koła wyboru w aplikacjach):
 * dla każdego typu aparatu min/max ekwiwalentnej ogniskowej, przysłony, matrycy, rozdzielczości
 * i lista fps trybów wideo, największy fps dla progów rozdzielczości (videoMaxFpsByWidth).
 * `types` - zatwierdzone tylne aparaty według typu, `front` - zatwierdzone przednie razem. ?verified= jak w GET /.
 */
const FACETS_CACHE = "public, max-age=300, stale-while-revalidate=3600";
smartphonesRouter.get("/facets", etag({ weak: true }), async (c) => {
  const v = c.req.query("verified") || undefined;
  if (v !== undefined && v !== "true" && v !== "false") {
    return fail(c, 400, "INVALID_FILTER", "verified must be true or false", { field: "verified" });
  }
  c.header("Cache-Control", FACETS_CACHE);
  return c.json(await catalogueFacets(v === undefined ? undefined : v === "true"));
});

smartphonesRouter.get("/compare", etag({ weak: true }), async (c) => {
  const idsParam = c.req.query("ids") ?? "";
  const ids = idsParam.split(",").filter(Boolean).slice(0, 50);
  if (ids.length < 2) return fail(c, 400, "TOO_FEW_IDS", "Provide at least 2 ids");
  if (ids.length > 4) return fail(c, 400, "TOO_MANY_IDS", "You can compare at most 4 phones");
  publicCache(c);
  return c.json(await getSmartphoneDetails(ids));
});

/**
 * Telefon po kodzie modelu z urządzenia (Android Build.MODEL, np. "SM-S928B"; iOS "iPhone16,1").
 *   model (wymagany) - najpierw dokładne dopasowanie kodu (bez wielkości liter), potem nazwy modelu
 *   brand (opcjonalny) - nazwa marki zawężająca wynik
 * Zwraca to samo co GET /:id albo 404.
 */
smartphonesRouter.get("/by-model", async (c) => {
  const model = (c.req.query("model") ?? "").trim();
  const brandName = (c.req.query("brand") ?? "").trim().toLowerCase();
  if (!model) return fail(c, 400, "MISSING_FIELDS", "model is required", { field: "model" });

  const brandCond: SQL[] = brandName ? [sql`lower(${brand.name}) = ${brandName}`] : [];
  const byCode = await db.select({ id: smartphone.id }).from(smartphoneBuildModel)
    .innerJoin(smartphone, eq(smartphoneBuildModel.smartphoneId, smartphone.id))
    .leftJoin(brand, eq(smartphone.brandId, brand.id))
    .where(and(eq(smartphoneBuildModel.buildModelKey, buildModelKey(model)), ...brandCond))
    .limit(1);
  let id = byCode[0]?.id;
  if (!id) {
    const byName = await db.select({ id: smartphone.id }).from(smartphone)
      .leftJoin(brand, eq(smartphone.brandId, brand.id))
      .where(and(sql`lower(${smartphone.modelName}) = ${model.toLowerCase()}`, ...brandCond))
      .orderBy(asc(smartphone.createdAt), asc(smartphone.id))
      .limit(1);
    id = byName[0]?.id;
  }
  if (!id) return fail(c, 404, "NOT_FOUND", "Not found");
  return c.json(await getSmartphoneDetail(id));
});

/**
 * Katalog telefonów.
 *   q               - fraza; każde słowo musi pasować do nazwy modelu, marki LUB kodu modelu
 *   brand_id        - marka; kilka: brand_id=a,b,c albo powtórzony parametr (maks. 20)
 *   sort            - name (domyślnie, bez rozróżniania wielkości liter) | brand (marka, potem model) | trending | new
 *   camera_type     - wide | ultrawide | tele | macro | other
 *   facing          - back | front | other
 *   ois             - none | optical | sensor_shift; kilka po przecinku
 *   eq_focal_min/max - ekwiwalent ogniskowej (mm, po przeliczeniu na pełną klatkę)
 *   eq_aperture_min/max - ekwiwalentny numer przysłony (f * crop factor); zakres przysłony aparatu
 *                     (od najszerszej do najwęższej) musi przecinać się z podanym zakresem
 *   resolution_min  - minimalna rozdzielczość matrycy (Mpx)
 *   sensor_den_min/max - rozmiar matrycy jako mianownik formatu ("1/1.28" -> 1.28; mniejszy = większa matryca)
 *   variable_aperture / optical_zoom - "true": tylko aparaty ze zmienną przysłoną / zoomem optycznym
 *   video_min_width / video_min_fps - aparat ma tryb wideo z dłuższym bokiem >= i fps >= (ten sam tryb)
 *   verified        - "true": tylko zweryfikowane przez moderatora, "false": tylko niezweryfikowane
 *   release_from/to - zakres daty premiery (YYYY, YYYY-MM lub YYYY-MM-DD)
 * Filtry aparatu muszą być spełnione przez JEDEN zatwierdzony aparat danego telefonu.
 * Kilka różnych aparatów naraz (np. szeroki i tele): POST /search.
 */
smartphonesRouter.get("/", etag({ weak: true }), async (c) => {
  const parsed = parseCatalogueQuery((n) => c.req.query(n), (n) => c.req.queries(n));
  if (!parsed.ok) return parseFail(c, parsed.error);
  publicCache(c);
  return c.json(await searchCatalogue(parsed.value));
});

/**
 * Wyszukiwanie z treścią JSON (ta sama odpowiedź co GET /):
 * { q?, brandIds?: string[], sort?, verified?: boolean, releaseFrom?, releaseTo?, page?, limit?,
 *   cameras?: [{ type?, facing?, ois?: string[], eqFocalMin?, eqFocalMax?, eqApertureMin?, eqApertureMax?,
 *                resolutionMin?, sensorDenominatorMin?, sensorDenominatorMax?, variableAperture?, opticalZoom?,
 *                videoMinWidth?, videoMinFps? }],
 *   allBackCamerasVideo?: { minWidth?, minFps? }, frontCameraCountMin?: 1-5 }
 * Każdy element `cameras` to osobny aparat: telefon musi mieć aparat spełniający każdy z nich.
 * videoMinWidth/videoMinFps: aparat ma tryb wideo spełniający oba warunki (w jednym trybie).
 * allBackCamerasVideo: KAŻDY zatwierdzony tylny aparat wide/ultrawide/tele ma taki tryb (makro pomijane).
 * frontCameraCountMin: telefon ma co najmniej tyle zatwierdzonych przednich aparatów.
 */
smartphonesRouter.post("/search", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = parseCatalogueBody(body);
  if (!parsed.ok) return parseFail(c, parsed.error);
  return c.json(await searchCatalogue(parsed.value));
});


// Tylko odczyt: nie zwiększa viewCount (patrz POST /:id/view).
smartphonesRouter.get("/:id", etag({ weak: true }), async (c) => {
  const id = c.req.param("id") as string;
  const detail = await getSmartphoneDetail(id);
  if (!detail) return fail(c, 404, "NOT_FOUND", "Not found");
  publicCache(c);
  return c.json(detail);
});


/** Wspólne filtry galerii: aparat (camera_id), strona aparatu (facing); tylko zatwierdzone aparaty. */
function galleryFilter(c: Ctx, smartphoneId: string, statusCond: SQL): { where: SQL } | { error: Response } {
  const conds: SQL[] = [eq(camera.smartphoneId, smartphoneId), eq(camera.status, "approved"), statusCond];
  const cameraId = c.req.query("camera_id");
  if (cameraId) conds.push(eq(camera.id, cameraId));
  const facing = c.req.query("facing");
  if (facing) {
    if (!(FACINGS as readonly string[]).includes(facing)) {
      return { error: fail(c, 400, "INVALID_FILTER", `facing must be one of: ${FACINGS.join(", ")}`, { field: "facing" }) };
    }
    conds.push(eq(camera.facing, facing as (typeof FACINGS)[number]));
  }
  return { where: and(...conds)! };
}

// Galeria zdjęć: photo nie ma smartphoneId, więc join idzie przez camera.
// thumbUrl (480 px) i mediumUrl (1280 px) to miniatury WebP; null, gdy ich jeszcze nie ma - wtedy url.
smartphonesRouter.get("/:id/photos", async (c) => {
  const id = c.req.param("id") as string;
  const { page, limit, offset } = paging(c);
  const f = galleryFilter(c, id, eq(photo.status, "verified"));
  if ("error" in f) return f.error;

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
    .where(f.where)
    .orderBy(desc(photo.uploadDate), asc(photo.id))
    .limit(limit)
    .offset(offset);
  const total = (await db.select({ n: sql<number>`count(*)` }).from(photo)
    .innerJoin(camera, eq(photo.cameraId, camera.id)).where(f.where))[0]?.n ?? 0;

  publicCache(c);
  return c.json({
    data: rows.map(({ storageUrl, ...r }) => ({
      ...r,
      url:       publicUrl(storageUrl),
      thumbUrl:  variantUrl(storageUrl, "w480", true),
      mediumUrl: variantUrl(storageUrl, "w1280", true),
    })),
    page,
    limit,
    total,
  });
});

// Galeria wideo: analogicznie do zdjęć.
smartphonesRouter.get("/:id/videos", async (c) => {
  const id = c.req.param("id") as string;
  const { page, limit, offset } = paging(c);
  const f = galleryFilter(c, id, eq(video.status, "verified"));
  if ("error" in f) return f.error;

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
    .where(f.where)
    .orderBy(desc(video.uploadDate), asc(video.id))
    .limit(limit)
    .offset(offset);
  const total = (await db.select({ n: sql<number>`count(*)` }).from(video)
    .innerJoin(camera, eq(video.cameraId, camera.id)).where(f.where))[0]?.n ?? 0;

  publicCache(c);
  return c.json({
    data: rows.map(({ storageUrl, ...r }) => ({ ...r, url: publicUrl(storageUrl) })),
    page,
    limit,
    total,
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
// buildModels: kody modelu z urządzenia (Build.MODEL / identyfikator iOS). Jeśli któryś kod jest już
// przypisany do telefonu w katalogu, API zwraca ten telefon (200, existing:true), nawet gdy nazwa się różni.
// Ten sam model tej samej marki nie zostanie zdublowany: API zwraca istniejący wpis (200, existing:true).
// ?include=cameras - odpowiedź w kształcie GET /:id (z aparatami, marką i kodami) + existing.
const NEW_PHONES_PER_DAY = 10; // limit dla kont poniżej moderatora (ochrona przed zaśmiecaniem katalogu)

smartphonesRouter.post("/", requireAuth, async (c) => {
  const user = c.get("user");
  const isStaff = hasRole(user.role, "moderator");
  const includeDetail = c.req.query("include") === "cameras";

  const body = await c.req.json<{
    brandId?: unknown; brandName?: unknown; modelName?: unknown; imageUrl?: unknown; releaseDate?: unknown;
    buildModels?: unknown;
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
      (typeof body.releaseDate !== "string" || !DATE_RE.test(body.releaseDate))) {
    return fail(c, 400, "INVALID_FIELD", "releaseDate must be YYYY, YYYY-MM or YYYY-MM-DD", { field: "releaseDate" });
  }
  const buildModels = parseBuildModels(body.buildModels);
  if (buildModels === null) {
    return fail(c, 400, "INVALID_FIELD", "buildModels must be a list of up to 20 non-empty strings (max 128 characters)", { field: "buildModels" });
  }
  // zdjęcie urządzenia może ustawić tylko moderator (upload /device-image jest dla moderatora)
  const imageUrl = isStaff && typeof body.imageUrl === "string" ? body.imageUrl : null;

  const respondExisting = async (phoneId: string) => {
    await attachFreeBuildModels(phoneId, buildModels);
    const detail = await getSmartphoneDetail(phoneId);
    if (includeDetail) return c.json({ ...detail, existing: true }, 200);
    const { cameras: _cameras, brandName: _b, brandLogoUrl: _l, ...row } = detail!;
    return c.json({ ...row, existing: true }, 200);
  };

  // 1. kod modelu z urządzenia już jest w katalogu
  const byCode = await findPhoneIdByBuildModels(buildModels);
  if (byCode) return respondExisting(byCode);

  // 2. marka
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

  // 3. duplikat: ta sama marka + ten sam model (bez względu na wielkość liter)
  const dup = (await db.select({ id: smartphone.id }).from(smartphone).where(and(
    eq(smartphone.brandId, brandId),
    sql`lower(${smartphone.modelName}) = ${modelName.toLowerCase()}`,
  )))[0];
  if (dup) return respondExisting(dup.id);

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
  await attachFreeBuildModels(newPhone.id, buildModels);

  if (includeDetail) return c.json({ ...(await getSmartphoneDetail(newPhone.id)), existing: false }, 201);
  return c.json({
    ...newPhone,
    imageUrl: publicUrl(newPhone.imageUrl),
    imageThumbUrl: variantUrl(newPhone.imageUrl, "w512", true), imageMediumUrl: variantUrl(newPhone.imageUrl, "w1024", true),
    verified: newPhone.verifiedBy !== null,
    buildModels,
    existing: false,
  }, 201);
});


/**
 * Scalenie duplikatów (moderator): telefon z treści { sourceId } zostaje włączony do telefonu z adresu.
 * Aparaty ze zdjęciami i filmami, recenzje, ulubione i kody modelu przechodzą do telefonu docelowego,
 * a duplikat jest usuwany. Zwraca szczegóły telefonu docelowego i liczbę przeniesionych elementów.
 */
smartphonesRouter.post("/:id/merge", requireRole("moderator"), async (c) => {
  const targetId = c.req.param("id") as string;
  const body = await c.req.json<{ sourceId?: unknown }>().catch(() => null);
  const sourceId = typeof body?.sourceId === "string" ? body.sourceId : "";
  if (!sourceId) return fail(c, 400, "MISSING_FIELDS", "sourceId is required", { field: "sourceId" });
  if (sourceId === targetId) return fail(c, 400, "MERGE_SAME_PHONE", "A phone cannot be merged into itself");

  const found = await db.select({ id: smartphone.id }).from(smartphone)
    .where(sql`${smartphone.id} IN (${targetId}, ${sourceId})`);
  if (!found.some((r) => r.id === targetId)) return fail(c, 404, "SMARTPHONE_NOT_FOUND", "Smartphone not found");
  if (!found.some((r) => r.id === sourceId)) {
    return fail(c, 404, "SMARTPHONE_NOT_FOUND", "Source smartphone not found", { field: "sourceId" });
  }

  const moved = await mergeSmartphones(targetId, sourceId);
  return c.json({ ok: true, moved, smartphone: await getSmartphoneDetail(targetId) });
});


// Edycja i weryfikacja telefonu przez moderatora. buildModels zastępuje całą listę kodów modelu.
smartphonesRouter.patch("/:id", requireRole("moderator"), async (c) => {
  const user = c.get("user");

  const id = c.req.param("id") as string;

  const existing = await db.select({ id: smartphone.id }).from(smartphone).where(eq(smartphone.id, id));
  if (!existing[0]) return fail(c, 404, "NOT_FOUND", "Not found");

  const body = await c.req.json<Partial<{
    modelName: string; imageUrl: string; releaseDate: string; brandId: string; buildModels: unknown;
  }>>().catch(() => null);
  if (!body) return fail(c, 400, "INVALID_BODY", "Request body must be valid JSON");

  if (body.releaseDate !== undefined && body.releaseDate !== null &&
      (typeof body.releaseDate !== "string" || !DATE_RE.test(body.releaseDate))) {
    return fail(c, 400, "INVALID_FIELD", "releaseDate must be YYYY, YYYY-MM or YYYY-MM-DD", { field: "releaseDate" });
  }
  if (body.brandId) {
    const b = await db.select({ id: brand.id }).from(brand).where(eq(brand.id, body.brandId));
    if (!b[0]) return fail(c, 404, "BRAND_NOT_FOUND", "Brand not found");
  }
  let buildModels: string[] | undefined;
  if (body.buildModels !== undefined) {
    const parsed = parseBuildModels(body.buildModels);
    if (parsed === null) {
      return fail(c, 400, "INVALID_FIELD", "buildModels must be a list of up to 20 non-empty strings (max 128 characters)", { field: "buildModels" });
    }
    const conflicts = await buildModelConflicts(id, parsed);
    if (conflicts.length > 0) {
      return fail(c, 409, "BUILD_MODEL_TAKEN", `Build model ${conflicts[0]!.buildModel} belongs to another phone`, {
        field: "buildModels", buildModel: conflicts[0]!.buildModel, smartphoneId: conflicts[0]!.smartphoneId,
      });
    }
    buildModels = parsed;
  }

  const updates: Partial<typeof smartphone.$inferInsert> = { verifiedBy: user.id };
  if (body.modelName)                  updates.modelName   = body.modelName.trim();
  if (body.imageUrl !== undefined)     updates.imageUrl    = body.imageUrl;
  if (body.releaseDate !== undefined)  updates.releaseDate = body.releaseDate;
  if (body.brandId)                    updates.brandId     = body.brandId;

  await db.update(smartphone).set(updates).where(eq(smartphone.id, id));
  if (buildModels !== undefined) replaceBuildModels(id, buildModels);
  return c.json({ ok: true });
});


// Usunięcie telefonu razem z jego aparatami, zdjęciami i filmami (zdjęcia i filmy blokowały
// wcześniej usunięcie, bo ich klucz obcy do aparatu ma ON DELETE RESTRICT).
smartphonesRouter.delete("/:id", requireRole("admin"), async (c) => {
  const id = c.req.param("id") as string;
  const phone = (await db.select({ id: smartphone.id }).from(smartphone).where(eq(smartphone.id, id)))[0];
  if (!phone) return fail(c, 404, "SMARTPHONE_NOT_FOUND", "Smartphone not found");

  const cameraIds = (await db.select({ id: camera.id }).from(camera).where(eq(camera.smartphoneId, id)))
    .map((r) => r.id);
  await deleteCamerasWithMedia(cameraIds);
  // recenzje porównawcze zostają (z kolejnym telefonem jako głównym); recenzje tylko o tym telefonie
  // znikają kaskadowo razem z nim, a ich pliki usuwamy z dysku
  const reviewFiles = detachPhoneFromReviews(id);
  await db.delete(smartphone).where(eq(smartphone.id, id));
  await Promise.allSettled(reviewFiles.map((u) => deleteStoredObject(u)));
  return c.json({ ok: true });
});

export { smartphonesRouter };
