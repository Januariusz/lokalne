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
import { approvedTwin } from "../services/cameraTwins.js";
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

/** Lista zgłoszeń z pokryciem próbkami, trybami wideo i krótkim opisem telefonu - zbiorczo. */
async function decorateList<T extends { id: string; smartphoneId: string; variableAperture: boolean; opticalZoom: boolean }>(rows: T[]) {
  const samples = await sampleCoverageMany(rows);
  const phones = await phoneSummaries(rows.map((r) => r.smartphoneId));
  const modes = await videoModesOf(rows.map((r) => r.id));
  return rows.map((r) => ({
    ...r, samples: samples.get(r.id)!, phone: phones.get(r.smartphoneId) ?? null, videoModes: modes.get(r.id) ?? [],
  }));
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type VideoModeRow = { widthPx: number; heightPx: number; fpsMax: number; note: string | null };

/**
 * `videoModes` z treści PATCH: brak pola = bez zmian (null), inaczej pełna docelowa lista ([] usuwa wszystko).
 * Ten sam tryb (rozdzielczość bez względu na orientację + fpsMax) dwa razy -> błąd.
 */
function parseVideoModesPatch(body: Record<string, unknown>):
  { ok: true; data: VideoModeRow[] | null } | { ok: false; field: string; message: string } {
  if (!("videoModes" in body)) return { ok: true, data: null };
  if (!Array.isArray(body["videoModes"])) {
    return { ok: false, field: "videoModes", message: "videoModes must be an array (use [] to remove all modes)" };
  }
  const v = validateVideoModes(body["videoModes"]);
  if (!v.ok) return v;
  const seen = new Set<string>();
  for (const m of v.data) {
    const key = `${Math.max(m.widthPx, m.heightPx)}x${Math.min(m.widthPx, m.heightPx)}@${m.fpsMax}`;
    if (seen.has(key)) {
      return { ok: false, field: "videoModes", message: `Duplicate video mode ${m.widthPx}x${m.heightPx} ${m.fpsMax} fps` };
    }
    seen.add(key);
  }
  return { ok: true, data: v.data };
}

/** Zastępuje tryby wideo aparatu (w transakcji wywołującego). */
function replaceVideoModes(tx: Tx, cameraId: string, modes: VideoModeRow[]): void {
  tx.delete(cameraVideoMode).where(eq(cameraVideoMode.cameraId, cameraId)).run();
  if (modes.length) {
    tx.insert(cameraVideoMode).values(modes.map((m) => ({ id: randomUUID(), cameraId, ...m }))).run();
  }
}

/** Aparat po zmianie, z trybami wideo (odpowiedź PATCH). */
async function cameraWithModes(id: string) {
  const row = (await db.select().from(camera).where(eq(camera.id, id)))[0];
  if (!row) return null;
  return { ...row, videoModes: (await videoModesOf([id])).get(id) ?? [] };
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
  // Aparat o tej samej specyfikacji, który jest już zatwierdzony, też nie jest zapisywany ponownie.
  const conflict = db.transaction((tx) => {
    const dup = tx.select({ id: camera.id }).from(camera).where(and(
      eq(camera.submitterId, user.id), eq(camera.smartphoneId, smartphoneId),
      eq(camera.type, newCamera.type), eq(camera.facing, newCamera.facing), eq(camera.status, "pending"),
    )).limit(1).all()[0];
    if (dup) return { code: "DUPLICATE_SUBMISSION" as const, id: dup.id };
    const twin = approvedTwin(tx, newCamera);
    if (twin) return { code: "CAMERA_EXISTS" as const, id: twin };
    tx.insert(camera).values(newCamera).run();
    if (modes.data.length) {
      tx.insert(cameraVideoMode).values(
        modes.data.map(m => ({ id: randomUUID(), cameraId: newCamera.id, ...m })),
      ).run();
    }
    return null;
  });
  if (conflict?.code === "DUPLICATE_SUBMISSION") {
    return fail(c, 409, "DUPLICATE_SUBMISSION",
      "You already have a pending submission for this camera on this smartphone", { cameraId: conflict.id });
  }
  if (conflict?.code === "CAMERA_EXISTS") {
    return fail(c, 409, "CAMERA_EXISTS", "This camera is already in the catalogue", { cameraId: conflict.id });
  }

  return c.json(await withSamples(newCamera), 201);
});

/**
 * Moderator poprawia dane aparatu (przycisk "Edit" przy tabeli specyfikacji),
 * bez zmiany statusu zgłoszenia. Wszystkie pola opcjonalne; wynik jest walidowany w całości.
 * `videoModes` - pełna nowa lista trybów wideo (np. dopisanie 4K 60 fps, którego telefon nie zgłosił).
 */
