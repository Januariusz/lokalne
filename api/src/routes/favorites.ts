import { Hono } from "hono";
import { db } from "../db/index.js";
import { favorite, smartphone, brand } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middleware/requireAuth.js";
import type { HonoVariables } from "../types/honoTypes.js";

const favoritesRouter = new Hono<{ Variables: HonoVariables }>();

favoritesRouter.get("/", requireAuth, async (c) => {
  const user = c.get("user");

  const rows = await db
    .select({
      smartphoneId: favorite.smartphoneId,
      addedAt:      favorite.addedAt,
      modelName:    smartphone.modelName,
      imageUrl:     smartphone.imageUrl,
      brandName:    brand.name,
    })
    .from(favorite)
    .leftJoin(smartphone, eq(favorite.smartphoneId, smartphone.id))
    .leftJoin(brand, eq(smartphone.brandId, brand.id))
    .where(eq(favorite.userId, user.id));

  return c.json(rows);
});

favoritesRouter.post("/:smartphoneId", requireAuth, async (c) => {
  const user = c.get("user");

  await db.insert(favorite)
    .values({ userId: user.id, smartphoneId: c.req.param("smartphoneId") as string, addedAt: new Date() })
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
