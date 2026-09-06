import * as Minio from "minio";
import { Readable } from "node:stream";

const ENDPOINT   = process.env["MINIO_ENDPOINT"]   ?? "localhost";
const PORT       = parseInt(process.env["MINIO_PORT"] ?? "9000", 10);
const ACCESS     = process.env["MINIO_ROOT_USER"]     ?? "minioadmin";
const SECRET     = process.env["MINIO_ROOT_PASSWORD"] ?? "minioadmin";
const USE_SSL    = process.env["MINIO_USE_SSL"] === "true";

export const minioClient = new Minio.Client({
  endPoint:        ENDPOINT,
  port:            PORT,
  useSSL:          USE_SSL,
  accessKey:       ACCESS,
  secretKey:       SECRET,
});

export const BUCKETS = {
  photos:        "photos",
  videos:        "videos",
  reviewMedia:   "review-media",
  deviceImages:  "device-images",
} as const;

export type BucketName = (typeof BUCKETS)[keyof typeof BUCKETS];

export function storageUrl(bucket: BucketName, objectKey: string): string {
  return `minio://${bucket}/${objectKey}`;
}

export async function uploadStream(
  bucket: BucketName,
  objectKey: string,
  data: Buffer | ReadableStream<Uint8Array> | Readable,
  size: number,
  contentType?: string,
): Promise<void> {
  let payload: Buffer | Readable;

  if (data instanceof Buffer) {
    payload = data;
  } else if (typeof ReadableStream !== "undefined" && data instanceof ReadableStream) {
    payload = Readable.fromWeb(data as any);
  } else {
    payload = data as Readable;
  }

  const metaData = contentType ? { "Content-Type": contentType } : undefined;
  await minioClient.putObject(bucket, objectKey, payload, size, metaData);
}

export async function objectExists(bucket: BucketName, objectKey: string): Promise<boolean> {
  try {
    await minioClient.statObject(bucket, objectKey);
    return true;
  } catch {
    return false;
  }
}
