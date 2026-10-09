import { Hono } from "hono";
import { db } from "../db/index.js";
import {
  user, session, roleChangeLog, photo, video, camera, smartphone, review, userBan, promotionOffer, visitLog,
} from "../db/schema.js";
import { eq, and, or, isNull, gt, gte, desc, sql } from "drizzle-orm";
import { requireRole, hasRole } from "../middleware/requireAuth.js";
import { mediaUrl, deleteStoredObject, setVisibility, parseStorageUrl } from "../lib/storage.js";
import { notify } from "../lib/notifications.js";
import { getActiveBan } from "../lib/bans.js";
import { fail } from "../lib/errors.js";
import { deleteUserAccount } from "../services/userDeletion.js";
import type { HonoVariables, Role } from "../types/honoTypes.js";
import { randomUUID } from "node:crypto";

const adminRouter = new Hono<{ Variables: HonoVariables }>();

adminRouter.use("/*", requireRole("moderator"));

const VALID_ROLES: readonly Role[] = ["user", "reviewer", "moderator", "admin"];

function isPositiveNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function isPositiveInt(v: unknown): v is number {
  return isPositiveNumber(v) && Number.isInteger(v);
}

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

/**
 * Zmiana roli.
 *  - awans zwykłego użytkownika na reviewera (admin ALBO moderator) działa jak na BPMN 2.3:
 *    użytkownik dostaje powiadomienie z propozycją i sam ją akceptuje lub odrzuca
 *    (POST /api/account/promotion/:id/accept|reject); odpowiedź 202,
 *  - pozostałe zmiany (moderator, administrator, degradacja) - tylko administrator, od razu.
 */
adminRouter.patch("/users/:id/role", async (c) => {
  const actingUser = c.get("user");

  const targetId = c.req.param("id") as string;
  const body = await c.req.json<{ role: Role }>().catch(() => null);

  if (!body || !VALID_ROLES.includes(body.role)) {
    return fail(c, 400, "INVALID_ROLE", `role must be one of: ${VALID_ROLES.join(", ")}`);
  }

  const targetRows = await db.select({ role: user.role, deleted: user.isDeletedUser })
    .from(user).where(eq(user.id, targetId));
  if (!targetRows[0]) return fail(c, 404, "USER_NOT_FOUND", "User not found");

  const previousRole = targetRows[0].role;

  const isReviewerPromotion = body.role === "reviewer" && previousRole === "user";
  if (isReviewerPromotion) {
    // "Is eligible for promotion?" - nie: konto usunięte lub zablokowane
    if (targetRows[0].deleted || (await getActiveBan(targetId))) {
      return fail(c, 409, "NOT_ELIGIBLE", "This user is not eligible for promotion");
    }
    const pending = (await db.select({ id: promotionOffer.id }).from(promotionOffer)
      .where(and(eq(promotionOffer.userId, targetId), eq(promotionOffer.status, "pending"))))[0];
    if (pending) return fail(c, 409, "PROMOTION_PENDING", "A promotion offer is already waiting for this user");

    const offer = { id: randomUUID(), userId: targetId, offeredBy: actingUser.id, createdAt: new Date() };
    await db.insert(promotionOffer).values(offer);
    await notify(targetId, "promotion_offer", { offerId: offer.id, offeredBy: actingUser.id });
    return c.json({ ok: true, status: "pending", offerId: offer.id }, 202);
  }

  if (!hasRole(actingUser.role, "admin")) {
    return fail(c, 403, "FORBIDDEN_ROLE_CHANGE", "Moderators can only promote a user to reviewer");
  }

  if (previousRole === body.role) {
    return c.json({ ok: true, previousRole, newRole: body.role });
  }

  db.transaction((tx) => {
    tx.update(user).set({ role: body.role }).where(eq(user.id, targetId)).run();
    tx.insert(roleChangeLog).values({
      id:           randomUUID(),
      targetId:     targetId,
      previousRole: previousRole,
      newRole:      body.role,
      changedAt:    new Date(),
      changedBy:    actingUser.id,
    }).run();
    // zmiana roli unieważnia otwartą propozycję awansu
    tx.update(promotionOffer).set({ status: "cancelled", respondedAt: new Date() })
      .where(and(eq(promotionOffer.userId, targetId), eq(promotionOffer.status, "pending"))).run();
  });
  await notify(targetId, "role_changed", { previousRole, newRole: body.role });

  return c.json({ ok: true, previousRole, newRole: body.role });
});

