import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { langOf, localize } from "./i18n.js";

/**
 * Jednolity format błędów: { error: "<komunikat>", code: "<STAŁY_KOD>", ...extra }.
 * Komunikat jest po angielsku albo po polsku, zależnie od Accept-Language (lub ?lang=pl|en);
 * klient może też sam tłumaczyć na podstawie `code`.
 * `extra` (np. { field: "aperture" }) trafia do odpowiedzi i do szablonu polskiego komunikatu.
 */
export function fail(
  c: Context<any, any, any>,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
) {
  return c.json({ error: localize(langOf(c), code, message, extra), code, ...extra }, status);
}
