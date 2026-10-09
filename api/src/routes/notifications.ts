import { Hono } from "hono";
import { db } from "../db/index.js";
import { notification } from "../db/schema.js";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { requireAuth } from "../middleware/requireAuth.js";
import { fail } from "../lib/errors.js";
import type { HonoVariables } from "../types/honoTypes.js";

const notificationsRouter = new Hono<{ Variables: HonoVariables }>();
notificationsRouter.use("/*", requireAuth);

function present(n: typeof notification.$inferSelect) {
  let payload: unknown = {};
  try { payload = JSON.parse(n.payload); } catch { /* zostaje {} */ }
  return { id: n.id, type: n.type, payload, read: n.readAt !== null, createdAt: n.createdAt };
}

// ?unread=1 - tylko nieprzeczytane; paginacja ?page=&limit=
notificationsRouter.get("/", async (c) => {
  const u = c.get("user");
  const pageRaw  = parseInt(c.req.query("page")  ?? "1",  10);
  const limitRaw = parseInt(c.req.query("limit") ?? "30", 10);
  const page  = Number.isFinite(pageRaw)  ? Math.max(1, pageRaw) : 1;
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : 30;
  const onlyUnread = c.req.query("unread") === "1";

  const where = onlyUnread
    ? and(eq(notification.userId, u.id), isNull(notification.readAt))
    : eq(notification.userId, u.id);

  const rows = await db.select().from(notification).where(where)
    .orderBy(desc(notification.createdAt), desc(notification.id))
    .limit(limit).offset((page - 1) * limit);

  return c.json({ data: rows.map(present), page, limit });
});

notificationsRouter.get("/unread-count", async (c) => {
  const u = c.get("user");
  const r = await db.select({ n: sql<number>`count(*)` }).from(notification)
    .where(and(eq(notification.userId, u.id), isNull(notification.readAt)));
  return c.json({ unread: r[0]?.n ?? 0 });
});

notificationsRouter.post("/read-all", async (c) => {
  const u = c.get("user");
  await db.update(notification).set({ readAt: new Date() })
    .where(and(eq(notification.userId, u.id), isNull(notification.readAt)));
  return c.json({ ok: true });
});

notificationsRouter.patch("/:id/read", async (c) => {
  const u = c.get("user");
  const id = c.req.param("id") as string;
  const updated = await db.update(notification).set({ readAt: new Date() })
    .where(and(eq(notification.id, id), eq(notification.userId, u.id)))
    .returning({ id: notification.id });
  if (!updated[0]) return fail(c, 404, "NOTIFICATION_NOT_FOUND", "Notification not found");
  return c.json({ ok: true });
});

export { notificationsRouter };
