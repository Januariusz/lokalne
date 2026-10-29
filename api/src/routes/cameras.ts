import { Hono } from "hono";
import { db } from "../db/index.js";
import { camera, cameraVideoMode, smartphone } from "../db/schema.js";
import { eq, and, desc, asc } from "drizzle-orm";
import { requireAuth, requireRole, hasRole } from "../middleware/requireAuth.js";
import { fail } from "../lib/errors.js";
import { notify } from "../lib/notifications.js";
import { validateCameraSpec, validateVideoModes, sampleCoverage, sampleCoverageMany } from "../lib/cameraSpec.js";
import { phoneSummaries, videoModesOf } from "../services/phones.js";
import { deleteCamerasWithMedia } from "../services/cameraDeletion.js";
import type { HonoVariables } from "../types/honoTypes.js";
import { randomUUID } from "node:crypto";

const camerasRouter = new Hono<{ Variables: HonoVariables }>();

const SPEC_KEYS = [
  "type", "facing", "focalLengthMm", "aperture", "cropFactor", "pixelPitchUm", "resolutionMp",
"activeResolutionMp", "afZones", "ois", "variableAperture", "apertureNarrow", "opticalZoom", "focalLengthMaxMm",
"sensorFormat", "photoWidthPx", "photoHeightPx", "aspectRatio", "note",
] as const;

async function withSamples<T extends { id: string; variableAperture: boolean; opticalZoom: boolean }>(row: T) {
  return { ...row, samples: await sampleCoverage(row.id, row) };
}

/** Lista zgłoszeń z pokryciem próbkami i krótkim opisem telefonu (nazwa, marka, zdjęcie) - zbiorczo. */
async function decorateList<T extends { id: string; smartphoneId: string; variableAperture: boolean; opticalZoom: boolean }>(rows: T[]) {
  const samples = await sampleCoverageMany(rows);
  const phones = await phoneSummaries(rows.map((r) => r.smartphoneId));
  return rows.map((r) => ({ ...r, samples: samples.get(r.id)!, phone: phones.get(r.smartphoneId) ?? null }));
}

camerasRouter.get("/", async (c) => {
  const smartphoneId = c.req.query("smartphone_id");
  if (!smartphoneId) return fail(c, 400, "SMARTPHONE_ID_REQUIRED", "smartphone_id is required");

  const rows = await db.select().from(camera)
  .where(and(eq(camera.smartphoneId, smartphoneId), eq(camera.status, "approved")));

  const modes = await videoModesOf(rows.map((r) => r.id));
  return c.json(rows.map((cam) => ({ ...cam, videoModes: modes.get(cam.id) ?? [] })));
});

// Zgłoszenia zalogowanego użytkownika wraz ze statusem rozpatrzenia (BPMN 2.4).
camerasRouter.get("/mine", requireAuth, async (c) => {
  const user = c.get("user");
  const rows = await db.select().from(camera)
  .where(eq(camera.submitterId, user.id)).orderBy(desc(camera.submittedAt), desc(camera.id));
  return c.json(await decorateList(rows));
});

camerasRouter.get("/pending", requireRole("moderator"), async (c) => {
  const rows = await db.select().from(camera).where(eq(camera.status, "pending"))
  .orderBy(asc(camera.submittedAt), asc(camera.id));
  return c.json(await decorateList(rows));
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
  // Notatkę pod specyfikacją ustawia tylko moderator; od zwykłego użytkownika jest pomijana.
  if (!hasRole(user.role, "moderator")) spec.data.note = null;
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

  // Jedno oczekujące zgłoszenie na (użytkownik, telefon, typ, kierunek): podwójne wysłanie
  // (np. dwa kliknięcia albo ponowienie po zerwanym połączeniu) nie tworzy duplikatu.
  // Sprawdzenie w tej samej transakcji co zapis, więc dwa równoległe żądania też nie przejdą.
  const duplicateId = db.transaction((tx) => {
    const dup = tx.select({ id: camera.id }).from(camera).where(and(
      eq(camera.submitterId, user.id), eq(camera.smartphoneId, smartphoneId),
                                                                    eq(camera.type, newCamera.type), eq(camera.facing, newCamera.facing), eq(camera.status, "pending"),
    )).limit(1).all()[0];
    if (dup) return dup.id;
    tx.insert(camera).values(newCamera).run();
    if (modes.data.length) {
      tx.insert(cameraVideoMode).values(
        modes.data.map(m => ({ id: randomUUID(), cameraId: newCamera.id, ...m })),
      ).run();
    }
    return null;
  });
  if (duplicateId) {
    return fail(c, 409, "DUPLICATE_SUBMISSION",
                "You already have a pending submission for this camera on this smartphone", { cameraId: duplicateId });
  }

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

    // Pokrycie próbkami (samples) jest tylko informacją dla moderatora - ręczne zatwierdzenie
    // nie wymaga zdjęć (np. dane z oficjalnej specyfikacji producenta).
  }

  await db.update(camera).set(updates).where(eq(camera.id, id));
  await notify(existing.submitterId, "camera_reviewed", {
    cameraId: id, smartphoneId: existing.smartphoneId, status,
  });
  return c.json({ ok: true });
});

/**
 * Usunięcie aparatu (obiektywu) przez moderatora, np. błędnego albo zdublowanego wpisu.
 * Razem z aparatem znikają jego tryby wideo, zdjęcia i filmy (wiersze w bazie i pliki z dysku).
 */
camerasRouter.delete("/:id", requireRole("moderator"), async (c) => {
  const id = c.req.param("id") as string;
  const existing = (await db.select({ id: camera.id }).from(camera).where(eq(camera.id, id)))[0];
  if (!existing) return fail(c, 404, "CAMERA_NOT_FOUND", "Camera not found");

  const removed = await deleteCamerasWithMedia([id]);
  return c.json({ ok: true, deletedPhotos: removed.photos, deletedVideos: removed.videos });
});

export { camerasRouter };
