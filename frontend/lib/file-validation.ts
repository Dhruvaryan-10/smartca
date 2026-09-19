// Upload safety, in one place. Everything here works on BYTES, never on what
// the browser claims: the declared MIME type is only a courtesy check, the
// file name is only ever a display label (it is never used to build a path),
// and sizes are measured on the data actually received.
//
// Errors are the shared service errors, so routes map them to 400/413/415/422
// through the existing `respondToError`. Messages are written for the person
// uploading and never contain any of the file's content.
import { createHash } from "node:crypto";
import {
  PayloadTooLargeError,
  UnprocessableContentError,
  UnsupportedMediaTypeError,
  ValidationError,
} from "../services/errors";

export const MAX_PDF_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_PAGES = 20;
export const MAX_CSV_BYTES = 2 * 1024 * 1024;
export const MAX_CSV_ROWS = 5000;
/** Room for the multipart envelope around a file at its size limit. */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

const MEGABYTE = 1024 * 1024;
const megabytes = (bytes: number) => `${bytes / MEGABYTE} MB`;

// ---------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const EOF_MARKER = "%%EOF";

/**
 * Cheap structural checks before any parser sees the file: not empty, within
 * the size limit, starts with the PDF magic bytes, and ends with an
 * end-of-file marker (a cut-off download does not).
 */
export function checkPdfBytes(bytes: Uint8Array): void {
  if (bytes.length === 0) throw new ValidationError("The file is empty.");
  if (bytes.length > MAX_PDF_BYTES) {
    throw new PayloadTooLargeError(`This PDF is larger than the ${megabytes(MAX_PDF_BYTES)} limit.`);
  }
  if (!PDF_MAGIC.every((b, i) => bytes[i] === b)) {
    throw new UnsupportedMediaTypeError("This doesn\u2019t look like a PDF. Upload the PDF file itself.", "not_a_pdf");
  }
  const tail = new TextDecoder("latin1").decode(bytes.subarray(Math.max(0, bytes.length - 1024)));
  if (!tail.includes(EOF_MARKER)) {
    throw new UnprocessableContentError(
      "This PDF looks incomplete or damaged. Download it again and retry.",
      "pdf_corrupt",
    );
  }
}

// ---------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------

// Leading bytes of common binary formats people might rename to .csv.
const BINARY_SIGNATURES: number[][] = [
  [0x25, 0x50, 0x44, 0x46, 0x2d], // PDF
  [0x50, 0x4b, 0x03, 0x04], // ZIP / xlsx / docx
  [0xd0, 0xcf, 0x11, 0xe0], // legacy Office
  [0xff, 0xd8, 0xff], // JPEG
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0x47, 0x49, 0x46, 0x38], // GIF
];

/** Validate and decode a CSV upload as UTF-8 text. Refuses anything that is not plainly a UTF-8 text file. */
export function decodeCsvBytes(bytes: Uint8Array): string {
  if (bytes.length === 0) throw new ValidationError("The file is empty.");
  if (bytes.length > MAX_CSV_BYTES) {
    throw new PayloadTooLargeError(`This file is larger than the ${megabytes(MAX_CSV_BYTES)} limit.`);
  }
  const looksBinary =
    bytes.includes(0) || BINARY_SIGNATURES.some((sig) => sig.every((b, i) => bytes[i] === b));
  if (looksBinary) {
    throw new UnsupportedMediaTypeError(
      "This doesn\u2019t look like a CSV text file. Export or save it as CSV and try again.",
      "csv_binary",
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new UnsupportedMediaTypeError(
      "This file isn\u2019t UTF-8 text. In Excel, save it as \u201CCSV UTF-8\u201D and try again.",
      "csv_not_utf8",
    );
  }
}

// ---------------------------------------------------------------------
// Declared content type, names, hashing
// ---------------------------------------------------------------------

/**
 * A courtesy check on what the browser said the file is. It is NOT the
 * security check (the bytes are); it just gives a clearer error early.
 * Missing and generic types are accepted.
 */
export function assertDeclaredContentType(declared: string | null | undefined, allowed: string[]): void {
  const type = (declared ?? "").split(";")[0].trim().toLowerCase();
  if (type === "" || type === "application/octet-stream" || allowed.includes(type)) return;
  throw new UnsupportedMediaTypeError("This kind of file isn\u2019t supported here.");
}

const MAX_FILENAME_LENGTH = 200;

/**
 * A safe DISPLAY name. Drops any directory part, control characters and
 * characters that are special in file systems or headers, and limits the
 * length while keeping the extension. Never used to build a path.
 */
export function sanitizeFilename(name: unknown): string {
  if (typeof name !== "string") return "document";
  const lastSegment = name.split(/[\\/]/).pop() ?? "";
  const cleaned = lastSegment
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  if (cleaned === "") return "document";
  if (cleaned.length <= MAX_FILENAME_LENGTH) return cleaned;

  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, MAX_FILENAME_LENGTH - extension.length) + extension;
}