// Propozycje awansu (BPMN 2.3): lista i wycofanie przez osobę, która je złożyła, albo administratora.
adminRouter.get("/promotions", async (c) => {
  const rows = await db.select({
    id: promotionOffer.id, userId: promotionOffer.userId, userName: user.name,
    offeredBy: promotionOffer.offeredBy, status: promotionOffer.status,
    createdAt: promotionOffer.createdAt, respondedAt: promotionOffer.respondedAt,
  }).from(promotionOffer).innerJoin(user, eq(promotionOffer.userId, user.id))
    .orderBy(desc(promotionOffer.createdAt)).limit(100);
  return c.json(rows);
});

adminRouter.delete("/promotions/:id", async (c) => {
  const actingUser = c.get("user");
  const id = c.req.param("id") as string;
  const offer = (await db.select().from(promotionOffer).where(eq(promotionOffer.id, id)))[0];
  if (!offer) return fail(c, 404, "OFFER_NOT_FOUND", "Promotion offer not found");
  if (offer.offeredBy !== actingUser.id && !hasRole(actingUser.role, "admin")) {
    return fail(c, 403, "FORBIDDEN", "Forbidden");
  }
  if (offer.status !== "pending") return fail(c, 409, "OFFER_ALREADY_ANSWERED", "This offer has already been answered");
  await db.update(promotionOffer).set({ status: "cancelled", respondedAt: new Date() }).where(eq(promotionOffer.id, id));
  return c.json({ ok: true });
});

// ── Blokady użytkowników (tylko administrator) ───────────────────────────────

adminRouter.post("/users/:id/ban", requireRole("admin"), async (c) => {
  const actingUser = c.get("user");
  const targetId = c.req.param("id") as string;

  const body = await c.req.json<{ reason?: unknown; expiresAt?: unknown }>().catch(() => null);
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!reason || reason.length > 500) {
    return fail(c, 400, "INVALID_FIELD", "reason is required (max 500 characters)", { field: "reason" });
  }
  let expiresAt: Date | null = null;
  if (body?.expiresAt !== undefined && body.expiresAt !== null) {
    expiresAt = new Date(String(body.expiresAt));
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      return fail(c, 400, "INVALID_FIELD", "expiresAt must be a future date", { field: "expiresAt" });
    }
  }

  const target = (await db.select({ role: user.role, deleted: user.isDeletedUser })
    .from(user).where(eq(user.id, targetId)))[0];
  if (!target) return fail(c, 404, "USER_NOT_FOUND", "User not found");
  if (targetId === actingUser.id || target.role === "admin" || target.deleted) {
    return fail(c, 403, "CANNOT_BAN", "This user cannot be banned");
  }
  if (await getActiveBan(targetId)) return fail(c, 409, "ALREADY_BANNED", "This user is already banned");

  const ban = { id: randomUUID(), userId: targetId, bannedBy: actingUser.id, reason, createdAt: new Date(), expiresAt };
  db.transaction((tx) => {
    tx.insert(userBan).values(ban).run();
    tx.delete(session).where(eq(session.userId, targetId)).run(); // natychmiastowe wylogowanie
    tx.update(promotionOffer).set({ status: "cancelled", respondedAt: new Date() })
      .where(and(eq(promotionOffer.userId, targetId), eq(promotionOffer.status, "pending"))).run();
  });
  return c.json(ban, 201);
});

