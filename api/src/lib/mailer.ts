import nodemailer from "nodemailer";

const host = process.env["SMTP_HOST"];
const port = parseInt(process.env["SMTP_PORT"] ?? "587", 10);
const user = process.env["SMTP_USER"];
const pass = process.env["SMTP_PASS"];
const from = process.env["MAIL_FROM"] ?? "MobileLens <no-reply@mobilelens.duckdns.org>";

const transporter = host
  ? nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: user && pass ? { user, pass } : undefined,
    })
  : null;

if (!transporter) {
  console.warn("[mailer] SMTP_HOST is not set - e-mails will only be logged, not sent");
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

export async function sendMail(opts: { to: string; subject: string; text: string; html: string }) {
  if (!transporter) {
    console.log(`[mailer] (no SMTP) to: ${opts.to} | ${opts.subject}\n${opts.text}`);
    return;
  }
  await transporter.sendMail({ from, ...opts });
}

type Bilingual = { pl: string; en: string };

/** Mail dwujęzyczny (PL + EN) z jednym linkiem akcji. */
export function buildMail(o: {
  name: string;
  subject: Bilingual;
  intro: Bilingual;
  cta: Bilingual;
  footer: Bilingual;
  url: string;
}) {
  const subject = `${o.subject.pl} / ${o.subject.en}`;

  const text = [
    `Cześć ${o.name},`, o.intro.pl, `${o.cta.pl}: ${o.url}`, o.footer.pl,
    "---",
    `Hi ${o.name},`, o.intro.en, `${o.cta.en}: ${o.url}`, o.footer.en,
  ].join("\n\n");

  const block = (greeting: string, b: { intro: string; cta: string; footer: string }) =>
    `<p>${greeting} ${escapeHtml(o.name)},</p>` +
    `<p>${escapeHtml(b.intro)}</p>` +
    `<p><a href="${escapeHtml(o.url)}">${escapeHtml(b.cta)}</a></p>` +
    `<p>${escapeHtml(b.footer)}</p>`;

  const html =
    block("Cześć", { intro: o.intro.pl, cta: o.cta.pl, footer: o.footer.pl }) +
    "<hr>" +
    block("Hi", { intro: o.intro.en, cta: o.cta.en, footer: o.footer.en });

  return { subject, text, html };
}
