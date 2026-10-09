import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, jwt } from "better-auth/plugins";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { sendMail, buildMail } from "./mailer.js";
import { eq } from "drizzle-orm";
import { getActiveBan } from "./bans.js";
import { langFromHeader, localize } from "./i18n.js";

const isProd = process.env["NODE_ENV"] === "production";
const secretFromEnv = process.env["BETTER_AUTH_SECRET"];

if (isProd && !secretFromEnv) {
  throw new Error(
    "BETTER_AUTH_SECRET is not set in production. Set it in .env before starting the server."
  );
}

// Wymóg potwierdzenia e-maila przy rejestracji steruje zmienna EMAIL_VERIFICATION w .env
// ("true" = wymagany, cokolwiek innego lub brak = niewymagany). Włącz dopiero po skonfigurowaniu SMTP.
// Bez SMTP_HOST treść maili (reset hasła, zmiana e-maila) trafia tylko do logu serwera.
const mailEnabled = process.env["EMAIL_VERIFICATION"] === "true";

const PASSWORD_STRENGTH_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{8,}$/;

// Jedna zmienna ALLOWED_ORIGINS steruje i CORS (index.ts), i better-auth.
const trustedOrigins = (process.env["ALLOWED_ORIGINS"] ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter((o) => o && o !== "*");

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "sqlite",
    schema: {
      user:         schema.user,
      session:      schema.session,
      account:      schema.account,
      verification: schema.verification,
      jwks:         schema.jwks,
    },
  }),

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: mailEnabled,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    resetPasswordTokenExpiresIn: 60 * 60, // 1 godzina
    sendResetPassword: async ({ user, url }) => {
      // bez await, żeby czas odpowiedzi nie zdradzał, czy konto istnieje
      void sendMail({
        to: user.email,
        ...buildMail({
          name: user.name,
          subject: { pl: "Reset hasła w MobileLens", en: "MobileLens password reset" },
          intro: {
            pl: "Aby ustawić nowe hasło, użyj linku poniżej (ważny 1 godzinę).",
            en: "To set a new password, use the link below (valid for 1 hour).",
          },
          cta:    { pl: "Ustaw nowe hasło", en: "Set a new password" },
          footer: {
            pl: "Jeśli to nie Ty, zignoruj tę wiadomość.",
            en: "If this wasn't you, ignore this message.",
          },
          url,
        }),
      }).catch((err) => console.error("[mailer] password reset:", err));
    },
  },

  emailVerification: {
    sendOnSignUp: mailEnabled,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60 * 24, // 24 godziny
    sendVerificationEmail: async ({ user, url }) => {
      void sendMail({
        to: user.email,
        ...buildMail({
          name: user.name,
          subject: { pl: "Potwierdź adres e-mail w MobileLens", en: "Confirm your MobileLens e-mail" },
          intro: {
            pl: "Potwierdź swój adres e-mail, klikając link poniżej (ważny 24 godziny).",
            en: "Confirm your e-mail address using the link below (valid for 24 hours).",
          },
          cta:    { pl: "Potwierdź adres e-mail", en: "Confirm e-mail address" },
          footer: {
            pl: "Jeśli to nie Ty zakładałeś konto, zignoruj tę wiadomość.",
            en: "If you didn't create an account, ignore this message.",
          },
          url,
        }),
      }).catch((err) => console.error("[mailer] verification:", err));
    },
  },

  secret: secretFromEnv ?? "dev-only-insecure-secret",
  baseURL: process.env["API_BASE_URL"] ?? "http://localhost:3000",
  trustedOrigins,

  advanced: {
    ipAddress: {
      ipAddressHeaders: ["x-forwarded-for"],
    },
  },

  plugins: [
    bearer(),
    jwt({
      jwks: {
        keyPairConfig: { alg: "EdDSA" },
      },
    }),
  ],

  user: {
    changeEmail: {
      enabled: true,
      sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
        void sendMail({
          to: user.email,
          ...buildMail({
            name: user.name,
            subject: { pl: "Potwierdź zmianę adresu e-mail", en: "Confirm your e-mail change" },
            intro: {
              pl: `Ktoś poprosił o zmianę adresu e-mail na ${newEmail}.`,
              en: `Someone asked to change your e-mail address to ${newEmail}.`,
            },
            cta:    { pl: "Potwierdź zmianę", en: "Confirm the change" },
            footer: {
              pl: "Jeśli to nie Ty, zignoruj tę wiadomość.",
              en: "If this wasn't you, ignore this message.",
            },
            url,
          }),
        }).catch((err) => console.error("[mailer] e-mail change:", err));
      },
    },
    additionalFields: {
      username: { type: "string", required: false, unique: true },
      // input: false => klient nie może ustawić roli przy rejestracji/aktualizacji profilu
      role:     { type: "string", required: false, defaultValue: "user", input: false },
    },
  },

  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      const lang = langFromHeader(ctx.headers?.get("accept-language"));

      // Zablokowany użytkownik nie może się zalogować (sesje są też kasowane przy blokadzie).
      if (ctx.path === "/sign-in/email") {
        const email = (ctx.body?.email as string | undefined)?.trim().toLowerCase();
        if (email) {
          const rows = await db.select({ id: schema.user.id }).from(schema.user)
            .where(eq(schema.user.email, email)).limit(1);
          const ban = rows[0] ? await getActiveBan(rows[0].id) : null;
          if (ban) {
            throw new APIError("FORBIDDEN", {
              message: localize(lang, "USER_BANNED", "Your account has been banned"),
              code: "USER_BANNED",
            });
          }
        }
        return;
      }

      const isSignUp = ctx.path === "/sign-up/email";
      const isReset  = ctx.path === "/reset-password";
      const isChange = ctx.path === "/change-password";
      if (!isSignUp && !isReset && !isChange) return;

      const password = (isSignUp ? ctx.body?.password : ctx.body?.newPassword) as string | undefined;

      if (!password) {
        throw new APIError("BAD_REQUEST", {
          message: localize(lang, "PASSWORD_REQUIRED", "Password is required."),
          code: "PASSWORD_REQUIRED",
        });
      }

      if (!PASSWORD_STRENGTH_REGEX.test(password)) {
        throw new APIError("BAD_REQUEST", {
          message: localize(
            lang, "PASSWORD_TOO_WEAK",
            "Password must be at least 8 characters long and contain a lowercase letter, " +
            "an uppercase letter, a digit and a special character.",
          ),
          code: "PASSWORD_TOO_WEAK",
        });
      }
    }),
  },
});

export type Auth = typeof auth;
