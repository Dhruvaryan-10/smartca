// Upload-safety tests. Pure — no database, session, or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CSV_BYTES,
  MAX_PDF_BYTES,
  assertDeclaredContentType,
  checkPdfBytes,
  contentDispositionAttachment,
  decodeCsvBytes,
  parseMultipartBody,
  readJsonField,
  readLimitedBody,
  readMultipartUpload,
  readUploadedFile,
  sanitizeFilename,
  sha256Hex,
} from "../lib/file-validation";
import {
  PayloadTooLargeError,
  UnprocessableContentError,
  UnsupportedMediaTypeError,
  ValidationError,
} from "../services/errors";

const enc = (s: string) => new TextEncoder().encode(s);
const minimalPdf = () => enc("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

// --- PDF bytes ---------------------------------------------------------

test("checkPdfBytes accepts something shaped like a complete PDF", () => {
  assert.doesNotThrow(() => checkPdfBytes(minimalPdf()));
});

test("checkPdfBytes rejects an empty file", () => {
  assert.throws(() => checkPdfBytes(new Uint8Array(0)), ValidationError);
});

test("checkPdfBytes enforces the size limit on the actual bytes", () => {
  const big = new Uint8Array(MAX_PDF_BYTES + 1);
  big.set(enc("%PDF-1.4"));
  assert.throws(() => checkPdfBytes(big), PayloadTooLargeError);

  const atLimit = new Uint8Array(MAX_PDF_BYTES);
  atLimit.set(enc("%PDF-1.4"));
  atLimit.set(enc("\n%%EOF\n"), MAX_PDF_BYTES - 8);
  assert.doesNotThrow(() => checkPdfBytes(atLimit));
});

test("checkPdfBytes uses magic bytes, not the file name or claimed type", () => {
  for (const notPdf of [enc("date,amount\n2026-03-05,100\n"), enc("<html>%PDF-</html>"), enc("PK\u0003\u0004zip"), new Uint8Array([0xff, 0xd8, 0xff])]) {
    assert.throws(
      () => checkPdfBytes(notPdf),
      (e: unknown) => e instanceof UnsupportedMediaTypeError && e.code === "not_a_pdf",
    );
  }
  // Leading whitespace or junk before the header is not accepted either.
  assert.throws(() => checkPdfBytes(enc("\n%PDF-1.4\n%%EOF")), UnsupportedMediaTypeError);
});

test("checkPdfBytes rejects a truncated PDF (no end-of-file marker)", () => {
  assert.throws(
    () => checkPdfBytes(enc("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n")),
    (e: unknown) => e instanceof UnprocessableContentError && e.code === "pdf_corrupt",
  );
});

// --- CSV bytes ---------------------------------------------------------

test("decodeCsvBytes returns UTF-8 text, dropping a byte-order mark", () => {
  assert.equal(decodeCsvBytes(enc("date,amount\n2026-03-05,100\n")), "date,amount\n2026-03-05,100\n");
  assert.equal(decodeCsvBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...enc("a,b")])), "a,b");
  assert.equal(decodeCsvBytes(enc("Caf\u00e9,₹100")), "Caf\u00e9,₹100");
});

test("decodeCsvBytes rejects empty files and files over the limit", () => {
  assert.throws(() => decodeCsvBytes(new Uint8Array(0)), ValidationError);
  assert.throws(() => decodeCsvBytes(new Uint8Array(MAX_CSV_BYTES + 1).fill(97)), PayloadTooLargeError);
  assert.doesNotThrow(() => decodeCsvBytes(new Uint8Array(MAX_CSV_BYTES).fill(97)));
});

test("decodeCsvBytes rejects binary content (NUL bytes) and PDFs disguised as CSV", () => {
  for (const binary of [new Uint8Array([97, 44, 0, 98]), minimalPdf(), new Uint8Array([0xff, 0xfe, 97, 0])]) {
    assert.throws(
      () => decodeCsvBytes(binary),
      (e: unknown) => e instanceof UnsupportedMediaTypeError,
    );
  }
  assert.throws(() => decodeCsvBytes(enc("\u0000")), UnsupportedMediaTypeError);
});

