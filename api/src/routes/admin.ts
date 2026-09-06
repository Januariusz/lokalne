import { Hono } from "hono";
import { db } from "../db/index.js";
import { user, roleChangeLog, photo, video } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { requireRole } from "../middleware/requireAuth.js";
import type { HonoVariables } from "../types/honoTypes.js";
import { randomUUID } from "node:crypto";

const adminRouter = new Hono<{ Variables: HonoVariables }>();

adminRouter.use("/*", requireRole("moderator"));

adminRouter.get("/users", async (c) => {
  const rows = await db.select({
    id:        user.id,
    name:      user.name,
    email:     user.email,
    username:  user.username,
    role:      user.role,
    createdAt: user.createdAt,
    isDeleted: user.isDeletedUser,
  }).from(user);
  return c.json(rows);
});

adminRouter.patch("/users/:id/role", requireRole("admin"), async (c) => {
  const actingUser = c.get("user"); // wcześniej: druga, zbędna auth.api.getSession(...)

  const targetId = c.req.param("id") as string;
  const body = await c.req.json<{ role: "user" | "reviewer" | "moderator" | "admin" }>();

  const validRoles = ["user", "reviewer", "moderator", "admin"] as const;
  if (!validRoles.includes(body.role)) return c.json({ error: "Invalid role" }, 400);

  const targetRows = await db.select({ role: user.role }).from(user).where(eq(user.id, targetId));
  if (!targetRows[0]) return c.json({ error: "User not found" }, 404);

  const previousRole = targetRows[0].role;
  await db.update(user).set({ role: body.role }).where(eq(user.id, targetId));
  await db.insert(roleChangeLog).values({
    id:           randomUUID(),
    targetId:     targetId,
    previousRole: previousRole,
    newRole:      body.role,
    changedAt:    new Date(),
    changedBy:    actingUser.id,
  });

  return c.json({ ok: true, previousRole, newRole: body.role });
});

adminRouter.delete("/users/:id", requireRole("admin"), async (c) => {
  const id = c.req.param("id") as string;
  await db.update(user)
    .set({
      isDeletedUser: true,
      email:    `deleted+${id}@mobilelens.invalid`,
      username: null,
    })
    .where(eq(user.id, id));
  return c.json({ ok: true });
});

adminRouter.get("/media/pending", async (c) => {
  const pendingPhotos = await db.select().from(photo).where(eq(photo.status, "pending"));
  const pendingVideos = await db.select().from(video).where(eq(video.status, "pending"));
  return c.json({ photos: pendingPhotos, videos: pendingVideos });
});

adminRouter.patch("/media/photos/:id", async (c) => {
  const body = await c.req.json<{ status: "verified" | "deleted" }>();
  if (!["verified", "deleted"].includes(body.status)) return c.json({ error: "Invalid status" }, 400);
  await db.update(photo).set({ status: body.status }).where(eq(photo.id, c.req.param("id") as string));
  return c.json({ ok: true });
});

adminRouter.patch("/media/videos/:id", async (c) => {
  const body = await c.req.json<{ status: "verified" | "deleted" }>();
  if (!["verified", "deleted"].includes(body.status)) return c.json({ error: "Invalid status" }, 400);
  await db.update(video).set({ status: body.status }).where(eq(video.id, c.req.param("id") as string));
  return c.json({ ok: true });
});

adminRouter.get("/role-log", requireRole("admin"), async (c) => {
  const rows = await db.select().from(roleChangeLog);
  return c.json(rows);
});

export { adminRouter };
