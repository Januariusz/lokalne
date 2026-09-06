import { Hono } from "hono";
import { db } from "../db/index.js";
import { review, reviewMedia } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireRole } from "../middleware/requireAuth.js";
import { storageUrl, objectExists, BUCKETS } from "../lib/minio.js";
import { auth } from "../lib/auth.js";
import type { HonoVariables } from "../types/honoTypes.js";
import { randomUUID } from "node:crypto";

const reviewsRouter = new Hono<{ Variables: HonoVariables }>();


reviewsRouter.get("/pending", requireRole("moderator"), async (c) => {
  const rows = await db.select().from(review).where(eq(review.status, "pending"));
  return c.json(rows);
});

reviewsRouter.get("/", async (c) => {
  const smartphoneId = c.req.query("smartphone_id");
  if (!smartphoneId) return c.json({ error: "smartphone_id required" }, 400);

  const rows = await db.select().from(review)
    .where(and(eq(review.smartphoneId, smartphoneId), eq(review.status, "published")));

  const withMedia = await Promise.all(rows.map(async (r) => {
    const media = await db.select().from(reviewMedia).where(eq(reviewMedia.reviewId, r.id));
    return { ...r, media };
  }));

  return c.json(withMedia);
});



reviewsRouter.get("/:id", async (c) => {
  const id = c.req.param("id") as string;
  const rows = await db.select().from(review).where(eq(review.id, id));
  if (!rows[0]) return c.json({ error: "Not found" }, 404);

  const row = rows[0];
  if (row.status !== "published") {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "Not found" }, 404);
    const u = session.user as { id: string; role?: string };
    const isMod = ["moderator", "admin"].includes(u.role ?? "");
    if (!isMod && u.id !== row.authorId) return c.json({ error: "Not found" }, 404);
  }

  const media = await db.select().from(reviewMedia).where(eq(reviewMedia.reviewId, row.id));
  return c.json({ ...row, media });
});

reviewsRouter.post("/", requireRole("reviewer"), async (c) => {
  const user = c.get("user"); // wcześniej: druga, zbędna auth.api.getSession(...)

  const body = await c.req.json<{
    smartphoneId: string;
    title: string;
    contentMarkdown: string;
    mediaItems?: Array<{ objectKey: string; type: "photo" | "video"; displayOrder: number }>;
  }>();

  if (!body.smartphoneId || !body.title || !body.contentMarkdown) {
    return c.json({ error: "smartphoneId, title, contentMarkdown required" }, 400);
  }

  // Nie ufamy ślepo objectKey od klienta — sprawdzamy, że plik naprawdę
  // wylądował w MinIO, zanim zapiszemy na niego wskaźnik w bazie.
  if (body.mediaItems?.length) {
    for (const m of body.mediaItems) {
      if (!(await objectExists(BUCKETS.reviewMedia, m.objectKey))) {
        return c.json({ error: `Uploaded object not found: ${m.objectKey}` }, 409);
      }
    }
  }

  const newReview = {
    id:              randomUUID(),
    authorId:        user.id,
    smartphoneId:    body.smartphoneId,
    title:           body.title.trim(),
    contentMarkdown: body.contentMarkdown,
    status:          "pending" as const,
    createdAt:       new Date(),
    updatedAt:       new Date(),
  };

  await db.insert(review).values(newReview);

  if (body.mediaItems?.length) {
    await db.insert(reviewMedia).values(
      body.mediaItems.map(m => ({
        id:           randomUUID(),
        reviewId:     newReview.id,
        type:         m.type,
        storageUrl:   storageUrl(BUCKETS.reviewMedia, m.objectKey),
        displayOrder: m.displayOrder,
      }))
    );
  }

  return c.json(newReview, 201);
});

reviewsRouter.patch("/:id", requireAuth, async (c) => {
  const user = c.get("user");

  const id = c.req.param("id") as string;
  const rows = await db.select().from(review).where(eq(review.id, id));
  if (!rows[0]) return c.json({ error: "Not found" }, 404);

  const current = rows[0];
  const isMod   = ["moderator", "admin"].includes(user.role ?? "");
  const isOwner = user.id === current.authorId;
  if (!isMod && !isOwner) return c.json({ error: "Forbidden" }, 403);

  const body = await c.req.json<{
    title?: string;
    contentMarkdown?: string;
    status?: "draft" | "pending" | "published" | "hidden";
  }>();


  const updates: Partial<typeof review.$inferInsert> = { updatedAt: new Date() };
  if (body.title)           updates.title           = body.title.trim();
  if (body.contentMarkdown) updates.contentMarkdown = body.contentMarkdown;

  if (isMod && body.status) {
    updates.status = body.status;
  } else if (!isMod && body.status === "pending") {
    updates.status = "pending";
  }

  await db.update(review).set(updates).where(eq(review.id, id));
  return c.json({ ok: true });
});

reviewsRouter.delete("/:id", requireAuth, async (c) => {
  const user = c.get("user");

  const id = c.req.param("id") as string;
  const rows = await db.select().from(review).where(eq(review.id, id));
  if (!rows[0]) return c.json({ error: "Not found" }, 404);

  const isMod = ["moderator", "admin"].includes(user.role ?? "");
  if (!isMod && user.id !== rows[0].authorId) return c.json({ error: "Forbidden" }, 403);

  await db.delete(review).where(eq(review.id, id));
  return c.json({ ok: true });
});

export { reviewsRouter };
