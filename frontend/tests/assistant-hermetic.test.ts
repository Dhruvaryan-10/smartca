// Phase 6 hardening (B7): the assistant's PURE code and PURE tests stay pure. It walks the static, load-time import graph of every
// pure entry point and fails if any path reaches the database client, the environment loader, or the real tools (which import
// the database), and it requires every assistant test that DOES need PostgreSQL to say so in its name (*.db.test.ts).
//
// This is a source check, not a runtime one: it cannot prove a test never needs a database at run time, but it does prove that
// importing these files cannot load a database client, which is what made the pure tests need DATABASE_URL before. The
// npm script `test:assistant-pure` runs the same files, and the suite also runs them with no DATABASE_URL in CI-style use.
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const FRONTEND = path.resolve(__dirname, "..");

/** Pure source: what an answer, an orchestrator run or a model guard is built from. */
const PURE_SOURCE = [
  "lib/assistant/answer.ts",
  "lib/assistant/answer-eval.ts",
  "lib/assistant/args.ts",
  "lib/assistant/failure.ts",
  "lib/assistant/tool-contract.ts",
  "services/assistant/model.ts",
  "services/assistant/orchestrator.ts",
  "services/assistant/ask.ts",
  "services/assistant/config.ts",
  "services/assistant/synthetic.ts",
  "services/assistant/synthetic-model.ts",
  "services/assistant/synthetic-tools.ts",
];
/** Pure test fixtures and tests: none may need a database to LOAD. */
const PURE_TESTS = [
  "tests/assistant-answer.test.ts",
  "tests/assistant-answer-eval.test.ts",
  "tests/assistant-answer-hardening.test.ts",
  "tests/assistant-config.test.ts",
  "tests/assistant-errors.test.ts",
  "tests/assistant-model-limits.test.ts",
  "tests/assistant-synthetic.test.ts",
  "tests/assistant-hermetic.test.ts",
  "tests/assistant-model.test.ts",
  "tests/assistant-orchestrator.test.ts",
  "tests/assistant-ask.test.ts",
];
const PURE_HELPERS = ["tests/helpers-answer.ts", "tests/helpers-errors.ts", "tests/helpers-orchestrator.ts"];

const FORBIDDEN_FILES = [
  "db/client.ts", "db/load-env.ts", "services/assistant/tools.ts", "services/tax-retrieval.ts", "services/tax.ts",
  "services/transactions.ts", "services/session.ts", "services/tax-corpus.ts",
];
const FORBIDDEN_PACKAGES = ["pg", "drizzle-orm", "next-auth", "next", "postgres", "dotenv"];

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Load-time imports only: `import x from`, `import "x"` and `export ... from`. `import type` is erased, and `import()` runs later. */
function runtimeSpecifiers(file: string): string[] {
  const source = stripComments(fs.readFileSync(path.join(FRONTEND, file), "utf8"));
  const found = new Set<string>();
  for (const m of source.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+["']([^"']+)["']/gm)) found.add(m[1]);
  for (const m of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) found.add(m[1]);
  return [...found];
}

function resolve(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/") ? path.join(FRONTEND, specifier.slice(2)) : specifier.startsWith(".") ? path.resolve(FRONTEND, path.dirname(from), specifier) : null;
  if (base === null) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), base]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.relative(FRONTEND, candidate).split(path.sep).join("/");
  }
  throw new Error(`${from}: cannot resolve "${specifier}"`);
}

/** Every project file and package a file loads, transitively. */
function closure(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of runtimeSpecifiers(file)) {
      const next = resolve(file, specifier);
      if (next !== null) queue.push(next);
      else if (!specifier.startsWith("node:")) packages.add(specifier.split("/")[0]);
    }
  }
  return { files, packages };
}

test("pure assistant source and pure tests cannot load a database client, the environment loader or the real tools", () => {
  for (const entry of [...PURE_SOURCE, ...PURE_HELPERS, ...PURE_TESTS]) {
    assert.ok(fs.existsSync(path.join(FRONTEND, entry)), `${entry} exists`);
    const { files, packages } = closure(entry);
    for (const forbidden of FORBIDDEN_FILES) assert.equal(files.has(forbidden), false, `${entry} loads ${forbidden}, so it would need a database to run`);
    for (const forbidden of FORBIDDEN_PACKAGES) assert.equal(packages.has(forbidden), false, `${entry} loads the package "${forbidden}"`);
  }
});

test("the checker itself works: the real tools DO reach the database client, so the walk would catch it", () => {
  const { files, packages } = closure("services/assistant/tools.ts");
  assert.ok(files.has("db/client.ts"), "tools.ts loads the database client through the services it uses");
  assert.ok(packages.has("drizzle-orm") || files.has("db/client.ts"));
  assert.ok(closure("tests/assistant-tools.db.test.ts").files.has("db/load-env.ts"), "and a DB test loads the environment");
});

test("every assistant test that needs PostgreSQL says so in its name, and every other assistant test is on the pure list", () => {
  const assistantTests = fs.readdirSync(path.join(FRONTEND, "tests")).filter((f) => /^assistant-.*\.test\.ts$/.test(f)).map((f) => `tests/${f}`);
  assert.ok(assistantTests.length >= 8, "the assistant test files were found");
  for (const file of assistantTests) {
    const needsDatabase = closure(file).files.has("db/client.ts");
    const labelled = file.endsWith(".db.test.ts");
    assert.equal(labelled, needsDatabase, `${file}: ${needsDatabase ? "loads the database client, so it must be named *.db.test.ts" : "is labelled .db but loads no database client"}`);
    if (!labelled) assert.ok(PURE_TESTS.includes(file), `${file} is pure, so it belongs on the PURE_TESTS list (and in the test:assistant-pure script)`);
  }
});

test("the test:assistant-pure npm script runs exactly the pure assistant tests", () => {
  const scripts = (JSON.parse(fs.readFileSync(path.join(FRONTEND, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  const listed = (scripts["test:assistant-pure"] ?? "").split(/\s+/).filter((token) => token.endsWith(".test.ts")).sort();
  assert.deepEqual(listed, [...PURE_TESTS].sort());
});
