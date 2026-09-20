// Tax-law retrieval security tests (Phase 5A). Mostly STATIC: they read the
// source files and pin the structure that keeps the corpus safe, because "no
// request handler can change the corpus" and "no user data reaches retrieval"
// are properties of how the code is wired, and the database has one role, so
// there is no grant to lean on. Plus error sanitisation, with a fake executor.
//
// What must hold:
//   - ingestion is a script, not a route, and nothing under app/ can reach it;
//   - the retrieval service only reads, takes no user id, touches no user
//     table, makes no network call, and uses no model or embedding;
//   - the corpus tables and migration contain no user linkage;
//   - a database error from retrieval never carries the question.
import "../db/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ValidationError } from "../services/errors";
import { retrieveTaxLaw } from "../services/tax-retrieval";

const FRONTEND = path.resolve(__dirname, "..");
const read = (relative: string) => fs.readFileSync(path.join(FRONTEND, relative), "utf8");

/** Source with comments removed, so a comment that MENTIONS a forbidden word is not a violation. */
const code = (relative: string) => read(relative).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) out.push(path.relative(FRONTEND, full).replace(/\\/g, "/"));
    }
  };
  walk(path.join(FRONTEND, directory));
  return out;
}

const RETRIEVAL = "services/tax-retrieval.ts";
const CORPUS_MODULES = ["lib/rag/corpus.ts", "lib/rag/load-corpus.ts", "services/tax-corpus.ts", "services/tax-retrieval.ts", "scripts/rag-ingest.ts"];

// --- request handlers cannot reach ingestion --------------------------------------

test("nothing under app/ can reach the ingestion path, so no request handler can change the corpus", () => {
  const forbidden = /tax-corpus|rag-ingest|load-corpus|rag-corpus/;
  const offenders = sourceFiles("app").filter((file) => forbidden.test(code(file)));
  assert.deepEqual(offenders, [], "no page or route imports the ingestion service, loader or script");
});

test("the ingestion service is imported by the ingestion script alone (and by tests)", () => {
  const importers = ["app", "services", "lib", "scripts", "db"]
    .flatMap(sourceFiles)
    .filter((file) => file !== "services/tax-corpus.ts" && /tax-corpus/.test(code(file)));
  assert.deepEqual(importers, ["scripts/rag-ingest.ts"]);
});

test("ingestion is a manual npm script and not an API route", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["rag:ingest"], "tsx scripts/rag-ingest.ts");
  const routes = sourceFiles("app/api").filter((f) => /route\.ts$/.test(f));
  assert.ok(routes.length > 0);
  assert.deepEqual(routes.filter((f) => /rag|corpus|ingest|retriev/i.test(f)), [], "Phase 5A adds no API route at all");
});

// --- the retrieval service only reads, and only the corpus ---------------------------

test("the retrieval service issues no write or DDL statement", () => {
  const source = code(RETRIEVAL);
  assert.doesNotMatch(source, /\.(insert|update|delete|transaction)\(/, "no query-builder writes");
  assert.doesNotMatch(source, /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|COPY)\b/, "no write or DDL SQL");
  assert.match(source, /\bSELECT\b/);
});

test("the retrieval service takes no user id and touches no user-owned table", () => {
  const source = code(RETRIEVAL);
  assert.doesNotMatch(source, /userId|user_id|ownerId|session|requireSessionUserId|getSessionUserId|@\/auth|next-auth/, "no identity of any kind");
  assert.doesNotMatch(
    source,
    /\b(transactions|documents|document_files|document_extractions|users|deductions|tax_computations|import_batches|assessment_years)\b/,
    "no user-owned table is named",
  );
  assert.doesNotMatch(source, /@\/db\/schema/, "it does not even import the schema; it queries the corpus tables by name");
  const tables = [...source.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/g)].map((m) => m[1]);
  assert.ok(tables.length >= 3);
  // Corpus tables, the set-returning unnest(), and the query's own CTE (q): nothing else.
  assert.ok(tables.every((t) => t.startsWith("tax_") || t === "unnest" || t === "q"), `unexpected table: ${tables.join(", ")}`);
});

