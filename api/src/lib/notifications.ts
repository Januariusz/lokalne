import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { notification } from "../db/schema.js";

/**
 * Typy powiadomień (klient wyświetla treść na podstawie `type` i `payload`):
 *  - promotion_offer    -> użytkownik dostał propozycję awansu na reviewera {offerId, offeredBy}
 *  - promotion_decision -> proponujący dostaje decyzję użytkownika {offerId, userId, decision}
 *  - camera_reviewed    -> moderator rozpatrzył zgłoszenie aparatu {cameraId, smartphoneId, status}
 *  - review_status      -> zmiana statusu recenzji przez moderację {reviewId, status}
 *  - role_changed       -> administrator zmienił rolę {previousRole, newRole}
 */
export type NotificationType =
  | "promotion_offer" | "promotion_decision" | "camera_reviewed" | "review_status" | "role_changed";

export async function notify(userId: string, type: NotificationType, payload: Record<string, unknown>) {
  try {
    await db.insert(notification).values({
      id: randomUUID(), userId, type, payload: JSON.stringify(payload), createdAt: new Date(),
    });
  } catch (err) {
    // powiadomienie nie może zablokować właściwej operacji
    console.error("[notify] failed:", err);
  }
}