adminRouter.delete("/users/:id/ban", requireRole("admin"), async (c) => {
  const actingUser = c.get("user");
  const targetId = c.req.param("id") as string;
  const ban = await getActiveBan(targetId);
  if (!ban) return fail(c, 404, "BAN_NOT_FOUND", "This user has no active ban");
  await db.update(userBan).set({ revokedAt: new Date(), revokedBy: actingUser.id }).where(eq(userBan.id, ban.id));
  return c.json({ ok: true });
});

// "Recent bans" z panelu administratora.
adminRouter.get("/bans", requireRole("admin"), async (c) => {
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "20", 10) || 20));
  return c.json(await recentBans(limit));
});

async function recentBans(limit: number) {
  const rows = await db.select({
    id: userBan.id, userId: userBan.userId, userName: user.name, reason: userBan.reason,
    bannedBy: userBan.bannedBy, createdAt: userBan.createdAt, expiresAt: userBan.expiresAt,
    revokedAt: userBan.revokedAt,
  }).from(userBan).innerJoin(user, eq(userBan.userId, user.id))
    .orderBy(desc(userBan.createdAt)).limit(limit);
  const now = Date.now();
  return rows.map((r) => ({
    ...r,
    active: !r.revokedAt && (!r.expiresAt || r.expiresAt.getTime() > now),
  }));
}

// ── Panel zarządzania: treści + statystyki (rys. 2.37) ───────────────────────

async function count(table: any, where?: any): Promise<number> {
  const q = db.select({ n: sql<number>`count(*)` }).from(table);
  const r = await (where ? q.where(where) : q);
  return r[0]?.n ?? 0;
}

async function computeStats() {
  const now = Date.now();
  const day = new Date(now - 24 * 3600 * 1000);
  const week = new Date(now - 7 * 24 * 3600 * 1000);
  const month = new Date(now - 30 * 24 * 3600 * 1000);

  const activeUsers = (await db.select({ n: sql<number>`count(distinct ${session.userId})` })
    .from(session).where(gte(session.updatedAt, month)))[0]?.n ?? 0;

  return {
    visitsLast24h:          await count(visitLog, gte(visitLog.visitedAt, day)),
    visitsLastWeek:         await count(visitLog, gte(visitLog.visitedAt, week)),
    activeUsers,                                                   // użytkownicy z sesją w ostatnich 30 dniach
    registrationsLast30Days: await count(user, and(gte(user.createdAt, month), eq(user.isDeletedUser, false))),
    activeBans:             await count(userBan, and(isNull(userBan.revokedAt), or(isNull(userBan.expiresAt), gt(userBan.expiresAt, new Date())))),
    totalBans:              await count(userBan),
    publishedReviews:       await count(review, eq(review.status, "published")),
    pendingReviews:         await count(review, eq(review.status, "pending")),
    databaseSubmissions:    await count(camera),
    pendingSubmissions:     await count(camera, eq(camera.status, "pending")),
    phonesInDatabase:       await count(smartphone),
  };
}

adminRouter.get("/stats", async (c) => c.json(await computeStats()));

/**
 * Wszystko, czego potrzebuje ekran "Content management" + "Engagement statistics":
 * 5 najnowszych recenzji do weryfikacji, ostatnie blokady i ukryte recenzje (tylko administrator) oraz statystyki.
 */
adminRouter.get("/dashboard", async (c) => {
  const actingUser = c.get("user");
  const isAdmin = hasRole(actingUser.role, "admin");

  const brief = async (status: "pending" | "hidden") =>
    (await db.select({ id: review.id, title: review.title, authorId: review.authorId, authorName: user.name, updatedAt: review.updatedAt })
      .from(review).innerJoin(user, eq(review.authorId, user.id))
      .where(eq(review.status, status)).orderBy(desc(review.updatedAt)).limit(5));

  return c.json({
    reviewSubmissions: await brief("pending"),
    recentBans:        isAdmin ? await recentBans(5) : null,
    hiddenReviews:     isAdmin ? await brief("hidden") : null,
    stats:             await computeStats(),
  });
});

