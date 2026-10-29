import { and, eq, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { camera } from "../db/schema.js";

// Ochrona przed klonami aparatów: dwa zatwierdzone aparaty tego samego telefonu o tym samym typie,
// kierunku, ogniskowej, przysłonie i rozdzielczości to ten sam obiektyw zapisany dwa razy
// (np. dwóch moderatorów weryfikuje telefon w tej samej chwili albo formularz wysłano dwa razy).
// Dwa różne obiektywy tego samego typu (np. dwa tele 3x i 5x) różnią się ogniskową, więc przechodzą.

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Spec = {
  smartphoneId: string; type: string; facing: string;
  focalLengthMm: number; aperture: number; resolutionMp: number;
};

const same = (a: number, b: number) => Math.abs(a - b) < 0.005;

/** Zatwierdzony aparat o tej samej specyfikacji (bez `excludeId`); null, gdy nie ma. */
export function approvedTwin(tx: Tx | typeof db, spec: Spec, excludeId?: string): string | null {
  const rows = tx.select({
    id: camera.id, focalLengthMm: camera.focalLengthMm, aperture: camera.aperture, resolutionMp: camera.resolutionMp,
  }).from(camera).where(and(
    eq(camera.smartphoneId, spec.smartphoneId), eq(camera.type, spec.type as never),
    eq(camera.facing, spec.facing as never), eq(camera.status, "approved"),
    ...(excludeId ? [ne(camera.id, excludeId)] : []),
  )).all();
  const twin = rows.find((r) => same(r.focalLengthMm, spec.focalLengthMm) && same(r.aperture, spec.aperture)
    && same(r.resolutionMp, spec.resolutionMp));
  return twin?.id ?? null;
}
