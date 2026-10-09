import Busboy from "busboy";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class UploadError extends Error {
  constructor(
    public readonly status: 400 | 413,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type ParsedFile = {
  path: string;
  size: number;
  mimeType: string;
  filename: string;
};

export type ParsedUpload = {
  fields: Record<string, string>;
  file: ParsedFile;
  /** Usuwa plik tymczasowy. Zawsze wołaj w `finally`. */
  cleanup: () => Promise<void>;
};

/**
 * Strumieniowo parsuje multipart/form-data: plik trafia na dysk (katalog tymczasowy),
 * a nie do pamięci, więc zużycie RAM nie zależy od rozmiaru pliku.
 *
 * Pola wymienione w `required` muszą być wysłane PRZED polem `file`.
 * Pozostałe (opcjonalne) pola mogą być przed albo po pliku.
 */
export async function parseMultipartUpload(
  req: Request,
  opts: { maxFileBytes: number; required: string[]; tmpDir?: string },
): Promise<ParsedUpload> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data/i.test(contentType) || !req.body) {
    throw new UploadError(400, "INVALID_CONTENT_TYPE", "Expected a multipart/form-data body");
  }

  const base = opts.tmpDir ?? tmpdir();
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "ml-upload-"));
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {});

  const state: {
    file?: ParsedFile;
    failure?: UploadError;
    filePromise?: Promise<void>;
  } = {};
  const fields: Record<string, string> = {};

  let bb: ReturnType<typeof Busboy>;
  try {
    bb = Busboy({
      headers: { "content-type": contentType },
      limits: { files: 1, fields: 30, fieldSize: 4096, fileSize: opts.maxFileBytes },
    });
  } catch {
    await cleanup();
    throw new UploadError(400, "INVALID_CONTENT_TYPE", "Malformed multipart header");
  }

  bb.on("field", (name, value, info) => {
    if (info.valueTruncated) {
      state.failure ??= new UploadError(400, "FIELD_TOO_LONG", `Field ${name} is too long`);
      return;
    }
    fields[name] = value;
  });

  bb.on("filesLimit", () => {
    state.failure ??= new UploadError(400, "TOO_MANY_FILES", "Send exactly one file");
  });

  bb.on("file", (name, stream, info) => {
    // Nadmiarowe / źle nazwane pliki ignorujemy (opróżniamy strumień).
    if (name !== "file" || state.file || state.filePromise || state.failure) {
      stream.resume();
      return;
    }

    const missing = opts.required.filter((k) => !(k in fields));
    if (missing.length > 0) {
      state.failure = new UploadError(
        400,
        "FIELDS_AFTER_FILE",
        `Send these fields before the file: ${missing.join(", ")}`,
      );
      stream.resume();
      return;
    }

    let truncated = false;
    stream.on("limit", () => { truncated = true; });

    const path = join(dir, "blob");
    state.filePromise = pipeline(stream, createWriteStream(path))
      .then(async () => {
        if (truncated) {
          const mb = Math.round(opts.maxFileBytes / 1024 / 1024);
          state.failure ??= new UploadError(413, "FILE_TOO_LARGE", `File is too large (max ${mb} MB)`);
          return;
        }
        const st = await stat(path);
        state.file = {
          path,
          size: st.size,
          mimeType: info.mimeType,
          filename: info.filename,
        };
      })
      .catch((err) => {
        console.error("[upload] could not write temp file:", err);
        state.failure ??= new UploadError(400, "UPLOAD_FAILED", "Could not read the uploaded file");
      });
  });

  const closed = new Promise<void>((resolve) => bb.once("close", () => resolve()));
  const source = Readable.fromWeb(req.body as any);

  try {
    await pipeline(source, bb);
    await closed;
    await state.filePromise;
  } catch {
    await cleanup();
    throw new UploadError(400, "INVALID_BODY", "Malformed or interrupted multipart body");
  }

  if (state.failure) {
    await cleanup();
    throw state.failure;
  }
  if (!state.file || state.file.size === 0) {
    await cleanup();
    throw new UploadError(400, "FILE_REQUIRED", "file is required");
  }

  return { fields, file: state.file, cleanup };
}
