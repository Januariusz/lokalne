import type { Session, User } from "better-auth";

export type Role = "user" | "reviewer" | "moderator" | "admin";


export type HonoVariables = {
  user: User & { role?: Role };
  session: Session;
};