// Usunięcie konta przez administratora: anonimizacja profilu + usunięcie recenzji użytkownika.
adminRouter.delete("/users/:id", requireRole("admin"), async (c) => {
  const id = c.req.param("id") as string;
  const deleted = await deleteUserAccount(id, "admin");
  if (!deleted) return fail(c, 404, "USER_NOT_FOUND", "User not found");
  return c.json({ ok: true });
});

adminRouter.get("/media/pending", async (c) => {
  const pendingPhotos = await db.select().from(photo).where(eq(photo.status, "pending"));
  const pendingVideos = await db.select().from(video).where(eq(video.status, "pending"));
  return c.json({
    // niezweryfikowane pliki są prywatne: moderator dostaje podpisane, godzinne linki
    photos: pendingPhotos.map((p) => ({ ...p, url: mediaUrl(p.storageUrl, false) })),
    videos: pendingVideos.map((v) => ({ ...v, url: mediaUrl(v.storageUrl, false) })),
  });
});

// "deleted" oznacza trwałe usunięcie pliku z MinIO (wiersz zostaje w bazie ze statusem "deleted").
adminRouter.patch("/media/photos/:id", async (c) => {
  const id = c.req.param("id") as string;
  const body = await c.req.json<{ status: "verified" | "deleted" }>().catch(() => null);
  if (!body || !["verified", "deleted"].includes(body.status)) {
    return fail(c, 400, "INVALID_STATUS", "status must be verified or deleted");
  }

  const current = (await db.select().from(photo).where(eq(photo.id, id)))[0];
  if (!current) return fail(c, 404, "NOT_FOUND", "Not found");
  if (current.status === "deleted") {
    return fail(c, 409, "MEDIA_ALREADY_DELETED", "This photo has already been deleted");
  }

  if (body.status === "deleted") {
    try {
      await deleteStoredObject(current.storageUrl);
    } catch (err) {
      console.error("[media] failed to delete photo from storage:", err);
      return fail(c, 502, "STORAGE_ERROR", "Could not delete the file from storage");
    }
  }

  if (body.status === "verified") {
    // zweryfikowany plik staje się publiczny (przenosimy z katalogu prywatnego)
    const parsed = parseStorageUrl(current.storageUrl);
    if (parsed) {
      try {
        await setVisibility(parsed.bucket, parsed.key, "public");
      } catch (err) {
        console.error("[media] failed to publish photo:", err);
        return fail(c, 502, "STORAGE_ERROR", "Could not publish the file");
      }
    }
  }

  await db.update(photo).set({ status: body.status }).where(eq(photo.id, id));
  return c.json({ ok: true });
});

adminRouter.patch("/media/videos/:id", async (c) => {
  const id = c.req.param("id") as string;
  const body = await c.req.json<{ status: "verified" | "deleted" }>().catch(() => null);
  if (!body || !["verified", "deleted"].includes(body.status)) {
    return fail(c, 400, "INVALID_STATUS", "status must be verified or deleted");
  }

  const current = (await db.select().from(video).where(eq(video.id, id)))[0];
  if (!current) return fail(c, 404, "NOT_FOUND", "Not found");
  if (current.status === "deleted") {
    return fail(c, 409, "MEDIA_ALREADY_DELETED", "This video has already been deleted");
  }

  if (body.status === "deleted") {
    try {
      await deleteStoredObject(current.storageUrl);
    } catch (err) {
      console.error("[media] failed to delete video from storage:", err);
      return fail(c, 502, "STORAGE_ERROR", "Could not delete the file from storage");
    }
  }

  if (body.status === "verified") {
    // zweryfikowany plik staje się publiczny (przenosimy z katalogu prywatnego)
    const parsed = parseStorageUrl(current.storageUrl);
    if (parsed) {
      try {
        await setVisibility(parsed.bucket, parsed.key, "public");
      } catch (err) {
        console.error("[media] failed to publish video:", err);
        return fail(c, 502, "STORAGE_ERROR", "Could not publish the file");
      }
    }
  }

  await db.update(video).set({ status: body.status }).where(eq(video.id, id));
  return c.json({ ok: true });
});

