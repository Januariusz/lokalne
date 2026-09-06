

import { db } from "../db/index.js";
import { camera } from "../db/schema.js";
import { eq } from "drizzle-orm";


const MIN_SUBMISSIONS = 3;

const OUTLIER_THRESHOLD = 0.20;

const MIN_AGREEMENT = 0.66;

type CameraRow = typeof camera.$inferSelect;
type NumericKey = "focalLengthMm" | "aperture" | "cropFactor" | "pixelPitchUm" | "resolutionMp" | "activeResolutionMp";
type DiscreteKey = "afZones" | "ois";

const NUMERIC_KEYS: NumericKey[] = [
  "focalLengthMm", "aperture", "cropFactor",
  "pixelPitchUm", "resolutionMp", "activeResolutionMp",
];

const DISCRETE_KEYS: DiscreteKey[] = ["afZones", "ois"];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;
}

function mode<T extends string | number>(values: T[]): T {
  const freq = new Map<T, number>();
  for (const v of values) freq.set(v, (freq.get(v) ?? 0) + 1);
  let best = values[0] as T;
  let bestCount = 0;
  for (const [v, count] of freq) {
    if (count > bestCount) { best = v; bestCount = count; }
  }
  return best;
}


function findOutliers(rows: CameraRow[]): Set<string> {
  const outlierIds = new Set<string>();

  for (const key of NUMERIC_KEYS) {
    const values = rows.map(r => r[key] as number);
    const med = median(values);
    if (med === 0) continue;

    for (const row of rows) {
      const val = row[key] as number;
      if (Math.abs(val - med) / med > OUTLIER_THRESHOLD) {
        outlierIds.add(row.id);
      }
    }
  }
  return outlierIds;
}


function agreementScore(rows: CameraRow[]): number {
  if (rows.length === 0) return 0;
  let totalChecks = 0;
  let matching = 0;

  for (const key of DISCRETE_KEYS) {
    const values = rows.map(r => r[key]);
    const modeVal = mode(values);
    for (const v of values) {
      totalChecks++;
      if (v === modeVal) matching++;
    }
  }
  return totalChecks === 0 ? 1 : matching / totalChecks;
}

async function aggregateGroup(rows: CameraRow[]) {
  if (rows.length < MIN_SUBMISSIONS) {

    return;
  }

  const outlierIds = findOutliers(rows);
  const cleanRows = rows.filter(r => !outlierIds.has(r.id));

  await db.transaction(async (tx) => {

    for (const id of outlierIds) {
      await tx.update(camera)
        .set({ status: "rejected", reviewedAt: new Date(), reviewedBy: null })
        .where(eq(camera.id, id));
    }

    if (cleanRows.length < MIN_SUBMISSIONS) {

      return;
    }

    const agreement = agreementScore(cleanRows);
    if (agreement < MIN_AGREEMENT) {

      return;
    }

    const consensusNumeric: Partial<Record<NumericKey, number>> = {};
    for (const key of NUMERIC_KEYS) {
      const values = cleanRows.map(r => r[key] as number);
      consensusNumeric[key] = Math.round(median(values) * 100) / 100;
    }

    const consensusDiscrete: { afZones: number; ois: CameraRow["ois"] } = {
      afZones: mode(cleanRows.map(r => r.afZones)),
      ois:     mode(cleanRows.map(r => r.ois)),
    };

    const sorted = [...cleanRows].sort(
      (a, b) => a.submittedAt.getTime() - b.submittedAt.getTime()
    );
    const winner = sorted[0]!;

    await tx.update(camera)
      .set({
        status:     "approved",
        reviewedAt: new Date(),
        reviewedBy: null,
        ...consensusNumeric,
        ...consensusDiscrete,
      })
      .where(eq(camera.id, winner.id));


    const losers = sorted.filter(r => r.id !== winner.id);
    for (const row of losers) {
      await tx.update(camera)
        .set({ status: "rejected", reviewedAt: new Date(), reviewedBy: null })
        .where(eq(camera.id, row.id));
    }
  });
}

export async function runAggregationPipeline() {

  const pendingRows = await db.select()
    .from(camera)
    .where(eq(camera.status, "pending"));

  if (pendingRows.length === 0) return;


  const groups = new Map<string, CameraRow[]>();
  for (const row of pendingRows) {
    const key = `${row.smartphoneId}::${row.type}::${row.facing}`;
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }

  for (const [, rows] of groups) {
    try {
      await aggregateGroup(rows);
    } catch (err) {
      console.error("[aggregation] group error:", err);
    }
  }

  console.log(`[aggregation] processed ${groups.size} groups from ${pendingRows.length} pending rows`);
}


export function startAggregationScheduler(intervalMs = 10 * 60 * 1000) {
  console.log("[aggregation] scheduler started, interval:", intervalMs / 1000, "s");

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    try {
      await runAggregationPipeline();
    } catch (err) {
      console.error("[aggregation] pipeline error:", err);
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
