import { Hono } from "hono";
import { db } from "../db/index.js";
import { camera, cameraVideoMode } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireRole } from "../middleware/requireAuth.js";
import type { HonoVariables } from "../types/honoTypes.js";
import { randomUUID } from "node:crypto";

const camerasRouter = new Hono<{ Variables: HonoVariables }>();

camerasRouter.get("/", async (c) => {
  const smartphoneId = c.req.query("smartphone_id");
  if (!smartphoneId) return c.json({ error: "smartphone_id required" }, 400);

  const rows = await db.select().from(camera)
    .where(and(eq(camera.smartphoneId, smartphoneId), eq(camera.status, "approved")));

  const withModes = await Promise.all(rows.map(async (cam) => {
    const modes = await db.select().from(cameraVideoMode).where(eq(cameraVideoMode.cameraId, cam.id));
    return { ...cam, videoModes: modes };
  }));

  return c.json(withModes);
});

camerasRouter.get("/pending", requireRole("moderator"), async (c) => {
  const rows = await db.select().from(camera).where(eq(camera.status, "pending"));
  return c.json(rows);
});

camerasRouter.post("/", requireAuth, async (c) => {
  const user = c.get("user");

  const body = await c.req.json<{
    smartphoneId: string;
    type: "wide" | "ultrawide" | "tele" | "macro" | "other";
    facing: "back" | "front" | "other";
    focalLengthMm: number;
    aperture: number;
    cropFactor: number;
    pixelPitchUm: number;
    resolutionMp: number;
    activeResolutionMp: number;
    afZones?: number;
    ois?: "none" | "optical" | "sensor_shift";
    videoModes?: Array<{ widthPx: number; heightPx: number; fpsMax: number; note?: string }>;
  }>();

  if (!body.smartphoneId || !body.type || !body.facing) {
    return c.json({ error: "smartphoneId, type, facing required" }, 400);
  }

  const newCamera = {
    id:                 randomUUID(),
    smartphoneId:       body.smartphoneId,
    submitterId:        user.id,
    reviewedBy:         null as string | null,
    status:             "pending" as const,
    submittedAt:        new Date(),
    reviewedAt:         null as Date | null,
    type:               body.type,
    facing:             body.facing,
    focalLengthMm:      body.focalLengthMm,
    aperture:           body.aperture,
    cropFactor:         body.cropFactor,
    pixelPitchUm:       body.pixelPitchUm,
    resolutionMp:       body.resolutionMp,
    activeResolutionMp: body.activeResolutionMp,
    afZones:            body.afZones ?? 0,
    ois:                body.ois ?? ("none" as const),
  };

  await db.insert(camera).values(newCamera);

  if (body.videoModes?.length) {
    await db.insert(cameraVideoMode).values(
      body.videoModes.map(m => ({
        id:       randomUUID(),
        cameraId: newCamera.id,
        widthPx:  m.widthPx,
        heightPx: m.heightPx,
        fpsMax:   m.fpsMax,
        note:     m.note ?? null,
      }))
    );
  }

  return c.json(newCamera, 201);
});


camerasRouter.patch("/:id/review", requireRole("moderator"), async (c) => {
  const user = c.get("user");

  const id = c.req.param("id") as string;

  const existing = await db.select({ id: camera.id }).from(camera).where(eq(camera.id, id));
  if (!existing[0]) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{
    status: "approved" | "rejected";
    focalLengthMm?: number;
    aperture?: number;
    cropFactor?: number;
    pixelPitchUm?: number;
    resolutionMp?: number;
    activeResolutionMp?: number;
    afZones?: number;
    ois?: "none" | "optical" | "sensor_shift";
  }>();

  if (!["approved", "rejected"].includes(body.status)) {
    return c.json({ error: "status must be approved or rejected" }, 400);
  }

  const updates: Partial<typeof camera.$inferInsert> = {
    status:     body.status,
    reviewedBy: user.id,
    reviewedAt: new Date(),
  };

  if (body.status === "approved") {
    if (body.focalLengthMm !== undefined)      updates.focalLengthMm      = body.focalLengthMm;
    if (body.aperture !== undefined)            updates.aperture            = body.aperture;
    if (body.cropFactor !== undefined)          updates.cropFactor          = body.cropFactor;
    if (body.pixelPitchUm !== undefined)        updates.pixelPitchUm        = body.pixelPitchUm;
    if (body.resolutionMp !== undefined)        updates.resolutionMp        = body.resolutionMp;
    if (body.activeResolutionMp !== undefined)  updates.activeResolutionMp  = body.activeResolutionMp;
    if (body.afZones !== undefined)             updates.afZones             = body.afZones;
    if (body.ois !== undefined)                 updates.ois                 = body.ois;
  }

  await db.update(camera).set(updates).where(eq(camera.id, id));
  return c.json({ ok: true });
});

export { camerasRouter };
