import { eq, and, or, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  user, session, account, verification, favorite, review, reviewMedia, reviewComment, notification, promotionOffer,
} from "../db/schema.js";
import { deleteStoredObject } from "../lib/storage.js";

/**
 * "self"  - użytkownik usuwa własne konto: profil jest anonimizowany, a jego
 *           recenzje, komentarze i polubienia zostają przypisane do konta "Deleted Account".
 * "admin" - administrator usuwa konto za naruszenie regulaminu: dodatkowo
 *           kasowane są recenzje i komentarze użytkownika (razem z mediami recenzji);
 *           polubienia i wpisy katalogowe zostają.
 *
 * W obu trybach: sesje, konta logowania (hash hasła, tokeny), tokeny weryfikacyjne
 * i ulubione są usuwane. Wpisy katalogowe, zdjęcia/wideo i log zmian ról zostają.
 *
 * Zwraca false, gdy użytkownik nie istnieje.
 */
export async function deleteUserAccount(userId: string, mode: "self" | "admin"): Promise<boolean> {
  const target = db
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .all()[0];
  if (!target) return false;

  const mediaToRemove: string[] = [];

  // better-sqlite3 wymaga synchronicznego callbacku transakcji (bez async/await).
  db.transaction((tx) => {
    if (mode === "admin") {
      const reviewIds = tx
        .select({ id: review.id })
        .from(review)
        .where(eq(review.authorId, userId))
        .all()
        .map((r) => r.id);

      if (reviewIds.length > 0) {
        const media = tx
          .select({ storageUrl: reviewMedia.storageUrl })
          .from(reviewMedia)
          .where(inArray(reviewMedia.reviewId, reviewIds))
          .all();
        for (const m of media) mediaToRemove.push(m.storageUrl);

        // review_media znika kaskadowo (ON DELETE CASCADE)
        tx.delete(review).where(inArray(review.id, reviewIds)).run();
      }
    }

    if (mode === "admin") {
      tx.delete(reviewComment).where(eq(reviewComment.authorId, userId)).run();
    }

    tx.delete(favorite).where(eq(favorite.userId, userId)).run();
    tx.delete(notification).where(eq(notification.userId, userId)).run();
    tx.update(promotionOffer).set({ status: "cancelled", respondedAt: new Date() })
      .where(and(eq(promotionOffer.userId, userId), eq(promotionOffer.status, "pending"))).run();
    tx.delete(session).where(eq(session.userId, userId)).run();
    tx.delete(account).where(eq(account.userId, userId)).run();
    tx.delete(verification)
      .where(or(eq(verification.identifier, target.email), eq(verification.value, userId)))
      .run();

    tx.update(user)
      .set({
        name:                "Deleted Account",
        // kolumna email jest NOT NULL + UNIQUE, więc zamiast null dajemy unikalny placeholder
        email:               `deleted+${userId}@mobilelens.invalid`,
        emailVerified:       false,
        image:               null,
        username:            null,
        isDeletedUser:       true,
        passwordResetToken:  null,
        resetTokenExpiresAt: null,
        updatedAt:           new Date(),
      })
      .where(eq(user.id, userId))
      .run();
  });

  // Sprzątanie plików po zatwierdzeniu transakcji; błąd nie cofa usunięcia konta.
  const results = await Promise.allSettled(mediaToRemove.map((u) => deleteStoredObject(u)));
  for (const r of results) {
    if (r.status === "rejected") console.error("[account-deletion] storage cleanup failed:", r.reason);
  }

  return true;
}
