import { asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { review, reviewMedia, reviewSmartphone, smartphone } from "../db/schema.js";

// Recenzja porównawcza dotyczy kilku telefonów. Telefon główny (pierwszy) jest też w review.smartphone_id,
// więc stare zapytania i klienci, którzy znają tylko `smartphoneId`, działają bez zmian.

export const MAX_REVIEW_PHONES = 5;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Lista telefonów z treści żądania: `smartphoneIds` (pierwszy = główny) i/lub `smartphoneId`.
 * Gdy podane oba, `smartphoneId` jest głównym, a reszta listy dochodzi za nim. Bez duplikatów.
 * Zwraca null, gdy lista jest niepoprawna; [] gdy nie podano żadnego telefonu.
 */
export function parseReviewPhones(smartphoneId: unknown, smartphoneIds: unknown): string[] | null {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v !== "string" || v.length === 0 || v.length > 64) return false;
    if (!out.includes(v)) out.push(v);
    return true;
  };
  if (smartphoneId !== undefined && smartphoneId !== null && !add(smartphoneId)) return null;
  if (smartphoneIds !== undefined && smartphoneIds !== null) {
    if (!Array.isArray(smartphoneIds) || smartphoneIds.length === 0) return null;
    for (const v of smartphoneIds) if (!add(v)) return null;
  }
  return out.length > MAX_REVIEW_PHONES ? null : out;
}

/** Które z podanych telefonów nie istnieją. */
export function missingPhones(ids: string[]): string[] {
  if (ids.length === 0) return [];
  const found = new Set(db.select({ id: smartphone.id }).from(smartphone).where(inArray(smartphone.id, ids)).all().map((r) => r.id));
  return ids.filter((id) => !found.has(id));
}

/** Zapisuje telefony recenzji (kolejność = pozycja) i ustawia telefon główny. */
export function setReviewPhones(tx: Tx, reviewId: string, ids: string[]): void {
  tx.delete(reviewSmartphone).where(eq(reviewSmartphone.reviewId, reviewId)).run();
  tx.insert(reviewSmartphone).values(ids.map((smartphoneId, position) => ({ reviewId, smartphoneId, position }))).run();
  tx.update(review).set({ smartphoneId: ids[0]! }).where(eq(review.id, reviewId)).run();
}

/** Telefony recenzji w kolejności (główny pierwszy); mapa reviewId -> lista id. */
export function phonesOfReviews(reviewIds: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (reviewIds.length === 0) return map;
  const rows = db.select().from(reviewSmartphone).where(inArray(reviewSmartphone.reviewId, reviewIds))
    .orderBy(asc(reviewSmartphone.reviewId), asc(reviewSmartphone.position)).all();
  for (const r of rows) {
    const list = map.get(r.reviewId) ?? [];
    list.push(r.smartphoneId);
    map.set(r.reviewId, list);
  }
  return map;
}

/** Warunek SQL: recenzja dotyczy telefonu (jako głównego albo porównywanego). */
export function reviewMentionsPhone(phoneId: string) {
  return sql`(${review.smartphoneId} = ${phoneId} OR ${review.id} IN (SELECT ${reviewSmartphone.reviewId} FROM ${reviewSmartphone} WHERE ${reviewSmartphone.smartphoneId} = ${phoneId}))`;
}

/** Układa pozycje od nowa tak, żeby telefon z review.smartphone_id był pierwszy. */
function normalize(tx: Tx, reviewIds: string[]): void {
  for (const reviewId of new Set(reviewIds)) {
    const main = tx.select({ id: review.smartphoneId }).from(review).where(eq(review.id, reviewId)).all()[0]?.id;
    if (!main) continue;
    const ids = tx.select({ id: reviewSmartphone.smartphoneId }).from(reviewSmartphone)
      .where(eq(reviewSmartphone.reviewId, reviewId)).orderBy(asc(reviewSmartphone.position)).all().map((r) => r.id);
    const ordered = [main, ...ids.filter((x) => x !== main)];
    tx.delete(reviewSmartphone).where(eq(reviewSmartphone.reviewId, reviewId)).run();
    tx.insert(reviewSmartphone).values(ordered.map((smartphoneId, position) => ({ reviewId, smartphoneId, position }))).run();
  }
}

/**
 * Scalanie telefonów: w recenzjach telefon `sourceId` zastępuje `targetId` (w ramach transakcji
 * scalania, po przepięciu review.smartphone_id). Recenzja, która porównywała oba, ma go raz.
 */
export function mergeReviewPhones(tx: Tx, targetId: string, sourceId: string): void {
  const affected = tx.select({ id: reviewSmartphone.reviewId }).from(reviewSmartphone)
    .where(eq(reviewSmartphone.smartphoneId, sourceId)).all().map((r) => r.id);
  tx.run(sql`UPDATE OR IGNORE ${reviewSmartphone} SET smartphone_id = ${targetId} WHERE smartphone_id = ${sourceId}`);
  tx.delete(reviewSmartphone).where(eq(reviewSmartphone.smartphoneId, sourceId)).run();
  normalize(tx, affected);
}

/**
 * Przed usunięciem telefonu: recenzje porównawcze, w których był głównym, dostają nowy telefon
 * główny (następny z listy) i zostają. Zwraca pliki recenzji, które znikną razem z telefonem
 * (recenzje tylko o nim), żeby można je było usunąć z dysku.
 */
export function detachPhoneFromReviews(phoneId: string): string[] {
  return db.transaction((tx) => {
    const mains = tx.select({ id: review.id }).from(review).where(eq(review.smartphoneId, phoneId)).all().map((r) => r.id);
    const doomed: string[] = [];
    const lists = new Map<string, string[]>();
    if (mains.length) {
      for (const r of tx.select().from(reviewSmartphone).where(inArray(reviewSmartphone.reviewId, mains))
        .orderBy(asc(reviewSmartphone.position)).all()) {
        lists.set(r.reviewId, [...(lists.get(r.reviewId) ?? []), r.smartphoneId]);
      }
    }
    for (const id of mains) {
      const rest = (lists.get(id) ?? []).filter((p) => p !== phoneId);
      if (rest.length === 0) doomed.push(id);
      else setReviewPhones(tx, id, rest);
    }
    if (doomed.length === 0) return [];
    return tx.select({ u: reviewMedia.storageUrl }).from(reviewMedia).where(inArray(reviewMedia.reviewId, doomed)).all().map((r) => r.u);
  });
}

/** Recenzje sprzed tej wersji: każda dostaje wiersz ze swoim telefonem głównym. Bezpieczne przy każdym starcie. */
export function backfillReviewPhones(): number {
  return db.run(sql`INSERT OR IGNORE INTO ${reviewSmartphone} (review_id, smartphone_id, position)
    SELECT id, smartphone_id, 0 FROM ${review}
    WHERE id NOT IN (SELECT review_id FROM ${reviewSmartphone})`).changes;
}
