// The app's JSON request helper: how each API outcome reads to the person. Pure: fetch is replaced per test; no server or DOM.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ApiFailure, requestJson } from "../app/components/request";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function respond(status: number, body: unknown) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

async function failure(): Promise<ApiFailure> {
  try {
    await requestJson("/api/x");
  } catch (err) {
    assert.ok(err instanceof ApiFailure);
    return err;
  }
  throw new Error("expected a failure");
}

test("bare HTTP phrases are replaced by the app's own wording", async () => {
  const cases: Array<[number, unknown, RegExp]> = [
    [401, { error: "Unauthorized" }, /session may have expired/],
    [403, { error: "Forbidden" }, /don’t have access/],
    [404, { error: "Not found" }, /couldn’t be found/],
    [429, { error: "Too Many Requests" }, /Too many requests/],
    [500, { error: "Internal server error" }, /on SmartCA’s side/],
    [502, null, /on SmartCA’s side/],
  ];
  for (const [status, body, expected] of cases) {
    respond(status, body);
    const err = await failure();
    assert.match(err.message, expected, String(status));
    assert.equal(err.status, status);
    assert.ok(!/Unauthorized|Forbidden|Not found|Internal server error/.test(err.message), String(status));
  }
});

test("a 401 is marked as a session failure", async () => {
  respond(401, { error: "Unauthorized" });
  assert.equal((await failure()).code, "session");
});

test("validation, conflict and upload refusals keep the server's message and code", async () => {
  for (const [status, body] of [
    [400, { error: "category is required." }],
    [409, { error: "You have already uploaded this file.", code: "conflict" }],
    [415, { error: "That file isn’t a PDF.", code: "not_a_pdf" }],
    [422, { error: "Assessment year 2019-20 isn’t supported.", code: "unsupported_assessment_year" }],
  ] as const) {
    respond(status, body);
    const err = await failure();
    assert.equal(err.message, body.error, String(status));
    assert.equal(err.code, "code" in body ? body.code : undefined);
  }
});

test("a 5xx with a code keeps its written message (the tax engine's)", async () => {
  respond(500, { error: "The tax calculation could not be completed. Please try again later.", code: "tax_engine_error" });
  const err = await failure();
  assert.equal(err.message, "The tax calculation could not be completed. Please try again later.");
  assert.equal(err.code, "tax_engine_error");
});
