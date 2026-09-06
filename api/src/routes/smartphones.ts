import { Hono } from "hono";
import { db } from "../db/index.js";
import { smartphone, camera, cameraVideoMode, brand } from "../db/schema.js";
import { eq, and, like, sql } from "drizzle-orm";
import { requireRole } from "../middleware/requireAuth.js";
import type { HonoVariables } from "../types/honoTypes.js";
import { randomUUID } from "node:crypto";

const smartphonesRouter = new Hono<{ Variables: HonoVariables }>();

async function getSmartphoneDetail(id: string) {
  const rows = await db.select().from(smartphone).where(eq(smartphone.id, id));
  if (!rows[0]) return null;

  const cameras = await db.select().from(camera)
    .where(and(eq(camera.smartphoneId, id), eq(camera.status, "approved")));

  const camerasWithModes = await Promise.all(cameras.map(async (cam) => {
    const modes = await db.select().from(cameraVideoMode).where(eq(cameraVideoMode.cameraId, cam.id));
    return { ...cam, videoModes: modes };
  }));

  return { ...rows[0], cameras: camerasWithModes };
}

smartphonesRouter.get("/compare", async (c) => {
  const idsParam = c.req.query("ids") ?? "";
  const ids = idsParam.split(",").filter(Boolean).slice(0, 5);
  if (ids.length < 2) return c.json({ error: "Provide at least 2 ids" }, 400);
  const results = await Promise.all(ids.map(id => getSmartphoneDetail(id)));
  return c.json(results.filter(Boolean));
});


smartphonesRouter.get("/", async (c) => {
  const q       = c.req.query("q") ?? "";
  const brandId = c.req.query("brand_id");
  const page    = Math.max(1, parseInt(c.req.query("page") ?? "1", 10));
  const limit   = Math.min(50, parseInt(c.req.query("limit") ?? "20", 10));
  const offset  = (page - 1) * limit;

  const baseSelect = {
    id:          smartphone.id,
    modelName:   smartphone.modelName,
    imageUrl:    smartphone.imageUrl,
    releaseDate: smartphone.releaseDate,
    viewCount:   smartphone.viewCount,
    brandId:     smartphone.brandId,
    brandName:   brand.name,
    createdAt:   smartphone.createdAt,
  };

  let rows;
  if (q && brandId) {
    rows = await db.select(baseSelect).from(smartphone)
      .leftJoin(brand, eq(smartphone.brandId, brand.id))
      .where(and(like(smartphone.modelName, `%${q}%`), eq(smartphone.brandId, brandId)))
      .limit(limit).offset(offset);
  } else if (q) {
    rows = await db.select(baseSelect).from(smartphone)
      .leftJoin(brand, eq(smartphone.brandId, brand.id))
      .where(like(smartphone.modelName, `%${q}%`))
      .limit(limit).offset(offset);
  } else if (brandId) {
    rows = await db.select(baseSelect).from(smartphone)
      .leftJoin(brand, eq(smartphone.brandId, brand.id))
      .where(eq(smartphone.brandId, brandId))
      .limit(limit).offset(offset);
  } else {
    rows = await db.select(baseSelect).from(smartphone)
      .leftJoin(brand, eq(smartphone.brandId, brand.id))
      .limit(limit).offset(offset);
  }

  return c.json({ data: rows, page, limit });
});


smartphonesRouter.get("/:id", async (c) => {
  const id = c.req.param("id") as string;
  const detail = await getSmartphoneDetail(id);
  if (!detail) return c.json({ error: "Not found" }, 404);

  db.update(smartphone)
    .set({ viewCount: sql`${smartphone.viewCount} + 1` })
    .where(eq(smartphone.id, id))
    .catch(console.error);

  return c.json(detail);
});


smartphonesRouter.post("/", requireRole("reviewer"), async (c) => {
  const user = c.get("user"); // wcześniej: druga, zbędna auth.api.getSession(...)

  const body = await c.req.json<{
    brandId: string;
    modelName: string;
    imageUrl?: string;
    releaseDate?: string;
  }>();

  if (!body.brandId || !body.modelName) return c.json({ error: "brandId and modelName required" }, 400);

  const newPhone = {
    id:          randomUUID(),
    brandId:     body.brandId,
    addedBy:     user.id,
    verifiedBy:  null as string | null,
    modelName:   body.modelName.trim(),
    imageUrl:    body.imageUrl ?? null,
    releaseDate: body.releaseDate ?? null,
    viewCount:   0,
    createdAt:   new Date(),
  };

  await db.insert(smartphone).values(newPhone);
  return c.json(newPhone, 201);
});


smartphonesRouter.patch("/:id", requireRole("moderator"), async (c) => {
  const user = c.get("user");

  const id = c.req.param("id") as string;

  const existing = await db.select({ id: smartphone.id }).from(smartphone).where(eq(smartphone.id, id));
  if (!existing[0]) return c.json({ error: "Not found" }, 404);

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
