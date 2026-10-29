import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import {
  authRouter, brandsRouter, smartphonesRouter, camerasRouter,
  uploadRouter, reviewsRouter, favoritesRouter, adminRouter, accountRouter,
  notificationsRouter, statsRouter, mediaRouter,
} from "./routes/index.js";
import { fail } from "./lib/errors.js";
import { ensureStorageDirs } from "./lib/storage.js";

import { startAggregationScheduler } from "./services/cameraAggregation.js";
import { startVariantBackfill } from "./services/mediaVariants.js";
import { db, optimizeDatabase } from "./db/index.js";
import { camera } from "./db/schema.js";
import { sensorDenominatorOf } from "./lib/cameraSpec.js";
import { and, eq, isNotNull, isNull } from "drizzle-orm";

const app = new Hono();



app.use("*", logger());


const allowedOrigins = (process.env["ALLOWED_ORIGINS"] ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use("*", cors({
  origin: (origin) => (origin && allowedOrigins.includes(origin) ? origin : ""),
  allowHeaders: ["Authorization", "Content-Type", "Accept-Language"],
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  credentials: true,
}));


// Odpowiedzi API bez własnych ustawień cache (dane zależne od zalogowanego użytkownika) nie mogą
// trafić do wspólnego cache: tylko prywatny cache z potwierdzeniem przy każdym użyciu.
app.use("/api/*", async (c, next) => {
  await next();
  if (c.req.method === "GET" && !c.res.headers.has("Cache-Control")) {
    c.header("Cache-Control", "private, no-cache");
    c.header("Vary", "Authorization", { append: true });
  }
});


app.get("/health", (c) => c.json({ status: "ok", ts: new Date().toISOString() }));


app.route("/api/auth",        authRouter);
app.route("/api/brands",      brandsRouter);
app.route("/api/smartphones", smartphonesRouter);
app.route("/api/cameras",     camerasRouter);
app.route("/api/upload",      uploadRouter);
app.route("/api/reviews",     reviewsRouter);
app.route("/api/favorites",   favoritesRouter);
app.route("/api/admin",       adminRouter);
app.route("/api/account",     accountRouter);
app.route("/api/notifications", notificationsRouter);
app.route("/api/stats",       statsRouter);
app.route("/api/media",       mediaRouter);



app.notFound((c) => fail(c, 404, "NOT_FOUND", "Not found"));

app.onError((err, c) => {
  console.error("[error]", err);
  return fail(c, 500, "INTERNAL_ERROR", "Internal server error");
});


// Automatyczna agregacja zgłoszeń (konsensus) jest domyślnie WYŁĄCZONA: zgodnie z procesem z pracy
// (BPMN 2.4) każde zgłoszenie rozpatruje moderator. Włącz ją świadomie przez AUTO_AGGREGATION=true.
if (process.env["AUTO_AGGREGATION"] === "true") {
  startAggregationScheduler();
  console.log("[server] AUTO_AGGREGATION is on - consensus aggregation is running");
}

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);

await ensureStorageDirs();

// Rozmiar matrycy jako liczba (do filtrów) dla aparatów zapisanych przed dodaniem tej kolumny.
for (const r of db.select({ id: camera.id, f: camera.sensorFormat }).from(camera)
  .where(and(isNotNull(camera.sensorFormat), isNull(camera.sensorDenominator))).all()) {
  const d = sensorDenominatorOf(r.f);
  if (d !== null) db.update(camera).set({ sensorDenominator: d }).where(eq(camera.id, r.id)).run();
}

// Statystyki dla planisty zapytań SQLite: przy starcie i raz na dobę.
optimizeDatabase();
setInterval(optimizeDatabase, 24 * 3600 * 1000).unref();

// Miniatury dla zdjęć wgranych przed tą wersją (w tle, po jednym pliku).
startVariantBackfill(Number(process.env["VARIANT_BACKFILL_DELAY_MS"] ?? 15_000));

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[server] MobileLens API running on http://localhost:${info.port}`);
  console.log(`[server] NODE_ENV=${process.env["NODE_ENV"] ?? "development"}`);
  if (allowedOrigins.length === 0) {
    console.warn("[server] ALLOWED_ORIGINS is empty - no browser origin will be allowed cross-site");
  } else {
    console.log(`[server] ALLOWED_ORIGINS=${allowedOrigins.join(", ")}`);
  }
});
