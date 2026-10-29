import { Hono, type Context } from "hono";
import { etag } from "hono/etag";
import { db } from "../db/index.js";
import { review, reviewMedia, reviewComment, reviewLike, smartphone, user } from "../db/schema.js";
import { eq, and, desc, asc, inArray, sql, type SQL } from "drizzle-orm";
import { requireAuth, requireRole, hasRole, optionalUser } from "../middleware/requireAuth.js";
import {
  storageUrl, objectExists, mediaUrl, deleteStoredObject, setVisibility, parseStorageUrl, BUCKETS, variantUrl,
} from "../lib/storage.js";
import { phoneSummaries } from "../services/phones.js";
import { fail } from "../lib/errors.js";
import { notify } from "../lib/notifications.js";
import type { HonoVariables } from "../types/honoTypes.js";
import { randomUUID } from "node:crypto";

const reviewsRouter = new Hono<{ Variables: HonoVariables }>();

const REVIEW_STATUSES = ["draft", "pending", "published", "hidden"] as const;
type ReviewStatus = (typeof REVIEW_STATUSES)[number];

const COMMENT_MAX = 2000;

/** Media recenzji są publiczne tylko, gdy recenzja jest opublikowana; w pozostałych stanach leżą w katalogu prywatnym. */
async function syncMediaVisibility(reviewId: string, status: ReviewStatus) {
  const media = await db.select({ storageUrl: reviewMedia.storageUrl })
    .from(reviewMedia).where(eq(reviewMedia.reviewId, reviewId));
  for (const m of media) {
    const p = parseStorageUrl(m.storageUrl);
    if (!p) continue;
    try {
      await setVisibility(p.bucket, p.key, status === "published" ? "public" : "private");
    } catch (err) {
      console.error("[review-media] visibility change failed:", err);
    }
  }
}

type ReviewRow = typeof review.$inferSelect;

