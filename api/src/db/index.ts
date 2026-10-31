import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

const DB_PATH = process.env["DATABASE_PATH"] ?? "./data/db.sqlite";

const sqlite = new Database(DB_PATH);

sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
// Bezpieczne przy WAL: po awarii zasilania może zniknąć tylko ostatnia transakcja, baza się nie psuje.
sqlite.pragma("synchronous = NORMAL");
sqlite.pragma("temp_store = MEMORY");
sqlite.pragma("cache_size = -16000"); // ok. 16 MB cache stron

/**
 * Klucz sortowania naturalnego: małe litery, a liczby dopełnione zerami do 12 cyfr, więc porównanie
 * tekstowe daje kolejność "Galaxy S8, S9, S20" i "Pixel 9, 10" (a nie "S20, S8" jak przy zwykłym tekście).
 */
export function naturalKey(text: string | null): string | null {
  if (text === null) return null;
  return text.toLowerCase().replace(/\d+/g, (d) => (d.replace(/^0+(?=\d)/, "")).padStart(12, "0"));
}
// Funkcja dostępna w SQL: ORDER BY natural_key(model_name)
sqlite.function("natural_key", { deterministic: true }, (v: unknown) => naturalKey(v === null ? null : String(v)));

/** Aktualizuje statystyki planisty zapytań (tanie; wołane przy starcie i raz na dobę). */
export function optimizeDatabase(): void {
  try { sqlite.pragma("optimize"); } catch (err) { console.error("[db] optimize failed:", err); }
}

export const db = drizzle(sqlite, { schema });
export type DB = typeof db;