// Edycja metadanych zdjęcia przez moderatora (ogniskowa, przysłona, ISO, migawka, użyty aparat).
adminRouter.patch("/media/photos/:id/metadata", async (c) => {
  const id = c.req.param("id") as string;
  const body = await c.req.json<{
    cameraId?: string;
    exifFocalLength?: number | null;
    exifAperture?: number | null;
    exifIso?: number | null;
    exifShutterSpeed?: number | null;
    widthPx?: number;
    heightPx?: number;
  }>().catch(() => null);
  if (!body) return fail(c, 400, "INVALID_BODY", "Request body must be valid JSON");

  const current = (await db.select({ id: photo.id }).from(photo).where(eq(photo.id, id)))[0];
  if (!current) return fail(c, 404, "NOT_FOUND", "Not found");

  const updates: Partial<typeof photo.$inferInsert> = {};

  for (const key of ["exifFocalLength", "exifAperture", "exifIso", "exifShutterSpeed"] as const) {
    if (!(key in body)) continue;
    const v = body[key];
    if (v !== null && v !== undefined && !isPositiveNumber(v)) {
      return fail(c, 400, "INVALID_FIELD", `${key} must be a positive number or null`);
    }
    updates[key] = v ?? null;
  }
  for (const key of ["widthPx", "heightPx"] as const) {
    if (body[key] === undefined) continue;
    if (!isPositiveInt(body[key])) return fail(c, 400, "INVALID_FIELD", `${key} must be a positive integer`);
    updates[key] = body[key];
  }
  if (body.cameraId !== undefined) {
    const cam = (await db.select({ id: camera.id }).from(camera).where(eq(camera.id, body.cameraId)))[0];
    if (!cam) return fail(c, 404, "CAMERA_NOT_FOUND", "Camera not found");
    updates.cameraId = body.cameraId;
  }

  if (Object.keys(updates).length === 0) {
    return fail(c, 400, "NOTHING_TO_UPDATE", "Provide at least one field to update");
  }

  await db.update(photo).set(updates).where(eq(photo.id, id));
  return c.json({ ok: true });
});

// Edycja metadanych wideo przez moderatora (rozdzielczość, fps, użyty aparat).
adminRouter.patch("/media/videos/:id/metadata", async (c) => {
  const id = c.req.param("id") as string;
  const body = await c.req.json<{
    cameraId?: string;
    widthPx?: number;
    heightPx?: number;
    fps?: number;
  }>().catch(() => null);
  if (!body) return fail(c, 400, "INVALID_BODY", "Request body must be valid JSON");

  const current = (await db.select({ id: video.id }).from(video).where(eq(video.id, id)))[0];
  if (!current) return fail(c, 404, "NOT_FOUND", "Not found");

  const updates: Partial<typeof video.$inferInsert> = {};

  for (const key of ["widthPx", "heightPx"] as const) {
    if (body[key] === undefined) continue;
    if (!isPositiveInt(body[key])) return fail(c, 400, "INVALID_FIELD", `${key} must be a positive integer`);
    updates[key] = body[key];
  }
  if (body.fps !== undefined) {
    if (!isPositiveNumber(body.fps)) return fail(c, 400, "INVALID_FIELD", "fps must be a positive number");
    updates.fps = body.fps;
  }
  if (body.cameraId !== undefined) {
    const cam = (await db.select({ id: camera.id }).from(camera).where(eq(camera.id, body.cameraId)))[0];
    if (!cam) return fail(c, 404, "CAMERA_NOT_FOUND", "Camera not found");
    updates.cameraId = body.cameraId;
  }

  if (Object.keys(updates).length === 0) {
    return fail(c, 400, "NOTHING_TO_UPDATE", "Provide at least one field to update");
  }

  await db.update(video).set(updates).where(eq(video.id, id));
  return c.json({ ok: true });
});

adminRouter.get("/role-log", requireRole("admin"), async (c) => {
  const rows = await db.select().from(roleChangeLog);
  return c.json(rows);
});

export { adminRouter };