/** Tekst recenzji bez znaczników Markdown, skrócony do ok. 200 znaków (podgląd na liście). */
export function markdownExcerpt(md: string, max = 200): string {
  const text = md
    .replace(/```[\s\S]*?```/g, " ")              // bloki kodu
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")        // obrazy
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")      // linki -> sam tekst
    .replace(/<[^>]+>/g, " ")                      // HTML
    .replace(/`([^`]*)`/g, "$1")                   // kod w linii
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "") // nagłówki, cytaty, listy
    .replace(/(\*\*|__|\*|_|~~)/g, "")              // pogrubienia, kursywa, przekreślenia
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

type DecorateOpts = { summary?: boolean };

/**
 * Dokłada autora, telefon (nazwa, marka, zdjęcie), liczniki lajków/komentarzy, flagę likedByMe
 * i media (z właściwymi linkami i miniaturami). Tryb `summary`: zamiast pełnej treści i mediów
 * zwraca excerpt, coverUrl i mediaCount (lista recenzji nie potrzebuje całego tekstu).
 */
async function decorate(rows: ReviewRow[], viewerId: string | null, opts: DecorateOpts = {}) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const authors = new Map(
    (await db.select({ id: user.id, name: user.name }).from(user)
      .where(inArray(user.id, [...new Set(rows.map((r) => r.authorId))]))).map((u) => [u.id, u.name]),
  );
  const likes = new Map(
    (await db.select({ id: reviewLike.reviewId, n: sql<number>`count(*)` }).from(reviewLike)
      .where(inArray(reviewLike.reviewId, ids)).groupBy(reviewLike.reviewId)).map((r) => [r.id, r.n]),
  );
  const comments = new Map(
    (await db.select({ id: reviewComment.reviewId, n: sql<number>`count(*)` }).from(reviewComment)
      .where(inArray(reviewComment.reviewId, ids)).groupBy(reviewComment.reviewId)).map((r) => [r.id, r.n]),
  );
  const liked = new Set(
    viewerId
      ? (await db.select({ id: reviewLike.reviewId }).from(reviewLike)
          .where(and(eq(reviewLike.userId, viewerId), inArray(reviewLike.reviewId, ids)))).map((r) => r.id)
      : [],
  );
  const media = await db.select().from(reviewMedia).where(inArray(reviewMedia.reviewId, ids));
  const phones = await phoneSummaries(rows.map((r) => r.smartphoneId));

  return rows.map((r) => {
    const isPublic = r.status === "published";
    const items = media.filter((m) => m.reviewId === r.id)
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map((m) => ({
        ...m,
        url: mediaUrl(m.storageUrl, isPublic),
        thumbUrl: m.type === "photo" ? variantUrl(m.storageUrl, "w480", isPublic) : null,
      }));
    const base = {
      ...r,
      authorName:   authors.get(r.authorId) ?? null,
      likeCount:    likes.get(r.id) ?? 0,
      commentCount: comments.get(r.id) ?? 0,
      likedByMe:    liked.has(r.id),
      phone:        phones.get(r.smartphoneId) ?? null,
    };
    if (!opts.summary) return { ...base, media: items };
    const { contentMarkdown, ...rest } = base;
    const cover = items.find((m) => m.type === "photo");
    return {
      ...rest,
      excerpt:    markdownExcerpt(contentMarkdown),
      coverUrl:   cover ? (cover.thumbUrl ?? cover.url) : null,
      mediaCount: items.length,
    };
  });
}

type Ctx = Context<{ Variables: HonoVariables }>;

/**
 * Wspólna obsługa list recenzji:
 *   summary=1        - bez pełnej treści i mediów (excerpt, coverUrl, mediaCount)
 *   page / limit     - stronicowanie (limit domyślnie 20, maks. 50); gdy podany którykolwiek,
 *                      odpowiedź ma postać { data, page, limit, total }, inaczej zwykła tablica
 */
async function reviewList(c: Ctx, where: SQL, order: SQL[], viewerId: string | null) {
  const summary = c.req.query("summary") === "1" || c.req.query("summary") === "true";
  const paged = c.req.query("page") !== undefined || c.req.query("limit") !== undefined;
  const pageRaw = parseInt(c.req.query("page") ?? "1", 10);
  const limitRaw = parseInt(c.req.query("limit") ?? "20", 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, limitRaw)) : 20;

  let q = db.select().from(review).where(where).orderBy(...order).$dynamic();
  if (paged) q = q.limit(limit).offset((page - 1) * limit);
  const rows = await q;
  const data = await decorate(rows, viewerId, { summary });
  if (!paged) return c.json(data);
  const total = (await db.select({ n: sql<number>`count(*)` }).from(review).where(where))[0]?.n ?? 0;
  return c.json({ data, page, limit, total });
}

// Dane zależne od oglądającego (likedByMe, prywatne recenzje): tylko prywatny cache z potwierdzeniem.
// ETag pozwala odpowiedzieć 304, gdy nic się nie zmieniło (liczony z treści, więc obejmuje też lajki).
reviewsRouter.use("*", async (c, next) => {
  await next();
  if (c.req.method === "GET") {
    c.header("Cache-Control", "private, no-cache");
    c.header("Vary", "Authorization", { append: true });
  }
});
reviewsRouter.get("*", etag({ weak: true }));

function canSeeUnpublished(u: { id: string; role?: string } | null, row: ReviewRow): boolean {
  if (!u) return false;
  if (u.id === row.authorId || hasRole(u.role, "admin")) return true;
  // moderatorzy widzą recenzje czekające na weryfikację; ukryte tylko administrator i autor
  return hasRole(u.role, "moderator") && row.status === "pending";
}

// Dashboard moderatora: recenzje czekające na weryfikację.
reviewsRouter.get("/pending", requireRole("moderator"), async (c) =>
  reviewList(c, eq(review.status, "pending"), [asc(review.updatedAt), asc(review.id)], c.get("user").id));

// Panel administratora: ukryte recenzje ("Hidden reviews").
reviewsRouter.get("/hidden", requireRole("admin"), async (c) =>
  reviewList(c, eq(review.status, "hidden"), [desc(review.updatedAt), desc(review.id)], c.get("user").id));

// Własne recenzje autora (wszystkie statusy), np. do ekranu edycji.
reviewsRouter.get("/mine", requireAuth, async (c) => {
  const u = c.get("user");
  return reviewList(c, eq(review.authorId, u.id), [desc(review.updatedAt), desc(review.id)], u.id);
});

reviewsRouter.get("/", async (c) => {
  const smartphoneId = c.req.query("smartphone_id");
  if (!smartphoneId) return fail(c, 400, "SMARTPHONE_ID_REQUIRED", "smartphone_id is required");

  const viewer = await optionalUser(c);
  return reviewList(c, and(eq(review.smartphoneId, smartphoneId), eq(review.status, "published"))!,
    [desc(review.updatedAt), desc(review.id)], viewer?.id ?? null);
});

// Komentarz usuwa autor komentarza albo administrator.
reviewsRouter.delete("/comments/:commentId", requireAuth, async (c) => {
  const u = c.get("user");
  const commentId = c.req.param("commentId") as string;
  const row = (await db.select().from(reviewComment).where(eq(reviewComment.id, commentId)))[0];
  if (!row) return fail(c, 404, "COMMENT_NOT_FOUND", "Comment not found");
  if (row.authorId !== u.id && !hasRole(u.role, "admin")) return fail(c, 403, "FORBIDDEN", "Forbidden");
  await db.delete(reviewComment).where(eq(reviewComment.id, commentId));
  return c.json({ ok: true });
});

reviewsRouter.get("/:id", async (c) => {
  const id = c.req.param("id") as string;
  const row = (await db.select().from(review).where(eq(review.id, id)))[0];
  if (!row) return fail(c, 404, "NOT_FOUND", "Not found");

  const viewer = await optionalUser(c);
  if (row.status !== "published" && !canSeeUnpublished(viewer, row)) {
    return fail(c, 404, "NOT_FOUND", "Not found");
  }

  const item = (await decorate([row], viewer?.id ?? null))[0]!;
  // ?include=comments&comment_limit=20 - pierwsza strona komentarzy w tej samej odpowiedzi
  if (c.req.query("include") === "comments" && row.status === "published") {
    const lim = parseInt(c.req.query("comment_limit") ?? "20", 10);
    const limit = Number.isFinite(lim) ? Math.min(100, Math.max(1, lim)) : 20;
    return c.json({ ...item, comments: await commentPage(id, 1, limit) });
  }
  return c.json(item);
});

// ── Komentarze ───────────────────────────────────────────────────────────────

reviewsRouter.get("/:id/comments", async (c) => {
  const id = c.req.param("id") as string;
  const row = (await db.select({ status: review.status }).from(review).where(eq(review.id, id)))[0];
  if (!row || row.status !== "published") return fail(c, 404, "REVIEW_NOT_FOUND", "Review not found");

  const pageRaw  = parseInt(c.req.query("page")  ?? "1",  10);
  const limitRaw = parseInt(c.req.query("limit") ?? "50", 10);
  const page  = Number.isFinite(pageRaw)  ? Math.max(1, pageRaw) : 1;
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : 50;

  return c.json(await commentPage(id, page, limit));
});

/** Strona komentarzy recenzji (od najstarszych) z łączną liczbą. */
async function commentPage(reviewId: string, page: number, limit: number) {
  const rows = await db
    .select({
      id: reviewComment.id, reviewId: reviewComment.reviewId, authorId: reviewComment.authorId,
      authorName: user.name, content: reviewComment.content, createdAt: reviewComment.createdAt,
    })
    .from(reviewComment)
    .innerJoin(user, eq(reviewComment.authorId, user.id))
    .where(eq(reviewComment.reviewId, reviewId))
    .orderBy(asc(reviewComment.createdAt), asc(reviewComment.id))
    .limit(limit).offset((page - 1) * limit);
  const total = (await db.select({ n: sql<number>`count(*)` }).from(reviewComment)
    .where(eq(reviewComment.reviewId, reviewId)))[0]?.n ?? 0;
  return { data: rows, page, limit, total };
}

reviewsRouter.post("/:id/comments", requireAuth, async (c) => {
  const u = c.get("user");
  const id = c.req.param("id") as string;

  const row = (await db.select({ status: review.status }).from(review).where(eq(review.id, id)))[0];
  if (!row) return fail(c, 404, "REVIEW_NOT_FOUND", "Review not found");
  if (row.status !== "published") return fail(c, 409, "REVIEW_NOT_PUBLISHED", "Review is not published");

  const body = await c.req.json<{ content?: unknown }>().catch(() => null);
  const content = typeof body?.content === "string" ? body.content.trim() : "";
  if (!content || content.length > COMMENT_MAX) {
    return fail(c, 400, "INVALID_FIELD", `content must have 1-${COMMENT_MAX} characters`, { field: "content" });
  }

  const comment = { id: randomUUID(), reviewId: id, authorId: u.id, content, createdAt: new Date() };
  await db.insert(reviewComment).values(comment);
  return c.json({ ...comment, authorName: u.name }, 201);
});

// ── Polubienia ───────────────────────────────────────────────────────────────

async function likeCount(reviewId: string): Promise<number> {
  const r = await db.select({ n: sql<number>`count(*)` }).from(reviewLike).where(eq(reviewLike.reviewId, reviewId));
  return r[0]?.n ?? 0;
}

reviewsRouter.post("/:id/like", requireAuth, async (c) => {
  const u = c.get("user");
  const id = c.req.param("id") as string;
  const row = (await db.select({ status: review.status }).from(review).where(eq(review.id, id)))[0];
  if (!row) return fail(c, 404, "REVIEW_NOT_FOUND", "Review not found");
  if (row.status !== "published") return fail(c, 409, "REVIEW_NOT_PUBLISHED", "Review is not published");

  await db.insert(reviewLike).values({ userId: u.id, reviewId: id, createdAt: new Date() }).onConflictDoNothing();
  return c.json({ liked: true, likeCount: await likeCount(id) });
});

reviewsRouter.delete("/:id/like", requireAuth, async (c) => {
  const u = c.get("user");
  const id = c.req.param("id") as string;
  await db.delete(reviewLike).where(and(eq(reviewLike.userId, u.id), eq(reviewLike.reviewId, id)));
  return c.json({ liked: false, likeCount: await likeCount(id) });
});

// ── Tworzenie / edycja / usuwanie ────────────────────────────────────────────

/**
 * Każdy zalogowany użytkownik może napisać recenzję:
 *  - zwykły użytkownik: recenzja trafia do weryfikacji (status "pending"),
 *  - reviewer / moderator / admin: recenzja jest od razu opublikowana ("published").
 */
reviewsRouter.post("/", requireAuth, async (c) => {
  const u = c.get("user");

  const body = await c.req.json<{
    smartphoneId: string;
    title: string;
    contentMarkdown: string;
    mediaItems?: Array<{ objectKey: string; type: "photo" | "video"; displayOrder: number }>;
  }>().catch(() => null);
  if (!body) return fail(c, 400, "INVALID_BODY", "Request body must be valid JSON");

  if (!body.smartphoneId || !body.title || !body.contentMarkdown) {
    return fail(c, 400, "MISSING_FIELDS", "smartphoneId, title and contentMarkdown are required");
  }

  const phone = await db.select({ id: smartphone.id }).from(smartphone)
    .where(eq(smartphone.id, body.smartphoneId));
  if (!phone[0]) return fail(c, 404, "SMARTPHONE_NOT_FOUND", "Smartphone not found");

  // Nie ufamy ślepo objectKey od klienta - sprawdzamy, że plik naprawdę jest w magazynie,
  // zanim zapiszemy na niego wskaźnik w bazie.
  if (body.mediaItems?.length) {
    for (const m of body.mediaItems) {
      if (!(await objectExists(BUCKETS.reviewMedia, m.objectKey))) {
        return fail(c, 409, "UPLOAD_NOT_FOUND", `Uploaded object not found: ${m.objectKey}`);
      }
    }
  }

  const canPublish = hasRole(u.role, "reviewer");

  const newReview = {
    id:              randomUUID(),
    authorId:        u.id,
    smartphoneId:    body.smartphoneId,
    title:           body.title.trim(),
    contentMarkdown: body.contentMarkdown,
    status:          (canPublish ? "published" : "pending") as ReviewStatus,
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
    await syncMediaVisibility(newReview.id, newReview.status);
  }

  return c.json(newReview, 201);
});

/**
 * Edycja recenzji.
 *  - treść i tytuł: tylko autor,
 *  - administrator: dowolna zmiana statusu (ukrycie "hidden", przywrócenie, publikacja),
 *  - moderator (nie autor): zatwierdza recenzję czekającą na weryfikację ("pending" -> "published")
 *    albo zwraca ją autorowi ("pending" -> "draft"); nie może ukrywać ani usuwać recenzji,
 *  - autor (reviewer+): może przełączać draft / pending / published, ale nie może
 *    sam odkryć recenzji ukrytej przez administratora,
 *  - autor (zwykły użytkownik): draft / pending; edycja treści opublikowanej
 *    recenzji cofa ją do weryfikacji,
 *  - autor ukrytej recenzji może ją zgłosić ponownie ("pending") - odwołanie.
 * Autor dostaje powiadomienie, gdy status zmienia ktoś inny.
 */
reviewsRouter.patch("/:id", requireAuth, async (c) => {
  const u = c.get("user");

  const id = c.req.param("id") as string;
  const rows = await db.select().from(review).where(eq(review.id, id));
  if (!rows[0]) return fail(c, 404, "NOT_FOUND", "Not found");

  const current = rows[0];
  const isAdmin = hasRole(u.role, "admin");
  const isMod   = hasRole(u.role, "moderator");
  const isOwner = u.id === current.authorId;
  if (!isMod && !isOwner) return fail(c, 403, "FORBIDDEN", "Forbidden");

  const body = await c.req.json<{
    title?: string;
    contentMarkdown?: string;
    status?: ReviewStatus;
  }>().catch(() => null);
  if (!body) return fail(c, 400, "INVALID_BODY", "Request body must be valid JSON");

  if (body.status !== undefined && !(REVIEW_STATUSES as readonly string[]).includes(body.status)) {
    return fail(c, 400, "INVALID_STATUS", `status must be one of: ${REVIEW_STATUSES.join(", ")}`);
  }
  if ((body.title || body.contentMarkdown) && !isOwner) {
    return fail(c, 403, "FORBIDDEN", "Only the author can edit the review text");
  }

  const updates: Partial<typeof review.$inferInsert> = { updatedAt: new Date() };
  if (body.title)           updates.title           = body.title.trim();
  if (body.contentMarkdown) updates.contentMarkdown = body.contentMarkdown;

  if (isAdmin) {
    if (body.status) updates.status = body.status;
  } else if (isOwner) {
    const canPublish = hasRole(u.role, "reviewer");

    if (body.status !== undefined) {
      const s = body.status;
      const allowed =
          s === "draft"     ? current.status !== "hidden"
        : s === "pending"   ? true
        : s === "published" ? canPublish && current.status !== "hidden"
        :                     false;
      if (!allowed) return fail(c, 403, "STATUS_NOT_ALLOWED", "You cannot set this status");
      updates.status = s;
    } else if ((body.title || body.contentMarkdown) && current.status === "published" && !canPublish) {
      updates.status = "pending";
    }
  } else if (body.status !== undefined) {
    // moderator, który nie jest autorem
    const allowed = current.status === "pending" && (body.status === "published" || body.status === "draft");
    if (!allowed) return fail(c, 403, "STATUS_NOT_ALLOWED", "You cannot set this status");
    updates.status = body.status;
  }

  await db.update(review).set(updates).where(eq(review.id, id));

  const finalStatus = (updates.status ?? current.status) as ReviewStatus;
  if (finalStatus !== current.status) {
    await syncMediaVisibility(id, finalStatus);
    if (!isOwner) await notify(current.authorId, "review_status", { reviewId: id, status: finalStatus });
  }
  return c.json({ ok: true, status: finalStatus });
});

// Usuwa autor albo administrator (moderator nie usuwa cudzych recenzji).
reviewsRouter.delete("/:id", requireAuth, async (c) => {
  const u = c.get("user");

  const id = c.req.param("id") as string;
  const rows = await db.select().from(review).where(eq(review.id, id));
  if (!rows[0]) return fail(c, 404, "NOT_FOUND", "Not found");

  if (!hasRole(u.role, "admin") && u.id !== rows[0].authorId) return fail(c, 403, "FORBIDDEN", "Forbidden");

  const media = await db.select({ storageUrl: reviewMedia.storageUrl })
    .from(reviewMedia).where(eq(reviewMedia.reviewId, id));

  await db.delete(review).where(eq(review.id, id)); // media, komentarze i lajki usuwają się kaskadowo

  // Pliki recenzji znikają z dysku; błąd sprzątania nie cofa usunięcia recenzji.
  const results = await Promise.allSettled(media.map((m) => deleteStoredObject(m.storageUrl)));
  for (const r of results) {
    if (r.status === "rejected") console.error("[review-delete] storage cleanup failed:", r.reason);
  }

  return c.json({ ok: true });
});

export { reviewsRouter };
