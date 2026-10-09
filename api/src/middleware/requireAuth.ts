import type { Context, Next } from "hono";
import { auth } from "../lib/auth.js";
import { fail } from "../lib/errors.js";
import { getActiveBan } from "../lib/bans.js";
import type { HonoVariables, Role } from "../types/honoTypes.js";

export type { Role };

type Ctx = Context<{ Variables: HonoVariables }>;

const ROLE_RANK: Record<Role, number> = {
  user: 0,
  reviewer: 1,
  moderator: 2,
  admin: 3,
};

export function hasRole(role: string | null | undefined, minRole: Role): boolean {
  const rank = ROLE_RANK[(role as Role | undefined) ?? "user"] ?? 0;
  return rank >= ROLE_RANK[minRole];
}

/** Wczytuje sesję; zwraca Response z błędem (401 / 403 USER_BANNED) albo null, gdy wszystko w porządku. */
async function authenticate(c: Ctx): Promise<Response | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return fail(c, 401, "UNAUTHORIZED", "Unauthorized");

  const ban = await getActiveBan(session.user.id);
  if (ban) {
    return fail(c, 403, "USER_BANNED", "Your account has been banned", {
      reason: ban.reason,
      expiresAt: ban.expiresAt ? ban.expiresAt.toISOString() : null,
    });
  }

  c.set("session", session.session);
  c.set("user", session.user as HonoVariables["user"]);
  return null;
}

export async function requireAuth(c: Ctx, next: Next) {
  const denied = await authenticate(c);
  if (denied) return denied;
  await next();
}

export function requireRole(minRole: Role) {
  return async (c: Ctx, next: Next) => {
    const denied = await authenticate(c);
    if (denied) return denied;
    const userRole = (c.get("user") as Record<string, unknown>)["role"] as string | undefined;
    if (!hasRole(userRole, minRole)) return fail(c, 403, "FORBIDDEN", "Forbidden");
    await next();
  };
}

/** Opcjonalna sesja (np. publiczne GET-y, które dla zalogowanych dodają `likedByMe`). Zbanowany = anonim. */
export async function optionalUser(c: Ctx): Promise<HonoVariables["user"] | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  if (await getActiveBan(session.user.id)) return null;
  return session.user as HonoVariables["user"];
}
