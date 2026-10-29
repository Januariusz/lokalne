import { Hono } from "hono";
import { db } from "../db/index.js";
import { favorite, smartphone, brand } from "../db/schema.js";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { requireAuth } from "../middleware/requireAuth.js";
import { publicUrl, variantUrl } from "../lib/storage.js";
import { fail } from "../lib/errors.js";
import type { HonoVariables } from "../types/honoTypes.js";

const favoritesRouter = new Hono<{ Variables: HonoVariables }>();

const BULK_MAX = 200;

// Dane prywatne: klient może je trzymać, ale musi je potwierdzić przy każdym użyciu.
favoritesRouter.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-cache");
  c.header("Vary", "Authorization", { append: true });
});

// Najnowsze na górze; rowid rozstrzyga remisy (added_at ma dokładność do sekundy).
favoritesRouter.get("/", requireAuth, async (c) => {
  const user = c.get("user");

  const rows = await db
    .select({
      smartphoneId: favorite.smartphoneId,
      addedAt:      favorite.addedAt,
      modelName:    smartphone.modelName,
      imageUrl:     smartphone.imageUrl,
      brandId:      smartphone.brandId,
      brandName:    brand.name,
      releaseDate:  smartphone.releaseDate,
      verifiedBy:   smartphone.verifiedBy,
    })
    .from(favorite)
    .leftJoin(smartphone, eq(favorite.smartphoneId, smartphone.id))
    .leftJoin(brand, eq(smartphone.brandId, brand.id))
    .where(eq(favorite.userId, user.id))
    .orderBy(desc(favorite.addedAt), desc(sql`${favorite}.rowid`));

  return c.json(rows.map(({ verifiedBy, ...r }) => ({
    ...r,
    verified: verifiedBy !== null,
    imageUrl: publicUrl(r.imageUrl),
    imageThumbUrl: variantUrl(r.imageUrl, "w512", true), imageMediumUrl: variantUrl(r.imageUrl, "w1024", true),
  })));
});

function parseIds(body: unknown): string[] | null {
  const ids = (body as { smartphoneIds?: unknown } | null)?.smartphoneIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > BULK_MAX) return null;
  if (!ids.every((x) => typeof x === "string" && x.length > 0 && x.length <= 64)) return null;
  return [...new Set(ids as string[])];
}

/**
 * Dodanie wielu ulubionych naraz (np. przeniesienie ulubionych gościa na konto po zalogowaniu).
 * Nieistniejące telefony nie przerywają operacji - są zwracane w `missing`.
 */
favoritesRouter.post("/bulk", requireAuth, async (c) => {
  const user = c.get("user");
  const ids = parseIds(await c.req.json().catch(() => null));
  if (!ids) return fail(c, 400, "INVALID_FIELD", `smartphoneIds must be a list of 1-${BULK_MAX} ids`, { field: "smartphoneIds" });

  const result = db.transaction((tx) => {
    const existing = new Set(tx.select({ id: smartphone.id }).from(smartphone).where(inArray(smartphone.id, ids)).all().map((r) => r.id));
    const toAdd = ids.filter((id) => existing.has(id));
    const added = toAdd.length === 0 ? 0 : tx.insert(favorite)
      .values(toAdd.map((smartphoneId) => ({ userId: user.id, smartphoneId, addedAt: new Date() })))
      .onConflictDoNothing().run().changes;
    return { added, alreadyFavorite: toAdd.length - added, missing: ids.filter((id) => !existing.has(id)) };
  });
  return c.json(result);
});

/** Usunięcie wielu ulubionych naraz. */
favoritesRouter.post("/bulk-delete", requireAuth, async (c) => {
  const user = c.get("user");
  const ids = parseIds(await c.req.json().catch(() => null));
  if (!ids) return fail(c, 400, "INVALID_FIELD", `smartphoneIds must be a list of 1-${BULK_MAX} ids`, { field: "smartphoneIds" });
  const removed = db.delete(favorite)
    .where(and(eq(favorite.userId, user.id), inArray(favorite.smartphoneId, ids))).run().changes;
  return c.json({ removed });
});

favoritesRouter.post("/:smartphoneId", requireAuth, async (c) => {
  const user = c.get("user");
  const smartphoneId = c.req.param("smartphoneId") as string;

  const phone = await db.select({ id: smartphone.id }).from(smartphone).where(eq(smartphone.id, smartphoneId));
  if (!phone[0]) return fail(c, 404, "SMARTPHONE_NOT_FOUND", "Smartphone not found");

  await db.insert(favorite)
    .values({ userId: user.id, smartphoneId, addedAt: new Date() })
    .onConflictDoNothing();

  return c.json({ ok: true }, 201);
});

favoritesRouter.delete("/:smartphoneId", requireAuth, async (c) => {
  const user = c.get("user");

  await db.delete(favorite).where(
    and(
      eq(favorite.userId, user.id),
      eq(favorite.smartphoneId, c.req.param("smartphoneId") as string)
    )
  );

  return c.json({ ok: true });
});

export { favoritesRouter };
