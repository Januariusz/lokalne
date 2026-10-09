import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  username: text("username").unique(),
  role: text("role", { enum: ["user", "reviewer", "moderator", "admin"] }).notNull().default("user"),
  isDeletedUser: integer("is_deleted_user", { mode: "boolean" }).notNull().default(false),
  passwordResetToken: text("password_reset_token"),
  resetTokenExpiresAt: integer("reset_token_expires_at", { mode: "timestamp" }),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  issuer: text("issuer").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, (t) => [
  uniqueIndex("idx_account_issuer_account_id").on(t.issuer, t.accountId),
]);

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});

export const jwks = sqliteTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  alg: text("alg"),
  crv: text("crv"),
});

export const roleChangeLog = sqliteTable("role_change_log", {
  id: text("id").primaryKey(),
  targetId: text("target_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  previousRole: text("previous_role", { enum: ["user", "reviewer", "moderator", "admin"] }).notNull(),
  newRole: text("new_role", { enum: ["user", "reviewer", "moderator", "admin"] }).notNull(),
  changedAt: integer("changed_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  changedBy: text("changed_by").references(() => user.id, { onDelete: "set null" }),
}, (t) => [index("idx_role_log_target").on(t.targetId)]);

export const brand = sqliteTable("brand", {
  id: text("id").primaryKey(),
  name: text("name", { length: 128 }).notNull().unique(),
  logoUrl: text("logo_url", { length: 512 }),
});

export const smartphone = sqliteTable("smartphone", {
  id: text("id").primaryKey(),
  brandId: text("brand_id").notNull().references(() => brand.id, { onDelete: "restrict" }),
  addedBy: text("added_by").notNull().references(() => user.id, { onDelete: "restrict" }),
  verifiedBy: text("verified_by").references(() => user.id, { onDelete: "set null" }),
  modelName: text("model_name", { length: 128 }).notNull(),
  imageUrl: text("image_url", { length: 512 }),
  releaseDate: text("release_date"),
  viewCount: integer("view_count").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, (t) => [
  index("idx_smartphone_brand").on(t.brandId),
  index("idx_smartphone_added_by").on(t.addedBy),
]);

export const camera = sqliteTable("camera", {
  id: text("id").primaryKey(),
  smartphoneId: text("smartphone_id").notNull().references(() => smartphone.id, { onDelete: "cascade" }),
  submitterId: text("submitter_id").notNull().references(() => user.id, { onDelete: "restrict" }),
  reviewedBy: text("reviewed_by").references(() => user.id, { onDelete: "set null" }),
  status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  submittedAt: integer("submitted_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  reviewedAt: integer("reviewed_at", { mode: "timestamp" }),
  type: text("type", { enum: ["wide", "ultrawide", "tele", "macro", "other"] }).notNull(),
  facing: text("facing", { enum: ["back", "front", "other"] }).notNull().default("back"),
  focalLengthMm: real("focal_length_mm").notNull(),
  aperture: real("aperture").notNull(),
  cropFactor: real("crop_factor").notNull(),
  pixelPitchUm: real("pixel_pitch_um").notNull(),
  resolutionMp: real("resolution_mp").notNull(),
  activeResolutionMp: real("active_resolution_mp").notNull(),
  afZones: integer("af_zones").notNull().default(0),
  ois: text("ois", { enum: ["none", "optical", "sensor_shift"] }).notNull().default("none"),
  // Obiektyw ze zmienną przysłoną / zoomem optycznym: wymaga zdjęć przykładowych dla różnych wartości.
  variableAperture: integer("variable_aperture", { mode: "boolean" }).notNull().default(false),
  apertureNarrow: real("aperture_narrow"),            // największa liczba f (najbardziej przymknięta przysłona)
  opticalZoom: integer("optical_zoom", { mode: "boolean" }).notNull().default(false),
  focalLengthMaxMm: real("focal_length_max_mm"),      // koniec zakresu zoomu (focal_length_mm = początek)
}, (t) => [
  index("idx_camera_smartphone").on(t.smartphoneId),
  index("idx_camera_submitter").on(t.submitterId),
  index("idx_camera_status").on(t.status),
]);

export const cameraVideoMode = sqliteTable("camera_video_mode", {
  id: text("id").primaryKey(),
  cameraId: text("camera_id").notNull().references(() => camera.id, { onDelete: "cascade" }),
  widthPx: integer("width_px").notNull(),
  heightPx: integer("height_px").notNull(),
  fpsMax: real("fps_max").notNull(),
  note: text("note", { length: 128 }),
}, (t) => [index("idx_video_mode_camera").on(t.cameraId)]);

export const photo = sqliteTable("photo", {
  id: text("id").primaryKey(),
  uploaderId: text("uploader_id").notNull().references(() => user.id, { onDelete: "restrict" }),
  cameraId: text("camera_id").notNull().references(() => camera.id, { onDelete: "restrict" }),
  storageUrl: text("storage_url", { length: 512 }).notNull(),
  exifFocalLength: real("exif_focal_length"),
  exifAperture: real("exif_aperture"),
  exifIso: integer("exif_iso"),
  exifShutterSpeed: real("exif_shutter_speed"),
  widthPx: integer("width_px").notNull(),
  heightPx: integer("height_px").notNull(),
  uploadDate: integer("upload_date", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  status: text("status", { enum: ["pending", "verified", "deleted"] }).notNull().default("pending"),
}, (t) => [
  index("idx_photo_camera").on(t.cameraId),
  index("idx_photo_uploader").on(t.uploaderId),
]);

export const video = sqliteTable("video", {
  id: text("id").primaryKey(),
  uploaderId: text("uploader_id").notNull().references(() => user.id, { onDelete: "restrict" }),
  cameraId: text("camera_id").notNull().references(() => camera.id, { onDelete: "restrict" }),
  storageUrl: text("storage_url", { length: 512 }).notNull(),
  widthPx: integer("width_px").notNull(),
  heightPx: integer("height_px").notNull(),
  fps: real("fps").notNull(),
  uploadDate: integer("upload_date", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  status: text("status", { enum: ["pending", "verified", "deleted"] }).notNull().default("pending"),
}, (t) => [
  index("idx_video_camera").on(t.cameraId),
  index("idx_video_uploader").on(t.uploaderId),
]);

export const review = sqliteTable("review", {
  id: text("id").primaryKey(),
  authorId: text("author_id").notNull().references(() => user.id, { onDelete: "restrict" }),
  smartphoneId: text("smartphone_id").notNull().references(() => smartphone.id, { onDelete: "cascade" }),
  title: text("title", { length: 256 }).notNull(),
  contentMarkdown: text("content_markdown").notNull(),
  status: text("status", { enum: ["draft", "pending", "published", "hidden"] }).notNull().default("draft"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, (t) => [
  index("idx_review_author").on(t.authorId),
  index("idx_review_smartphone").on(t.smartphoneId),
]);

export const reviewMedia = sqliteTable("review_media", {
  id: text("id").primaryKey(),
  reviewId: text("review_id").notNull().references(() => review.id, { onDelete: "cascade" }),
  type: text("type", { enum: ["photo", "video"] }).notNull(),
  storageUrl: text("storage_url", { length: 512 }).notNull(),
  displayOrder: integer("display_order").notNull(),
}, (t) => [index("idx_review_media_review").on(t.reviewId)]);

export const favorite = sqliteTable("favorite", {
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  smartphoneId: text("smartphone_id").notNull().references(() => smartphone.id, { onDelete: "cascade" }),
  addedAt: integer("added_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, (t) => [primaryKey({ columns: [t.userId, t.smartphoneId] })]);

export const reviewComment = sqliteTable("review_comment", {
  id: text("id").primaryKey(),
  reviewId: text("review_id").notNull().references(() => review.id, { onDelete: "cascade" }),
  authorId: text("author_id").notNull().references(() => user.id, { onDelete: "restrict" }),
  content: text("content", { length: 2000 }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, (t) => [
  index("idx_review_comment_review").on(t.reviewId),
  index("idx_review_comment_author").on(t.authorId),
]);

export const reviewLike = sqliteTable("review_like", {
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  reviewId: text("review_id").notNull().references(() => review.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, (t) => [
  primaryKey({ columns: [t.userId, t.reviewId] }),
  index("idx_review_like_review").on(t.reviewId),
]);

export const userBan = sqliteTable("user_ban", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  bannedBy: text("banned_by").references(() => user.id, { onDelete: "set null" }),
  reason: text("reason", { length: 500 }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  expiresAt: integer("expires_at", { mode: "timestamp" }),     // null = bezterminowo
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
  revokedBy: text("revoked_by").references(() => user.id, { onDelete: "set null" }),
}, (t) => [
  index("idx_user_ban_user").on(t.userId),
  index("idx_user_ban_created").on(t.createdAt),
]);

export const notification = sqliteTable("notification", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  type: text("type", { length: 64 }).notNull(),
  payload: text("payload").notNull().default("{}"),             // JSON
  readAt: integer("read_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, (t) => [index("idx_notification_user").on(t.userId, t.createdAt)]);

// BPMN 2.3: administrator/moderator proponuje awans, użytkownik akceptuje lub odrzuca.
export const promotionOffer = sqliteTable("promotion_offer", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  offeredBy: text("offered_by").references(() => user.id, { onDelete: "set null" }),
  targetRole: text("target_role", { enum: ["reviewer"] }).notNull().default("reviewer"),
  status: text("status", { enum: ["pending", "accepted", "rejected", "cancelled"] }).notNull().default("pending"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  respondedAt: integer("responded_at", { mode: "timestamp" }),
}, (t) => [index("idx_promotion_user").on(t.userId, t.status)]);

// Wizyty do statystyk panelu (hash odwiedzającego, bez przechowywania IP).
export const visitLog = sqliteTable("visit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  visitedAt: integer("visited_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  visitorHash: text("visitor_hash", { length: 32 }).notNull(),
}, (t) => [index("idx_visit_log_at").on(t.visitedAt)]);
