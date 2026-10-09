import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { userBan } from "../db/schema.js";

/** Aktywna blokada: nie cofnięta i (bezterminowa albo jeszcze nie wygasła). */
export async function getActiveBan(userId: string) {
  const rows = await db.select().from(userBan)
    .where(and(
      eq(userBan.userId, userId),
      isNull(userBan.revokedAt),
      or(isNull(userBan.expiresAt), gt(userBan.expiresAt, new Date())),
    ))
    .limit(1);
  return rows[0] ?? null;
}
