import { Hono } from "hono";
import { db } from "../db/index.js";
import { brand } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { requireRole } from "../middleware/requireAuth.js";
import { randomUUID } from "node:crypto";

const brandsRouter = new Hono();

brandsRouter.get("/", async (c) => {
  const rows = await db.select().from(brand).orderBy(brand.name);
  return c.json(rows);
});

brandsRouter.get("/:id", async (c) => {
  const id = c.req.param("id") as string;
  const row = await db.select().from(brand).where(eq(brand.id, id));
  if (!row[0]) return c.json({ error: "Not found" }, 404);
  return c.json(row[0]);
});

brandsRouter.post("/", requireRole("moderator"), async (c) => {
  const body = await c.req.json<{ name: string; logoUrl?: string }>();
  if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
  const newBrand = { id: randomUUID(), name: body.name.trim(), logoUrl: body.logoUrl ?? null };
  await db.insert(brand).values(newBrand);
  return c.json(newBrand, 201);
});

brandsRouter.patch("/:id", requireRole("moderator"), async (c) => {
  const id = c.req.param("id") as string;
  const body = await c.req.json<{ name?: string; logoUrl?: string }>();

  const updates: Partial<typeof brand.$inferInsert> = {};
  if (body.name) updates.name = body.name.trim();
  if (body.logoUrl !== undefined) updates.logoUrl = body.logoUrl;

  if (Object.keys(updates).length === 0) {
    return c.json({ error: "Nothing to update — provide name and/or logoUrl" }, 400);
  }

  const existing = await db.select({ id: brand.id }).from(brand).where(eq(brand.id, id));
  if (!existing[0]) return c.json({ error: "Not found" }, 404);

  await db.update(brand).set(updates).where(eq(brand.id, id));
  return c.json({ ok: true });
});

brandsRouter.delete("/:id", requireRole("admin"), async (c) => {
  await db.delete(brand).where(eq(brand.id, c.req.param("id") as string));
  return c.json({ ok: true });
});

export { brandsRouter };
