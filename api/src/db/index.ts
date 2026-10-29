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

/** Aktualizuje statystyki planisty zapytań (tanie; wołane przy starcie i raz na dobę). */
export function optimizeDatabase(): void {
  try { sqlite.pragma("optimize"); } catch (err) { console.error("[db] optimize failed:", err); }
}

export const db = drizzle(sqlite, { schema });
export type DB = typeof db;
