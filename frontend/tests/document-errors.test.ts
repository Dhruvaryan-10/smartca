// Response mapping for the Phase 4 error classes (409, 413, 415, 422), and a
// check that the existing mappings are unchanged. Pure apart from importing
// the route helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { respondToError } from "../app/api/_lib/respond-error";
import {
  ConflictError,
  NotAuthenticatedError,
  NotFoundError,
  PayloadTooLargeError,
  UnprocessableContentError,
  UnsupportedMediaTypeError,
  ValidationError,
} from "../services/errors";

async function respond(err: unknown) {
  const original = console.error;
  console.error = () => {}; // expected server-side logging for unexpected errors
  try {
    const res = respondToError(err);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } finally {
    console.error = original;
  }
}

test("a conflict is 409 with a stable code", async () => {
  const r = await respond(new ConflictError("This file has already been uploaded."));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "conflict");
  assert.equal(r.body.error, "This file has already been uploaded.");
});

test("an oversized upload is 413", async () => {
  const r = await respond(new PayloadTooLargeError("This PDF is larger than the 5 MB limit."));
  assert.equal(r.status, 413);
  assert.equal(r.body.code, "payload_too_large");
  assert.match(String(r.body.error), /5 MB/);
});

test("the wrong kind of file is 415, keeping the specific code", async () => {
  const generic = await respond(new UnsupportedMediaTypeError("Not supported."));
  assert.equal(generic.status, 415);
  assert.equal(generic.body.code, "unsupported_media_type");

  const specific = await respond(new UnsupportedMediaTypeError("This doesn’t look like a PDF.", "not_a_pdf"));
  assert.equal(specific.status, 415);
  assert.equal(specific.body.code, "not_a_pdf");
});

test("content that cannot be used is 422 with its code, and structured details when present", async () => {
  const encrypted = await respond(new UnprocessableContentError("This PDF is password-protected.", "pdf_encrypted"));
  assert.equal(encrypted.status, 422);
  assert.equal(encrypted.body.code, "pdf_encrypted");
  assert.equal("details" in encrypted.body, false, "no details key when there are none");

  const rows = [{ line: 3, message: "The date is empty.", column: "Date" }];
  const csv = await respond(new UnprocessableContentError("1 problem found.", "csv_validation_failed", { errorCount: 1, errors: rows }));
  assert.equal(csv.status, 422);
  assert.equal(csv.body.code, "csv_validation_failed");
  assert.deepEqual(csv.body.details, { errorCount: 1, errors: rows });
});

test("responses contain only the error, its code and details: never a stack, a path or an error name", async () => {
  const errors: unknown[] = [
    new ConflictError("c"),
    new PayloadTooLargeError("p"),
    new UnsupportedMediaTypeError("u"),
    new UnprocessableContentError("m", "code", { a: 1 }),
  ];
  for (const e of errors) {
    const r = await respond(e);
    assert.deepEqual(Object.keys(r.body).filter((k) => !["error", "code", "details"].includes(k)), []);
    assert.equal(JSON.stringify(r.body).includes(" at "), false);
  }
});

test("the existing mappings are unchanged", async () => {
  assert.equal((await respond(new NotAuthenticatedError())).status, 401);
  assert.equal((await respond(new NotFoundError())).status, 404);
  const validation = await respond(new ValidationError("bad field"));
  assert.equal(validation.status, 400);
  assert.equal(validation.body.error, "bad field");
  const unexpected = await respond(new Error("connection refused, password=hunter2"));
  assert.equal(unexpected.status, 500);
  assert.equal(JSON.stringify(unexpected.body).includes("hunter2"), false);
});

test("an unexpected error is logged as an error, but only once and without leaking into the response", async () => {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    const res = respondToError(new Error("boom"));
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Internal server error" });
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
});
