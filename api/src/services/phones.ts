import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  brand, camera, cameraVideoMode, favorite, review, smartphone, smartphoneBuildModel,
} from "../db/schema.js";
import { deleteStoredObject, publicUrl, variantUrl } from "../lib/storage.js";

// ── kody modelu (Build.MODEL / identyfikator iOS) ────────────────────────────────────────────────

export const MAX_BUILD_MODELS = 20;
const BUILD_MODEL_MAX_LEN = 128;

export const buildModelKey = (m: string) => m.trim().toLowerCase();

/** Waliduje listę kodów; usuwa duplikaty (bez względu na wielkość liter). null = błąd. */
export function parseBuildModels(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_BUILD_MODELS) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (!t || t.length > BUILD_MODEL_MAX_LEN) return null;
    if (seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

/** Telefon, do którego należy którykolwiek z kodów (pierwszy znaleziony), albo null. */
export async function findPhoneIdByBuildModels(models: string[]): Promise<string | null> {
  if (models.length === 0) return null;
  const rows = await db.select({ smartphoneId: smartphoneBuildModel.smartphoneId }).from(smartphoneBuildModel)
    .where(inArray(smartphoneBuildModel.buildModelKey, models.map(buildModelKey)))
    .orderBy(asc(smartphoneBuildModel.createdAt)).limit(1);
  return rows[0]?.smartphoneId ?? null;
}

/** Dopisuje do telefonu kody, które nie są jeszcze przypisane do żadnego telefonu. */
export async function attachFreeBuildModels(smartphoneId: string, models: string[]): Promise<void> {
  if (models.length === 0) return;
  await db.insert(smartphoneBuildModel)
    .values(models.map((m) => ({ buildModelKey: buildModelKey(m), buildModel: m, smartphoneId, createdAt: new Date() })))
    .onConflictDoNothing();
}

/** Kody przypisane do INNYCH telefonów (konflikty przy ustawianiu listy kodów). */
export async function buildModelConflicts(smartphoneId: string, models: string[]) {
  if (models.length === 0) return [];
  return db.select({ buildModel: smartphoneBuildModel.buildModel, smartphoneId: smartphoneBuildModel.smartphoneId })
    .from(smartphoneBuildModel)
    .where(and(inArray(smartphoneBuildModel.buildModelKey, models.map(buildModelKey)), ne(smartphoneBuildModel.smartphoneId, smartphoneId)));
}

/** Zastępuje listę kodów telefonu (wywołujący sprawdza wcześniej konflikty). */
export function replaceBuildModels(smartphoneId: string, models: string[]): void {
  db.transaction((tx) => {
    tx.delete(smartphoneBuildModel).where(eq(smartphoneBuildModel.smartphoneId, smartphoneId)).run();
    if (models.length > 0) {
      tx.insert(smartphoneBuildModel)
        .values(models.map((m) => ({ buildModelKey: buildModelKey(m), buildModel: m, smartphoneId, createdAt: new Date() })))
        .run();
    }
  });
}

async function buildModelsOf(ids: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (ids.length === 0) return map;
  const rows = await db.select().from(smartphoneBuildModel)
    .where(inArray(smartphoneBuildModel.smartphoneId, ids))
    // kolejność dodania (rowid rozstrzyga kody zapisane w tej samej sekundzie)
    .orderBy(asc(smartphoneBuildModel.createdAt), asc(sql`${smartphoneBuildModel}.rowid`));
  for (const r of rows) map.set(r.smartphoneId, [...(map.get(r.smartphoneId) ?? []), r.buildModel]);
  return map;
}

// ── tryby wideo zbiorczo (jedno zapytanie zamiast jednego na aparat) ─────────────────────────────

export async function videoModesOf(cameraIds: string[]) {
  const map = new Map<string, (typeof cameraVideoMode.$inferSelect)[]>();
  if (cameraIds.length === 0) return map;
  const rows = await db.select().from(cameraVideoMode)
    .where(inArray(cameraVideoMode.cameraId, cameraIds))
    .orderBy(asc(cameraVideoMode.widthPx), asc(cameraVideoMode.id));
  for (const r of rows) map.set(r.cameraId, [...(map.get(r.cameraId) ?? []), r]);
  return map;
}

// ── szczegóły telefonu ───────────────────────────────────────────────────────────────────────────

/** Szczegóły kilku telefonów naraz, w kolejności podanych id (brakujące są pomijane). */
export async function getSmartphoneDetails(ids: string[]) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await db
    .select({ phone: smartphone, brandName: brand.name, brandLogoUrl: brand.logoUrl })
    .from(smartphone)
    .leftJoin(brand, eq(smartphone.brandId, brand.id))
    .where(inArray(smartphone.id, unique));

  const cams = await db.select().from(camera)
    .where(and(inArray(camera.smartphoneId, unique), eq(camera.status, "approved")))
    .orderBy(asc(camera.submittedAt), asc(camera.id));
  const modes = await videoModesOf(cams.map((c) => c.id));
  const codes = await buildModelsOf(unique);

  const byId = new Map(rows.map((r) => [r.phone.id, {
    ...r.phone,
    verified:      r.phone.verifiedBy !== null,
    imageUrl:      publicUrl(r.phone.imageUrl),
    imageThumbUrl: variantUrl(r.phone.imageUrl, "w512", true),
    brandName:     r.brandName,
    brandLogoUrl:  publicUrl(r.brandLogoUrl),
    buildModels:   codes.get(r.phone.id) ?? [],
    cameras:       cams.filter((c) => c.smartphoneId === r.phone.id).map((c) => ({ ...c, videoModes: modes.get(c.id) ?? [] })),
  }]));
  return ids.map((id) => byId.get(id)).filter((x): x is NonNullable<typeof x> => x !== undefined);
}