/**
 * A `Content-Disposition` value that forces a download. The plain
 * `filename` is ASCII-only with anything risky replaced, so no name can
 * inject header content; `filename*` carries the real name percent-encoded.
 */
export function contentDispositionAttachment(filename: string): string {
  const safe = sanitizeFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_").replace(/["\\%]/g, "_");
  const isAscii = ascii === safe;
  return isAscii
    ? `attachment; filename="${ascii}"`
    : `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------

/**
 * Read a request body with a hard cap. Next.js buffers a proxied body in
 * memory and silently truncates it past its own limit, so the framework
 * cannot be relied on to refuse an oversized upload. This refuses up front
 * when Content-Length is too big, and stops reading if a body exceeds the
 * cap regardless of what its headers claimed.
 */
export async function readLimitedBody(req: Request, maxBytes: number): Promise<Uint8Array> {
  const tooLarge = () => new PayloadTooLargeError(`The upload is larger than the ${megabytes(maxBytes)} limit.`);

  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  if (!req.body) return new Uint8Array(0);

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

/** Parse multipart/form-data from an already size-limited buffer. */
export async function parseMultipartBody(bytes: Uint8Array, contentType: string): Promise<FormData> {
  if (!/^multipart\/form-data/i.test(contentType ?? "")) {
    throw new ValidationError("Send the file as multipart/form-data.");
  }
  try {
    return await new Response(bytes as BodyInit, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new ValidationError("The upload could not be read. Try again.");
  }
}

export type UploadedFile = { filename: string; declaredContentType: string; bytes: Uint8Array };

export async function readUploadedFile(form: FormData, field: string): Promise<UploadedFile> {
  const entry = form.get(field);
  if (!(entry instanceof File)) throw new ValidationError("No file was uploaded.");
  return {
    filename: sanitizeFilename(entry.name),
    declaredContentType: entry.type,
    bytes: new Uint8Array(await entry.arrayBuffer()),
  };
}

/**
 * Read a multipart upload safely: the body is capped BEFORE it is parsed
 * (file limit plus envelope), then the file and the other fields are read
 * from that bounded buffer.
 */
export async function readMultipartUpload(
  req: Request,
  maxFileBytes: number,
  field = "file",
): Promise<{ file: UploadedFile; form: FormData }> {
  const body = await readLimitedBody(req, maxFileBytes + MULTIPART_OVERHEAD_BYTES);
  const form = await parseMultipartBody(body, req.headers.get("content-type") ?? "");
  const file = await readUploadedFile(form, field);
  return { file, form };
}

const MAX_JSON_FIELD_LENGTH = 10_000;

/** An optional form field holding JSON text (for example a CSV column mapping). Undefined when absent. */
export function readJsonField(form: FormData, name: string, maxLength = MAX_JSON_FIELD_LENGTH): unknown {
  const value = form.get(name);
  if (value === null) return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new ValidationError(`${name} must be JSON text.`);
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new ValidationError(`${name} is not valid JSON.`);
  }
}
