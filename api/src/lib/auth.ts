import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, jwt } from "better-auth/plugins";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";

const isProd = process.env["NODE_ENV"] === "production";
const secretFromEnv = process.env["BETTER_AUTH_SECRET"];

if (isProd && !secretFromEnv) {
  throw new Error(
    "BETTER_AUTH_SECRET nie jest ustawiony w środowisku produkcyjnym. " +
    "Ustaw go w .env (patrz plan wdrożenia, sekcja 1) przed uruchomieniem."
  );
}


const PASSWORD_STRENGTH_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{8,}$/;

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
    requireEmailVerification: false,
    minPasswordLength: 8,
    maxPasswordLength: 128,
  },

  secret: secretFromEnv ?? "dev-only-insecure-secret",
  baseURL: process.env["API_BASE_URL"] ?? "http://localhost:3000",

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
    additionalFields: {
      username: { type: "string", required: false, unique: true },
      role:     { type: "string", required: false, defaultValue: "user" },
    },
  },


  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-up/email") {
        return;
      }

      const password = ctx.body?.password as string | undefined;

      if (!password) {
        throw new APIError("BAD_REQUEST", {
          message: "Hasło jest wymagane.",
        });
      }

      if (!PASSWORD_STRENGTH_REGEX.test(password)) {
        throw new APIError("BAD_REQUEST", {
          message:
          "Hasło musi zawierać co najmniej 8 znaków, " +
          "małą literę, wielką literę, cyfrę i znak specjalny.",
        });
      }
    }),
  },
});

export type Auth = typeof auth;