test("decodeCsvBytes rejects text that is not valid UTF-8 instead of guessing an encoding", () => {
  // 0xE9 alone is "é" in Windows-1252 but an invalid UTF-8 sequence.
  assert.throws(
    () => decodeCsvBytes(new Uint8Array([100, 97, 116, 101, 0xe9])),
    (e: unknown) => e instanceof UnsupportedMediaTypeError && e.code === "csv_not_utf8",
  );
});

// --- declared content type ---------------------------------------------

test("assertDeclaredContentType accepts allowed, generic and missing types, and rejects the rest", () => {
  const allowed = ["application/pdf"];
  for (const ok of ["application/pdf", "APPLICATION/PDF", "application/pdf; charset=binary", "", undefined, null, "application/octet-stream"]) {
    assert.doesNotThrow(() => assertDeclaredContentType(ok, allowed), String(ok));
  }
  for (const bad of ["image/png", "text/html", "application/zip", "application/javascript"]) {
    assert.throws(() => assertDeclaredContentType(bad, allowed), UnsupportedMediaTypeError, bad);
  }
});

// --- file names --------------------------------------------------------

test("sanitizeFilename keeps a plain name and strips any path", () => {
  assert.equal(sanitizeFilename("form16-fy2025-26.pdf"), "form16-fy2025-26.pdf");
  assert.equal(sanitizeFilename("C:\\Users\\me\\Desktop\\Form 16.pdf"), "Form 16.pdf");
  assert.equal(sanitizeFilename("/etc/passwd"), "passwd");
  assert.equal(sanitizeFilename("../../../secret.pdf"), "secret.pdf");
  assert.equal(sanitizeFilename("a/b/c.csv"), "c.csv");
});

test("sanitizeFilename removes control characters, leading dots and awkward symbols", () => {
  assert.equal(sanitizeFilename("bad\u0000name\u0007.pdf"), "badname.pdf");
  assert.equal(sanitizeFilename("..hidden.pdf"), "hidden.pdf");
  assert.equal(sanitizeFilename('we<ir>d:"name"|?*.pdf'), "weirdname.pdf");
  assert.equal(sanitizeFilename("  spaced   out  .pdf "), "spaced out .pdf");
  assert.equal(sanitizeFilename("statement \u20B9 2026.csv"), "statement \u20B9 2026.csv");
});

test("sanitizeFilename falls back to a safe default and limits length", () => {
  for (const empty of ["", "   ", "...", "///", "\u0000", null, undefined, 42]) {
    assert.equal(sanitizeFilename(empty as unknown as string), "document");
  }
  const long = sanitizeFilename("x".repeat(500) + ".pdf");
  assert.ok(long.length <= 200);
  assert.ok(long.endsWith(".pdf"), "the extension survives truncation");
});

test("contentDispositionAttachment always forces a download and cannot be header-injected", () => {
  const plain = contentDispositionAttachment("Form 16.pdf");
  assert.match(plain, /^attachment;/);
  assert.match(plain, /filename="Form 16.pdf"/);

  const nasty = contentDispositionAttachment('evil"\r\nSet-Cookie: x=1.pdf');
  assert.equal(/[\r\n]/.test(nasty), false);
  assert.equal(nasty.startsWith("attachment;"), true);

  const unicode = contentDispositionAttachment("stat\u00e9ment \u20B9.pdf");
  assert.match(unicode, /filename\*=UTF-8''/);
  assert.equal(/[^\x20-\x7e]/.test(unicode), false, "header value is ASCII-only");
});

// --- hashing -----------------------------------------------------------

