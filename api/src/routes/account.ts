import { Hono } from "hono";
import { db } from "../db/index.js";
import {
  user, favorite, review, photo, video, camera, reviewComment, reviewLike, notification, promotionOffer, roleChangeLog,
} from "../db/schema.js";
import { eq, and, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../middleware/requireAuth.js";
import { mediaUrl } from "../lib/storage.js";
import { fail } from "../lib/errors.js";
import { notify } from "../lib/notifications.js";
import { deleteUserAccount } from "../services/userDeletion.js";
import type { HonoVariables } from "../types/honoTypes.js";

const accountRouter = new Hono<{ Variables: HonoVariables }>();

// Usunięcie własnego konta. Potwierdzenie ("Are you sure?") realizuje UI klienta.
// Sesje są kasowane, więc po tym wywołaniu token przestaje działać.
accountRouter.delete("/", requireAuth, async (c) => {
  const current = c.get("user");
  await deleteUserAccount(current.id, "self");
  return c.json({ ok: true });
});

// ── Awans na reviewera (BPMN 2.3): użytkownik akceptuje albo odrzuca propozycję ──────────

// Moja oczekująca propozycja awansu (albo null).
accountRouter.get("/promotion", requireAuth, async (c) => {
  const current = c.get("user");
  const offer = (await db.select().from(promotionOffer)
    .where(and(eq(promotionOffer.userId, current.id), eq(promotionOffer.status, "pending")))
    .orderBy(desc(promotionOffer.createdAt)).limit(1))[0];
  return c.json(offer ?? null);
});

async function answerOffer(c: any, decision: "accepted" | "rejected") {
  const current = c.get("user") as { id: string; role?: string };
  const id = c.req.param("id") as string;

  const offer = (await db.select().from(promotionOffer)
    .where(and(eq(promotionOffer.id, id), eq(promotionOffer.userId, current.id))))[0];
  if (!offer) return fail(c, 404, "OFFER_NOT_FOUND", "Promotion offer not found");
  if (offer.status !== "pending") return fail(c, 409, "OFFER_ALREADY_ANSWERED", "This offer has already been answered");

  db.transaction((tx) => {
    tx.update(promotionOffer).set({ status: decision, respondedAt: new Date() })
      .where(eq(promotionOffer.id, id)).run();
    if (decision === "accepted") {
      const previousRole = tx.select({ role: user.role }).from(user).where(eq(user.id, current.id)).all()[0]?.role ?? "user";
      if (previousRole === "user") {
        tx.update(user).set({ role: "reviewer" }).where(eq(user.id, current.id)).run();
        tx.insert(roleChangeLog).values({
          id: randomUUID(), targetId: current.id, previousRole, newRole: "reviewer",
          changedAt: new Date(), changedBy: offer.offeredBy,
        }).run();
      }
    }
  });

  // powiadomienie dla osoby, która zaproponowała awans ("Receive notification about user's decision")
  if (offer.offeredBy) {
    await notify(offer.offeredBy, "promotion_decision", { offerId: id, userId: current.id, decision });
  }
  return c.json({ ok: true, status: decision });
}

accountRouter.post("/promotion/:id/accept", requireAuth, (c) => answerOffer(c, "accepted"));
accountRouter.post("/promotion/:id/reject", requireAuth, (c) => answerOffer(c, "rejected"));

// Eksport danych osobowych użytkownika (prawo dostępu do danych, RODO).
accountRouter.get("/export", requireAuth, async (c) => {
  const current = c.get("user");

  const profile = (await db.select({
    id:            user.id,
    name:          user.name,
    email:         user.email,
    username:      user.username,
    role:          user.role,
    emailVerified: user.emailVerified,
    createdAt:     user.createdAt,
  }).from(user).where(eq(user.id, current.id)))[0];

  const favorites = await db.select().from(favorite).where(eq(favorite.userId, current.id));
  const reviews   = await db.select().from(review).where(eq(review.authorId, current.id));
  const cameras   = await db.select().from(camera).where(eq(camera.submitterId, current.id));
  const photos    = await db.select().from(photo).where(eq(photo.uploaderId, current.id));
  const videos    = await db.select().from(video).where(eq(video.uploaderId, current.id));
  const comments  = await db.select().from(reviewComment).where(eq(reviewComment.authorId, current.id));
  const likes     = await db.select().from(reviewLike).where(eq(reviewLike.userId, current.id));
  const notifications = await db.select().from(notification).where(eq(notification.userId, current.id));

  c.header("Content-Disposition", 'attachment; filename="mobilelens-my-data.json"');
  return c.json({
    exportedAt: new Date().toISOString(),
    profile,
    favorites,
    reviews,
    cameraSubmissions: cameras,
    comments,
    likes,
    notifications,
    photos: photos.map(({ storageUrl, ...p }) => ({ ...p, url: p.status === "deleted" ? null : mediaUrl(storageUrl, p.status === "verified") })),
    videos: videos.map(({ storageUrl, ...v }) => ({ ...v, url: v.status === "deleted" ? null : mediaUrl(storageUrl, v.status === "verified") })),
  });
});

export { accountRouter };