export async function getSmartphoneDetail(id: string) {
  return (await getSmartphoneDetails([id]))[0] ?? null;
}

/** Krótki opis telefonów (do list "moje recenzje", "moje aparaty" itp.), mapa id -> opis. */
export async function phoneSummaries(ids: string[]) {
  const map = new Map<string, { id: string; modelName: string; brandName: string | null; imageUrl: string | null; imageThumbUrl: string | null }>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return map;
  const rows = await db.select({
    id: smartphone.id, modelName: smartphone.modelName, brandName: brand.name, imageUrl: smartphone.imageUrl,
  }).from(smartphone).leftJoin(brand, eq(smartphone.brandId, brand.id)).where(inArray(smartphone.id, unique));
  for (const r of rows) {
    map.set(r.id, { ...r, imageUrl: publicUrl(r.imageUrl), imageThumbUrl: variantUrl(r.imageUrl, "w512", true) });
  }
  return map;
}

// ── scalanie duplikatów ──────────────────────────────────────────────────────────────────────────

/**
 * Scala telefon `sourceId` z telefonem `targetId`: aparaty (razem ze zdjęciami i filmami), recenzje,
 * ulubione i kody modelu przechodzą do telefonu docelowego, liczniki wyświetleń się sumują, a puste
 * pola docelowego (zdjęcie, data premiery, weryfikacja) są uzupełniane ze źródła. Nazwa źródła trafia
 * do kodów modelu (jeśli była inna), żeby kolejne zgłoszenia pod tą nazwą trafiały już do celu.
 * Na końcu telefon źródłowy jest usuwany. Wszystko w jednej transakcji.
 */
export async function mergeSmartphones(targetId: string, sourceId: string) {
  let orphanImage: string | null = null;
  const moved = db.transaction((tx) => {
    const target = tx.select().from(smartphone).where(eq(smartphone.id, targetId)).all()[0]!;
    const source = tx.select().from(smartphone).where(eq(smartphone.id, sourceId)).all()[0]!;

    const cams = tx.update(camera).set({ smartphoneId: targetId }).where(eq(camera.smartphoneId, sourceId)).run().changes;
    const revs = tx.update(review).set({ smartphoneId: targetId }).where(eq(review.smartphoneId, sourceId)).run().changes;

    // ulubione: użytkownik, który miał oba telefony, zostaje z jednym wpisem
    const favs = tx.run(sql`INSERT OR IGNORE INTO ${favorite} (user_id, smartphone_id, added_at)
      SELECT user_id, ${targetId}, added_at FROM ${favorite} WHERE smartphone_id = ${sourceId}`).changes;
    tx.delete(favorite).where(eq(favorite.smartphoneId, sourceId)).run();

    const codes = tx.update(smartphoneBuildModel).set({ smartphoneId: targetId })
      .where(eq(smartphoneBuildModel.smartphoneId, sourceId)).run().changes;
    if (buildModelKey(source.modelName) !== buildModelKey(target.modelName)) {
      tx.insert(smartphoneBuildModel)
        .values({ buildModelKey: buildModelKey(source.modelName), buildModel: source.modelName.trim(), smartphoneId: targetId, createdAt: new Date() })
        .onConflictDoNothing().run();
    }

    tx.update(smartphone).set({
      viewCount:   target.viewCount + source.viewCount,
      imageUrl:    target.imageUrl ?? source.imageUrl,
      releaseDate: target.releaseDate ?? source.releaseDate,
      verifiedBy:  target.verifiedBy ?? source.verifiedBy,
    }).where(eq(smartphone.id, targetId)).run();

    if (target.imageUrl && source.imageUrl && source.imageUrl !== target.imageUrl) orphanImage = source.imageUrl;
    tx.delete(smartphone).where(eq(smartphone.id, sourceId)).run();
    return { cameras: cams, reviews: revs, favorites: favs, buildModels: codes };
  });

  if (orphanImage) await deleteStoredObject(orphanImage).catch((err) => console.error("[merge] image cleanup failed:", err));
  return moved;
}

