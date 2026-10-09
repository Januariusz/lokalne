import { Hono } from "hono";
import { createHash } from "node:crypto";
import { db } from "../db/index.js";
import { visitLog } from "../db/schema.js";
import { lt } from "drizzle-orm";

/**
 * Statystyki odwiedzin do panelu administratora. Klient (web/mobile) woła POST /api/stats/visit
 * raz przy starcie sesji/aplikacji. Zapisujemy tylko skrót (hash) IP + User-Agent + sekretu,
 * a ten sam odwiedzający liczy się najwyżej raz na 30 minut.
 */
const statsRouter = new Hono();

const DEDUPE_MS = 30 * 60 * 1000;
const RETENTION_MS = 90 * 24 * 3600 * 1000;
const recent = new Map<string, number>();
const SALT = process.env["BETTER_AUTH_SECRET"] ?? "dev-only-insecure-secret";

setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of recent) if (now - ts > DEDUPE_MS) recent.delete(k);
}, 10 * 60 * 1000).unref();

// dane starsze niż 90 dni nie są potrzebne do statystyk 24h / tydzień
setInterval(() => {
  db.delete(visitLog).where(lt(visitLog.visitedAt, new Date(Date.now() - RETENTION_MS))).run();
}, 24 * 3600 * 1000).unref();

statsRouter.post("/visit", async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const ua = c.req.header("user-agent") ?? "";
  const hash = createHash("sha256").update(`${ip}|${ua}|${SALT}`).digest("hex").slice(0, 32);

  const now = Date.now();
  const last = recent.get(hash);
  if (last && now - last < DEDUPE_MS) return c.json({ counted: false });

  recent.set(hash, now);
  await db.insert(visitLog).values({ visitedAt: new Date(now), visitorHash: hash });
  return c.json({ counted: true });
});

export { statsRouter };