test("sha256Hex is the standard hex digest", () => {
  assert.equal(sha256Hex(enc("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex(new Uint8Array(0)), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

// --- request bodies ----------------------------------------------------

function requestWith(body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Request("http://localhost/upload", { method: "POST", body, headers, duplex: "half" } as RequestInit);
}

test("readLimitedBody returns the bytes when within the limit", async () => {
  const bytes = await readLimitedBody(requestWith("hello world"), 100);
  assert.equal(new TextDecoder().decode(bytes), "hello world");
  assert.equal((await readLimitedBody(requestWith(null), 100)).length, 0);
});

test("readLimitedBody refuses an oversized body without reading it, when Content-Length says so", async () => {
  let pulled = false;
  // highWaterMark 0: the stream is not pulled until somebody actually reads it.
  const stream = new ReadableStream(
    {
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array(10));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  await assert.rejects(
    () => readLimitedBody(requestWith(stream, { "content-length": "999999" }), 100),
    PayloadTooLargeError,
  );
  assert.equal(pulled, false, "the body was never read");
});

test("readLimitedBody stops reading an oversized body that lies about, or omits, its length", async () => {
  await assert.rejects(() => readLimitedBody(requestWith(new Uint8Array(500)), 100), PayloadTooLargeError);
  await assert.rejects(
    () => readLimitedBody(requestWith(new Uint8Array(500), { "content-length": "10" }), 100),
    PayloadTooLargeError,
  );
});

test("multipart bodies are parsed from the bounded buffer, and readUploadedFile returns a sanitized name", async () => {
  const form = new FormData();
  form.set("documentType", "form16");
  form.set("file", new File([enc("%PDF-1.4 ... %%EOF")], "../../Form 16.pdf", { type: "application/pdf" }));
  const res = new Response(form);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const contentType = res.headers.get("content-type")!;

  const parsed = await parseMultipartBody(bytes, contentType);
  assert.equal(parsed.get("documentType"), "form16");
  const file = await readUploadedFile(parsed, "file");
  assert.equal(file.filename, "Form 16.pdf");
  assert.equal(file.declaredContentType, "application/pdf");
  assert.equal(new TextDecoder().decode(file.bytes), "%PDF-1.4 ... %%EOF");
});

test("malformed multipart, the wrong content type, and a missing file are validation errors, not crashes", async () => {
  await assert.rejects(() => parseMultipartBody(enc("not multipart"), "multipart/form-data; boundary=xyz"), ValidationError);
  await assert.rejects(() => parseMultipartBody(enc("{}"), "application/json"), ValidationError);
  await assert.rejects(() => parseMultipartBody(enc("x"), ""), ValidationError);

  const form = new FormData();
  form.set("notfile", "text");
  await assert.rejects(() => readUploadedFile(form, "file"), ValidationError);
  form.set("file", "a plain string, not a file");
  await assert.rejects(() => readUploadedFile(form, "file"), ValidationError);
});

// --- the route-facing helpers -----------------------------------------------

function multipartRequest(build: (form: FormData) => void, headers: Record<string, string> = {}) {
  const form = new FormData();
  build(form);
  const probe = new Response(form);
  const contentType = probe.headers.get("content-type")!;
  return probe.arrayBuffer().then(
    (body) => new Request("http://localhost/upload", { method: "POST", body, headers: { "content-type": contentType, ...headers } }),
  );
}

test("readMultipartUpload returns the file and the other form fields, through the size cap", async () => {
  const req = await multipartRequest((f) => {
    f.set("mapping", '{"a":1}');
    f.set("file", new File([enc("hello")], "../x.csv", { type: "text/csv" }));
  });
  const { file, form } = await readMultipartUpload(req, 1000);
  assert.equal(file.filename, "x.csv");
  assert.equal(new TextDecoder().decode(file.bytes), "hello");
  assert.equal(form.get("mapping"), '{"a":1}');
});

test("readMultipartUpload refuses a body larger than the file limit plus envelope, without parsing it", async () => {
  const req = await multipartRequest((f) => f.set("file", new File([new Uint8Array(200_000)], "big.pdf")), { "content-length": "999999999" });
  await assert.rejects(() => readMultipartUpload(req, 1000), PayloadTooLargeError);
});

test("readMultipartUpload rejects a request with no file", async () => {
  const req = await multipartRequest((f) => f.set("other", "x"));
  await assert.rejects(() => readMultipartUpload(req, 1000), ValidationError);
});

test("readJsonField reads an optional JSON string field and refuses anything malformed", () => {
  const form = new FormData();
  assert.equal(readJsonField(form, "mapping"), undefined);
  form.set("mapping", '{"delimiter":","}');
  assert.deepEqual(readJsonField(form, "mapping"), { delimiter: "," });
  form.set("mapping", "{not json");
  assert.throws(() => readJsonField(form, "mapping"), ValidationError);
  form.set("mapping", new File([enc("{}")], "m.json"));
  assert.throws(() => readJsonField(form, "mapping"), ValidationError);
  form.set("mapping", "x".repeat(20_000));
  assert.throws(() => readJsonField(form, "mapping"), ValidationError, "an absurdly long field is refused before parsing");
});
