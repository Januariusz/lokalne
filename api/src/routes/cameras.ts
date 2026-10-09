import { Hono } from "hono";
import { db } from "../db/index.js";
import { camera, cameraVideoMode, smartphone } from "../db/schema.js";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth, requireRole } from "../middleware/requireAuth.js";
import { fail } from "../lib/errors.js";
import { notify } from "../lib/notifications.js";
import { validateCameraSpec, validateVideoModes, sampleCoverage } from "../lib/cameraSpec.js";
import type { HonoVariables } from "../types/honoTypes.js";
import { randomUUID } from "node:crypto";

const camerasRouter = new Hono<{ Variables: HonoVariables }>();

const SPEC_KEYS = [
  "type", "facing", "focalLengthMm", "aperture", "cropFactor", "pixelPitchUm", "resolutionMp",
  "activeResolutionMp", "afZones", "ois", "variableAperture", "apertureNarrow", "opticalZoom", "focalLengthMaxMm",
] as const;

async function withSamples<T extends { id: string; variableAperture: boolean; opticalZoom: boolean }>(row: T) {
  return { ...row, samples: await sampleCoverage(row.id, row) };
}

camerasRouter.get("/", async (c) => {
  const smartphoneId = c.req.query("smartphone_id");
  if (!smartphoneId) return fail(c, 400, "SMARTPHONE_ID_REQUIRED", "smartphone_id is required");

  const rows = await db.select().from(camera)
    .where(and(eq(camera.smartphoneId, smartphoneId), eq(camera.status, "approved")));

  const withModes = await Promise.all(rows.map(async (cam) => {
    const modes = await db.select().from(cameraVideoMode).where(eq(cameraVideoMode.cameraId, cam.id));
    return { ...cam, videoModes: modes };
  }));

  return c.json(withModes);
});

// Zgłoszenia zalogowanego użytkownika wraz ze statusem rozpatrzenia (BPMN 2.4).
camerasRouter.get("/mine", requireAuth, async (c) => {
  const user = c.get("user");
  const rows = await db.select().from(camera)
    .where(eq(camera.submitterId, user.id)).orderBy(desc(camera.submittedAt));
  return c.json(await Promise.all(rows.map(withSamples)));
});

camerasRouter.get("/pending", requireRole("moderator"), async (c) => {
  const rows = await db.select().from(camera).where(eq(camera.status, "pending"))
    .orderBy(camera.submittedAt);
  return c.json(await Promise.all(rows.map(withSamples)));
});

camerasRouter.post("/", requireAuth, async (c) => {
  const user = c.get("user");

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return fail(c, 400, "INVALID_BODY", "Request body must be valid JSON");

  const smartphoneId = body["smartphoneId"];
  if (typeof smartphoneId !== "string" || !smartphoneId || !body["type"] || !body["facing"]) {
    return fail(c, 400, "MISSING_FIELDS", "smartphoneId, type and facing are required");
  }

  // Walidacja danych (BPMN 2.4: "Data validation"): niepoprawne zgłoszenie nie trafia do bazy.
  const spec = validateCameraSpec(body);
  if (!spec.ok) return fail(c, 400, "INVALID_FIELD", spec.message, { field: spec.field });
  const modes = validateVideoModes(body["videoModes"]);
  if (!modes.ok) return fail(c, 400, "INVALID_FIELD", modes.message, { field: modes.field });

  const phone = await db.select({ id: smartphone.id }).from(smartphone).where(eq(smartphone.id, smartphoneId));
  if (!phone[0]) return fail(c, 404, "SMARTPHONE_NOT_FOUND", "Smartphone not found");

  const newCamera = {
    id:           randomUUID(),
    smartphoneId,
    submitterId:  user.id,
    reviewedBy:   null as string | null,
    status:       "pending" as const,
    submittedAt:  new Date(),
    reviewedAt:   null as Date | null,
    ...spec.data,
  };

  db.transaction((tx) => {
    tx.insert(camera).values(newCamera).run();
    if (modes.data.length) {
      tx.insert(cameraVideoMode).values(
        modes.data.map(m => ({ id: randomUUID(), cameraId: newCamera.id, ...m })),
      ).run();
    }
  });

  return c.json(await withSamples(newCamera), 201);
});

/**
 * Moderator poprawia dane aparatu (przycisk "Edit" przy tabeli specyfikacji),
 * bez zmiany statusu zgłoszenia. Wszystkie pola opcjonalne; wynik jest walidowany w całości.
 */
camerasRouter.patch("/:id", requireRole("moderator"), async (c) => {
  const id = c.req.param("id") as string;
  const existing = (await db.select().from(camera).where(eq(camera.id, id)))[0];
  if (!existing) return fail(c, 404, "NOT_FOUND", "Not found");

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return fail(c, 400, "INVALID_BODY", "Request body must be valid JSON");

  const changes: Record<string, unknown> = {};
  for (const k of SPEC_KEYS) if (k in body) changes[k] = body[k];
  if (Object.keys(changes).length === 0) {
    return fail(c, 400, "NOTHING_TO_UPDATE", "Provide at least one field to update");
  }

  const spec = validateCameraSpec({ ...existing, ...changes });
  if (!spec.ok) return fail(c, 400, "INVALID_FIELD", spec.message, { field: spec.field });

  await db.update(camera).set(spec.data).where(eq(camera.id, id));
  return c.json({ ok: true });
});

/**
 * Rozpatrzenie zgłoszenia przez moderatora (BPMN 2.4): zatwierdzenie (z opcjonalnymi poprawkami)
 * albo odrzucenie. Zgłaszający dostaje powiadomienie. Aparat ze zmienną przysłoną / zoomem
 * można zatwierdzić dopiero, gdy ma zdjęcia dla co najmniej 2 różnych wartości.
 */
camerasRouter.patch("/:id/review", requireRole("moderator"), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id") as string;

  const existing = (await db.select().from(camera).where(eq(camera.id, id)))[0];
  if (!existing) return fail(c, 404, "NOT_FOUND", "Not found");

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return fail(c, 400, "INVALID_BODY", "Request body must be valid JSON");

  const status = body["status"];
  if (status !== "approved" && status !== "rejected") {
    return fail(c, 400, "INVALID_STATUS", "status must be approved or rejected");
  }

  const updates: Partial<typeof camera.$inferInsert> = {
    status, reviewedBy: user.id, reviewedAt: new Date(),
  };

  if (status === "approved") {
    const changes: Record<string, unknown> = {};
    for (const k of SPEC_KEYS) if (k in body) changes[k] = body[k];
    const spec = validateCameraSpec({ ...existing, ...changes });
    if (!spec.ok) return fail(c, 400, "INVALID_FIELD", spec.message, { field: spec.field });
    Object.assign(updates, spec.data);

    const samples = await sampleCoverage(id, spec.data);
    if (!samples.satisfied) {
      return fail(c, 409, "INSUFFICIENT_SAMPLES",
        "A camera with variable aperture or optical zoom needs photos taken at 2 or more different values",
        { samples });
    }
  }

  await db.update(camera).set(updates).where(eq(camera.id, id));
  await notify(existing.submitterId, "camera_reviewed", {
    cameraId: id, smartphoneId: existing.smartphoneId, status,
  });
  return c.json({ ok: true });
});

export { camerasRouter };
