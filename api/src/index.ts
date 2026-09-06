import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import {
  authRouter, brandsRouter, smartphonesRouter, camerasRouter,
  uploadRouter, reviewsRouter, favoritesRouter, adminRouter
} from "./routes/index.js";

import { startAggregationScheduler } from "./services/cameraAggregation.js";

const app = new Hono();



app.use("*", logger());


const allowedOrigins = (process.env["ALLOWED_ORIGINS"] ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use("*", cors({
  origin: (origin) => (origin && allowedOrigins.includes(origin) ? origin : ""),
  allowHeaders: ["Authorization", "Content-Type"],
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



app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  console.error("[error]", err);
  return c.json({ error: "Internal server error" }, 500);
});


startAggregationScheduler();

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[server] MobileLens API running on http://localhost:${info.port}`);
  console.log(`[server] NODE_ENV=${process.env["NODE_ENV"] ?? "development"}`);
  if (allowedOrigins.length === 0) {
    console.warn("[server] ALLOWED_ORIGINS jest puste — żaden origin przeglądarki nie zostanie dopuszczony cross-site");
  } else {
    console.log(`[server] ALLOWED_ORIGINS=${allowedOrigins.join(", ")}`);
  }
});