camerasRouter.patch("/:id", requireRole("moderator"), async (c) => {
  const id = c.req.param("id") as string;
  const existing = (await db.select().from(camera).where(eq(camera.id, id)))[0];
  if (!existing) return fail(c, 404, "NOT_FOUND", "Not found");

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return fail(c, 400, "INVALID_BODY", "Request body must be valid JSON");

  const changes: Record<string, unknown> = {};
  for (const k of SPEC_KEYS) if (k in body) changes[k] = body[k];
  if (Object.keys(changes).length === 0 && !("videoModes" in body)) {
    return fail(c, 400, "NOTHING_TO_UPDATE", "Provide at least one field to update");
  }

  const spec = validateCameraSpec({ ...existing, ...changes });
  if (!spec.ok) return fail(c, 400, "INVALID_FIELD", spec.message, { field: spec.field });
  const modes = parseVideoModesPatch(body);
  if (!modes.ok) return fail(c, 400, "INVALID_FIELD", modes.message, { field: modes.field });

  db.transaction((tx) => {
    tx.update(camera).set(spec.data).where(eq(camera.id, id)).run();
    if (modes.data) replaceVideoModes(tx, id, modes.data);
  });
  return c.json({ ok: true, camera: await cameraWithModes(id) });
});

/**
 * Rozpatrzenie zgłoszenia przez moderatora (BPMN 2.4): zatwierdzenie (z opcjonalnymi poprawkami)
 * albo odrzucenie. Zgłaszający dostaje powiadomienie. Zdjęcia próbne nie są wymagane.
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

  // Rozpatrzyć można tylko oczekujące zgłoszenie. Gdy dwóch moderatorów kliknie jednocześnie,
  // drugi dostaje 409 zamiast nadpisać decyzję pierwszego (i drugiego powiadomienia).
  if (existing.status !== "pending") {
    return fail(c, 409, "ALREADY_REVIEWED", "This submission has already been reviewed", { status: existing.status });
  }

  // Tryby wideo poprawiane przy zatwierdzeniu; przy odrzuceniu pole jest ignorowane.
  let newModes: VideoModeRow[] | null = null;
  if (status === "approved") {
    const changes: Record<string, unknown> = {};
    for (const k of SPEC_KEYS) if (k in body) changes[k] = body[k];
    const spec = validateCameraSpec({ ...existing, ...changes });
    if (!spec.ok) return fail(c, 400, "INVALID_FIELD", spec.message, { field: spec.field });
    Object.assign(updates, spec.data);
    const m = parseVideoModesPatch(body);
    if (!m.ok) return fail(c, 400, "INVALID_FIELD", m.message, { field: m.field });
    newModes = m.data;

    // Pokrycie próbkami (samples) jest tylko informacją dla moderatora - ręczne zatwierdzenie
    // nie wymaga zdjęć (np. dane z oficjalnej specyfikacji producenta).
  }

  // Zapis warunkowy (status nadal "pending") i sprawdzenie klona w jednej transakcji.
  const outcome = db.transaction((tx) => {
    if (status === "approved") {
      const twin = approvedTwin(tx, { ...existing, ...updates } as Parameters<typeof approvedTwin>[1], id);
      if (twin) return { error: "CAMERA_EXISTS" as const, id: twin };
    }
    const changed = tx.update(camera).set(updates)
      .where(and(eq(camera.id, id), eq(camera.status, "pending"))).run().changes;
    if (changed === 0) {
      const now = tx.select({ status: camera.status }).from(camera).where(eq(camera.id, id)).all()[0];
      return { error: "ALREADY_REVIEWED" as const, status: now?.status ?? null };
    }
    if (newModes) replaceVideoModes(tx, id, newModes);
    return null;
  });
  if (outcome?.error === "CAMERA_EXISTS") {
    return fail(c, 409, "CAMERA_EXISTS",
      "An identical camera is already approved for this smartphone - reject this submission instead", { cameraId: outcome.id });
  }
  if (outcome?.error === "ALREADY_REVIEWED") {
    return fail(c, 409, "ALREADY_REVIEWED", "This submission has already been reviewed", { status: outcome.status });
  }
  await notify(existing.submitterId, "camera_reviewed", {
    cameraId: id, smartphoneId: existing.smartphoneId, status,
  });
  return c.json({ ok: true, camera: await cameraWithModes(id) });
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
