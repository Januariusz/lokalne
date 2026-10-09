import { Hono } from "hono";
import { auth } from "../lib/auth.js";
import { langOf, localize } from "../lib/i18n.js";

const authRouter = new Hono();

// Wszystko obsługuje better-auth; błędy tłumaczymy na polski, gdy klient prosi o PL
// (Accept-Language: pl lub ?lang=pl). Kod błędu (`code`) zostaje bez zmian.
authRouter.all("/*", async (c) => {
  const res = await auth.handler(c.req.raw);
  const lang = langOf(c);
  if (lang !== "pl" || res.status < 400) return res;
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) return res;

  try {
    const body = await res.clone().json() as { code?: string; message?: string };
    if (!body?.code) return res;
    const message = localize(lang, body.code, body.message ?? "");
    if (message === (body.message ?? "")) return res;
    const headers = new Headers(res.headers);
    headers.delete("content-length");
    return new Response(JSON.stringify({ ...body, message }), { status: res.status, headers });
  } catch {
    return res;
  }
});

export { authRouter };