test("retrieval and ingestion make no network call, log nothing, and use no model or embedding", () => {
  for (const file of CORPUS_MODULES) {
    const source = code(file);
    assert.doesNotMatch(source, /\bfetch\(|https?\.(get|request)|XMLHttpRequest|axios|node:https?|node:net\b|WebSocket/, `${file} must not use the network`);
    // (The full-text column is called search_vector: that is PostgreSQL text search, not an embedding.)
    assert.doesNotMatch(source, /openai|anthropic|embedding|langchain|\bllm\b|omniroute|pgvector|::vector|\bvector\(/i, `${file} must not use a model or embedding`);
    if (file !== "scripts/rag-ingest.ts") assert.doesNotMatch(source, /console\./, `${file} must not log`);
  }
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.deepEqual(names.filter((n) => /openai|anthropic|embed|langchain|llm|omniroute|pgvector|faiss|chroma|pinecone/i.test(n)), [], "no model, embedding or vector-database package is installed");
});

test("the retrieval service does not read the tax engine's arithmetic, so it cannot compute tax", () => {
  const source = code(RETRIEVAL);
  assert.doesNotMatch(source, /calculateTax|compareRegimes|tax-engine/, "evidence is not a calculation");
  // Its only figures are ranking scores, and its documentation says so.
  assert.match(read(RETRIEVAL), /not a probability and not a measure of correctness/);
});

// --- the corpus tables and migration hold no user data ---------------------------------

test("the corpus tables and migration have no user linkage", () => {
  const schema = read("db/schema.ts");
  const start = schema.indexOf("// Tax-law corpus (Phase 5A)");
  assert.ok(start > 0);
  const corpusSchema = schema.slice(start).replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(corpusSchema, /userId|user_id|users\.id|users\b/, "no user column or reference");
  assert.doesNotMatch(read("drizzle/0003_tax_corpus.sql"), /user/i);
});

test("the shipped corpus contains no personal or financial-record data", () => {
  const files = fs.readdirSync(path.join(FRONTEND, "rag-corpus", "ay-2026-27", "sources")).map((f) => path.join("rag-corpus", "ay-2026-27", "sources", f));
  assert.ok(files.length >= 2);
  for (const file of files) {
    const text = read(file);
    assert.doesNotMatch(text, /\b[A-Z]{5}\d{4}[A-Z]\b/, `${file}: a PAN-shaped value`);
    assert.doesNotMatch(text, /\b\d{4}\s?\d{4}\s?\d{4}\b/, `${file}: an Aadhaar-shaped number`);
    assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[\w.]+/, `${file}: an email address`);
    assert.doesNotMatch(text, /\b(password|api[_-]?key|secret|token)\b\s*[:=]/i, `${file}: a credential`);
  }
});

// --- errors ------------------------------------------------------------------------------

const SECRET = "SECRET-QUESTION-about-my-salary-98765432";
const failing = (error: unknown) => ({ execute: async () => { throw error; } }) as never;

test("a database error from retrieval never carries the question, only the database error code", async () => {
  const driverError = Object.assign(new Error(`Failed query: select ... params: ${SECRET},2026-27,${SECRET}`), { code: "57014" });
  await assert.rejects(
    () => retrieveTaxLaw({ question: SECRET, assessmentYear: "2026-27" }, failing(driverError)),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof ValidationError));
      assert.doesNotMatch(error.message, /SECRET|98765432|Failed query|params/);
      assert.match(error.message, /could not be completed \(database error 57014\)/);
      assert.equal((error as Error & { cause?: unknown }).cause, undefined, "the raw driver error is not attached");
      assert.doesNotMatch(String(error.stack), /SECRET|98765432/);
      return true;
    },
  );

  // A Drizzle-style wrapper whose code is on the cause.
  const wrapped = Object.assign(new Error(`Failed query: ${SECRET}`), { cause: Object.assign(new Error(SECRET), { code: "42P01" }) });
  await assert.rejects(
    () => retrieveTaxLaw({ question: SECRET, assessmentYear: "2026-27" }, failing(wrapped)),
    (error: unknown) => error instanceof Error && !/SECRET|98765432/.test(error.message) && /database error 42P01/.test(error.message),
  );

  // No code at all, or a code that is not a code: still generic, still nothing leaked.
  for (const bad of [new Error(SECRET), Object.assign(new Error(SECRET), { code: `x'; DROP TABLE tax_sources; -- ${SECRET}` })]) {
    await assert.rejects(
      () => retrieveTaxLaw({ question: SECRET, assessmentYear: "2026-27" }, failing(bad)),
      (error: unknown) => error instanceof Error && error.message === "Tax law retrieval could not be completed.",
    );
  }
});

test("input errors are validation errors and say nothing about the database", async () => {
  await assert.rejects(() => retrieveTaxLaw({ question: "", assessmentYear: "2026-27" }, failing(new Error("must not be reached"))), ValidationError);
  await assert.rejects(() => retrieveTaxLaw({ question: "rebate", assessmentYear: "bad" }, failing(new Error("must not be reached"))), ValidationError);
});
