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

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[server] MobileLens API running on http://localhost:${info.port}`);
  console.log(`[server] NODE_ENV=${process.env["NODE_ENV"] ?? "development"}`);
  if (allowedOrigins.length === 0) {
    console.warn("[server] ALLOWED_ORIGINS is empty - no browser origin will be allowed cross-site");
  } else {
    console.log(`[server] ALLOWED_ORIGINS=${allowedOrigins.join(", ")}`);
  }
});
