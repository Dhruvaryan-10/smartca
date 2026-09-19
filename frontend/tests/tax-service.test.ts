// Tax service, persistence, and error-mapping tests.
//
// The trusted path is: authenticated user -> validated request -> server-side
// service -> deterministic engine -> trusted result -> optional persistence.
// These tests pin the properties that make that path trustworthy:
//   - the client supplies inputs only; nothing it says about identity, the
//     assessment-year row, versions or results is used;
//   - the server computes, and only the server-computed result is stored;
//   - every read and write is scoped to the requesting user;
//   - stored results are displayed as stored, never recomputed.
//
// DB-backed tests create throwaway users and delete them in `finally`
// (ON DELETE CASCADE removes everything they own), like the other Phase 1B
// service tests. Requires the seeded AY 2026-27 row (`npm run db:seed`).
import "../db/load-env"; // must run before anything that imports the DB client
import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { taxComputations } from "../db/schema";
import { deleteTestUser, getSeededAssessmentYearId, makeTestUser } from "./helpers";
import {
  computeTax,
  getTaxWorkspace,
  parseTaxRequest,
  saveTaxComputation,
} from "../services/tax";
import { listTaxComputationsForYear, saveTaxComputationRun } from "../services/tax-computations";
import { listDeductionsForYear } from "../services/deductions";
import { createTransaction } from "../services/transactions";
import { NotAuthenticatedError, NotFoundError, ValidationError } from "../services/errors";
import { respondToError } from "../app/api/_lib/respond-error";
import {
  compareRegimes,
  ENGINE_VERSION,
  TaxEngineInternalError,
  TaxInputValidationError,
  UnsupportedAssessmentYearError,
  UnsupportedTaxRuleError,
} from "../tax-engine";
import { MAX_MONEY_PAISE } from "../lib/money-input";

const rupees = (r: number) => r * 100;

/** A valid client request: ₹15,00,000 salary, 80C over the cap, structured 80D. */
function validBody(overrides: Record<string, unknown> = {}) {
  return {
    assessmentYear: "2026-27",
    ageCategory: "below60",
    income: { salaryPaise: rupees(15_00_000) },
    deductions: {
      section80CPaise: rupees(2_00_000),
      healthInsurance: { selfFamilyPaise: rupees(30_000), parentsPaise: rupees(10_000), anyParentIsSenior: false },
    },
    ...overrides,
  };
}

async function withUser<T>(label: string, fn: (userId: string) => Promise<T>): Promise<T> {
  const user = await makeTestUser(label);
  try {
    return await fn(user.id);
  } finally {
    await deleteTestUser(user.id);
  }
}

// ---------------------------------------------------------------------------
// Request parsing (pure)
// ---------------------------------------------------------------------------

test("parseTaxRequest builds engine input from a valid body and omits zero amounts", () => {
  const { assessmentYear, input } = parseTaxRequest(
    validBody({ income: { salaryPaise: rupees(10_00_000), businessPaise: 0, otherPaise: rupees(50_000) } }),
  );
  assert.equal(assessmentYear, "2026-27");
  assert.equal(input.assessmentYearLabel, "2026-27");
  assert.equal(input.ageCategory, "below60");
  assert.deepEqual(
    input.incomeSources.map((s) => [s.kind, s.amountPaise]),
    [
      ["salary", rupees(10_00_000)],
      ["other", rupees(50_000)],
    ],
  );
  assert.deepEqual(input.deductions, [
    { section: "80C", amountPaise: rupees(2_00_000) },
    { section: "80D", selfFamilyPaise: rupees(30_000), parentsPaise: rupees(10_000), spouseIsSenior: false, anyParentIsSenior: false },
  ]);
});

test("parseTaxRequest passes structured 80D senior flags through", () => {
  const { input } = parseTaxRequest(
    validBody({
      deductions: { healthInsurance: { selfFamilyPaise: rupees(50_000), parentsPaise: 0, spouseIsSenior: true } },
    }),
  );
  assert.deepEqual(input.deductions, [
    { section: "80D", selfFamilyPaise: rupees(50_000), parentsPaise: 0, spouseIsSenior: true, anyParentIsSenior: false },
  ]);
});

test("parseTaxRequest ignores everything the client is not allowed to decide", () => {
  const parsed = parseTaxRequest({
    ...validBody(),
    userId: "00000000-0000-4000-8000-000000000000",
    assessmentYearId: "00000000-0000-4000-8000-000000000001",
    resultTaxPaise: 1,
    result: { totalTaxPaise: 1 },
    tree: {},
    engineVersion: "tax-engine-v0",
    rulesVersion: "forged",
    regime: "old",
  });
  assert.deepEqual(Object.keys(parsed).sort(), ["assessmentYear", "input"]);
  assert.equal(JSON.stringify(parsed).includes("forged"), false);
  assert.equal(JSON.stringify(parsed).includes("00000000-0000-4000"), false);
  assert.equal("regime" in parsed.input, false, "regime is chosen by the comparison, never by the client");
});

test("parseTaxRequest rejects malformed requests with a validation error", () => {
  const bad: Array<[string, unknown]> = [
    ["null body", null],
    ["array body", []],
    ["string body", "hello"],
    ["missing assessment year", validBody({ assessmentYear: undefined })],
    ["non-string assessment year", validBody({ assessmentYear: 2026 })],
    ["malformed assessment year", validBody({ assessmentYear: "FY2026" })],
    ["missing age category", validBody({ ageCategory: undefined })],
    ["unknown age category", validBody({ ageCategory: "middle" })],
    ["missing income", validBody({ income: undefined })],
    ["income is an array", validBody({ income: [] })],
    ["all income zero", validBody({ income: { salaryPaise: 0 } })],
    ["no income fields", validBody({ income: {} })],
    ["negative income", validBody({ income: { salaryPaise: -1 } })],
    ["fractional paise", validBody({ income: { salaryPaise: 1.5 } })],
    ["income as a string", validBody({ income: { salaryPaise: "1500000" } })],
    ["NaN income", validBody({ income: { salaryPaise: Number.NaN } })],
    ["Infinity income", validBody({ income: { salaryPaise: Number.POSITIVE_INFINITY } })],
    ["income above the maximum", validBody({ income: { salaryPaise: MAX_MONEY_PAISE + 1 } })],
    ["unsafe integer income", validBody({ income: { salaryPaise: Number.MAX_SAFE_INTEGER + 2 } })],
    ["negative 80C", validBody({ deductions: { section80CPaise: -1 } })],
    ["80C above the maximum", validBody({ deductions: { section80CPaise: MAX_MONEY_PAISE + 1 } })],
    ["negative 80D self/family", validBody({ deductions: { healthInsurance: { selfFamilyPaise: -5 } } })],
    ["non-boolean senior flag", validBody({ deductions: { healthInsurance: { selfFamilyPaise: 1, anyParentIsSenior: "yes" } } })],
    ["deductions as an array", validBody({ deductions: [] })],
    ["healthInsurance as a string", validBody({ deductions: { healthInsurance: "x" } })],
  ];
  for (const [name, body] of bad) {
    assert.throws(() => parseTaxRequest(body), ValidationError, name);
  }
});

test("parseTaxRequest allows a request with no deductions", () => {
  const { input } = parseTaxRequest(validBody({ deductions: undefined }));
  assert.deepEqual(input.deductions, []);
  assert.deepEqual(parseTaxRequest(validBody({ deductions: {} })).input.deductions, []);
});

test("an assessment year with no engine rules is refused with the engine's typed error", () => {
  assert.throws(() => parseTaxRequest(validBody({ assessmentYear: "2031-32" })), UnsupportedAssessmentYearError);
});

// ---------------------------------------------------------------------------
// Compute (authenticated, server-side)
// ---------------------------------------------------------------------------

test("computeTax requires an authenticated user id", async () => {
  for (const missing of ["", "   ", undefined as unknown as string, null as unknown as string]) {
    await assert.rejects(() => computeTax(missing, validBody()), NotAuthenticatedError);
  }
});

test("computeTax returns the engine's comparison for the validated input, with AY metadata from the server", async () => {
  await withUser("compute", async (userId) => {
    const response = await computeTax(userId, validBody());

    assert.equal(response.assessmentYear.label, "2026-27");
    assert.equal(response.assessmentYear.financialYearLabel, "2025-26");
    assert.equal(response.assessmentYear.startDate, "2025-04-01");
    assert.equal(response.assessmentYear.endDate, "2026-03-31");

    // The result is exactly what the engine computes for that input.
    const expected = compareRegimes(parseTaxRequest(validBody()).input);
    assert.deepEqual(response.comparison, expected);
    assert.deepEqual(response.input, parseTaxRequest(validBody()).input);

    // Old regime: 80C clamped to ₹1,50,000 with the excess visible in the result.
    assert.equal(response.comparison.old.status, "ok");
    if (response.comparison.old.status === "ok") {
      const c80 = response.comparison.old.result.deductionAdjustments.find((a) => a.component === "80C");
      assert.deepEqual(c80, {
        component: "80C",
        declaredPaise: rupees(2_00_000),
        allowedPaise: rupees(1_50_000),
        capPaise: rupees(1_50_000),
      });
    }
  });
});

test("computeTax never reads client-supplied versions, results, ids or regime", async () => {
  await withUser("forged", async (userId) => {
    const honest = await computeTax(userId, validBody());
    const forged = await computeTax(userId, {
      ...validBody(),
      userId: "someone-else",
      assessmentYearId: "not-a-uuid",
      resultTaxPaise: 1,
      engineVersion: "tax-engine-v0",
      rulesVersion: "forged",
      regime: "old",
    });
    assert.deepEqual(forged, honest);
    assert.equal(forged.comparison.new.status, "ok");
    if (forged.comparison.new.status === "ok") {
      assert.equal(forged.comparison.new.result.engineVersion, ENGINE_VERSION);
      assert.notEqual(forged.comparison.new.result.rulesVersion, "forged");
    }
  });
});

test("computeTax refuses an unsupported assessment year before touching the database", async () => {
  await withUser("unsupported-ay", async (userId) => {
    await assert.rejects(() => computeTax(userId, validBody({ assessmentYear: "2031-32" })), UnsupportedAssessmentYearError);
  });
});

test("the ledger never feeds the computation: only the posted input counts", async () => {
  await withUser("ledger-ignored", async (userId) => {
    const before = await computeTax(userId, validBody());
    await createTransaction(userId, {
      type: "income",
      amountPaise: rupees(9_99_99_999),
      category: "Job",
      occurredOn: "2025-08-01",
    });
    const after = await computeTax(userId, validBody());
    assert.deepEqual(after, before);
  });
});

// ---------------------------------------------------------------------------
// Save (explicit, server-computed only)
// ---------------------------------------------------------------------------

test("saveTaxComputation stores the server-computed result for each regime, with versions", async () => {
  await withUser("save", async (userId) => {
    const ayId = await getSeededAssessmentYearId();
    const response = await saveTaxComputation(userId, {
      ...validBody(),
      // None of these may influence what is stored.
      resultTaxPaise: 1,
      engineVersion: "evil",
      rulesVersion: "evil",
      result: { totalTaxPaise: 1 },
    });

    assert.match(response.saved.runId, /^[0-9a-f-]{36}$/);
    assert.equal(response.saved.regimes.length, 2);

    const rows = await listTaxComputationsForYear(userId, ayId);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.regime).sort(), ["new", "old"]);

    for (const row of rows) {
      const stored = row.computationData as {
        schemaVersion: number;
        runId: string;
        input: unknown;
        result: { regime: string; totalTaxPaise: number; engineVersion: string; rulesVersion: string };
      };
      assert.equal(stored.schemaVersion, 1);
      assert.equal(stored.runId, response.saved.runId);
      assert.deepEqual(stored.input, response.input, "stores the server-validated input");
      assert.equal(stored.result.regime, row.regime);

      const outcome = row.regime === "old" ? response.comparison.old : response.comparison.new;
      assert.equal(outcome.status, "ok");
      if (outcome.status === "ok") {
        assert.deepEqual(stored.result, JSON.parse(JSON.stringify(outcome.result)));
        assert.equal(row.resultTaxPaise, outcome.result.totalTaxPaise);
      }
      assert.equal(row.engineVersion, "tax-engine-v2");
      assert.equal(row.rulesVersion, "ay-2026-27-v3");
      assert.equal(stored.result.engineVersion, "tax-engine-v2");
      assert.equal(stored.result.rulesVersion, "ay-2026-27-v3");
    }
  });
});

test("computing alone never saves anything", async () => {
  await withUser("no-autosave", async (userId) => {
    const ayId = await getSeededAssessmentYearId();
    await computeTax(userId, validBody());
    await computeTax(userId, validBody());
    assert.equal((await listTaxComputationsForYear(userId, ayId)).length, 0);
  });
});

test("saved computations and declared deductions are private to the user who saved them", async () => {
  const userA = await makeTestUser("owner-a");
  const userB = await makeTestUser("owner-b");
  try {
    const ayId = await getSeededAssessmentYearId();
    const saved = await saveTaxComputation(userA.id, validBody());

    assert.equal((await listTaxComputationsForYear(userA.id, ayId)).length, 2);
    assert.equal((await listTaxComputationsForYear(userB.id, ayId)).length, 0);
    assert.equal((await listDeductionsForYear(userB.id, ayId)).length, 0);

    const bWorkspace = await getTaxWorkspace(userB.id);
    assert.deepEqual(bWorkspace.savedRuns, []);
    const aWorkspace = await getTaxWorkspace(userA.id);
    assert.equal(aWorkspace.savedRuns.length, 1);
    assert.equal(aWorkspace.savedRuns[0].runId, saved.saved.runId);
  } finally {
    await deleteTestUser(userA.id);
    await deleteTestUser(userB.id);
  }
});

test("saving records declared deductions per section, updates them in place, and clears withdrawn ones", async () => {
  await withUser("deductions", async (userId) => {
    const ayId = await getSeededAssessmentYearId();

    await saveTaxComputation(userId, validBody()); // 80C ₹2,00,000; 80D ₹30,000 + ₹10,000
    let rows = await listDeductionsForYear(userId, ayId);
    assert.deepEqual(
      rows.map((r) => [r.section, r.amountPaise]).sort(),
      [
        ["80C", rupees(2_00_000)],
        ["80D", rupees(40_000)],
      ],
    );

    // Saving again updates the same rows (unique per user, year, section), never duplicates.
    await saveTaxComputation(userId, validBody({ deductions: { section80CPaise: rupees(1_00_000) } }));
    rows = await listDeductionsForYear(userId, ayId);
    assert.deepEqual(rows.map((r) => [r.section, r.amountPaise]), [["80C", rupees(1_00_000)]], "withdrawn 80D is removed");

    await saveTaxComputation(userId, validBody({ deductions: undefined }));
    assert.equal((await listDeductionsForYear(userId, ayId)).length, 0);
  });
});

test("the persistence service accepts only engine results, and rejects an inconsistent set atomically", async () => {
  await withUser("atomic", async (userId) => {
    const ayId = await getSeededAssessmentYearId();
    const input = parseTaxRequest(validBody()).input;
    const comparison = compareRegimes(input);
    assert.equal(comparison.old.status === "ok" && comparison.new.status === "ok", true);
    if (comparison.old.status !== "ok" || comparison.new.status !== "ok") return;

    // A result whose assessment year does not match the row it would be filed under is refused.
    const validResult = comparison.old.result;
    const wrongYear = { ...comparison.new.result, assessmentYearLabel: "2031-32" };
    await assert.rejects(
      () => saveTaxComputationRun(userId, { assessmentYearId: ayId, runId: "run-1", input, results: [validResult, wrongYear] }),
      ValidationError,
    );
    // Nothing was written, not even the valid first result.
    assert.equal((await listTaxComputationsForYear(userId, ayId)).length, 0);

    // An empty set is not a save.
    await assert.rejects(
      () => saveTaxComputationRun(userId, { assessmentYearId: ayId, runId: "run-2", input, results: [] }),
      ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

test("getTaxWorkspace describes the supported assessment year for a new user", async () => {
  await withUser("workspace", async (userId) => {
    const workspace = await getTaxWorkspace(userId);
    assert.equal(workspace.assessmentYear.label, "2026-27");
    assert.equal(workspace.assessmentYear.financialYearLabel, "2025-26");
    assert.deepEqual(workspace.supportedAssessmentYears, ["2026-27"]);
    assert.deepEqual(workspace.savedRuns, []);
    assert.equal(workspace.ledgerSuggestion, null);
    await assert.rejects(() => getTaxWorkspace(userId, "2031-32"), UnsupportedAssessmentYearError);
    await assert.rejects(() => getTaxWorkspace(""), NotAuthenticatedError);
  });
});

test("the ledger suggestion covers this user's income within the financial year only", async () => {
  const userA = await makeTestUser("suggest-a");
  const userB = await makeTestUser("suggest-b");
  try {
    const tx = (userId: string, type: string, rupeesAmount: number, category: string, occurredOn: string) =>
      createTransaction(userId, { type, amountPaise: rupees(rupeesAmount), category, occurredOn });

    await tx(userA.id, "income", 1_00_000, "Job", "2025-06-01"); // in
    await tx(userA.id, "income", 40_000, "Job", "2025-04-01"); // in (first day)
    await tx(userA.id, "income", 5_000, "Bonus", "2026-03-31"); // in (last day)
    await tx(userA.id, "income", 9_999, "Job", "2025-03-31"); // before the year
    await tx(userA.id, "income", 9_999, "Job", "2026-04-01"); // after the year
    await tx(userA.id, "expense", 20_000, "Rent", "2025-07-01"); // not income
    await tx(userB.id, "income", 7_77_777, "Job", "2025-06-01"); // someone else

    const workspace = await getTaxWorkspace(userA.id);
    assert.deepEqual(workspace.ledgerSuggestion, {
      fromDate: "2025-04-01",
      toDate: "2026-03-31",
      transactionCount: 3,
      incomeTotalPaise: rupees(1_45_000),
      categories: [
        { category: "Job", totalPaise: rupees(1_40_000) },
        { category: "Bonus", totalPaise: rupees(5_000) },
      ],
    });
  } finally {
    await deleteTestUser(userA.id);
    await deleteTestUser(userB.id);
  }
});

test("a saved computation is shown exactly as stored, never recomputed by the current engine", async () => {
  await withUser("no-recompute", async (userId) => {
    const ayId = await getSeededAssessmentYearId();
    await saveTaxComputation(userId, validBody());

    // Simulate a row written by an older engine version with a different figure.
    const [row] = await db
      .select()
      .from(taxComputations)
      .where(and(eq(taxComputations.userId, userId), eq(taxComputations.regime, "new")));
    const stored = row.computationData as { result: Record<string, unknown> };
    await db
      .update(taxComputations)
      .set({
        engineVersion: "tax-engine-v1",
        computationData: { ...stored, result: { ...stored.result, engineVersion: "tax-engine-v1", totalTaxPaise: 12_345 } },
      })
      .where(eq(taxComputations.id, row.id));
    assert.equal((await listTaxComputationsForYear(userId, ayId)).length, 2);

    const workspace = await getTaxWorkspace(userId);
    const run = workspace.savedRuns[0];
    assert.equal(run.results.new?.engineVersion, "tax-engine-v1");
    assert.equal(run.results.new?.totalTaxPaise, 12_345);
    // The other regime's row is untouched.
    assert.equal(run.results.old?.engineVersion, "tax-engine-v2");
    // The saved comparison is built from the STORED totals, not from a fresh calculation.
    assert.equal(run.numbers?.newTotalTaxPaise, 12_345);
    assert.equal(run.numbers?.oldTotalTaxPaise, run.results.old?.totalTaxPaise);
  });
});

test("the workspace skips stored rows it cannot interpret instead of failing", async () => {
  await withUser("corrupt-row", async (userId) => {
    const ayId = await getSeededAssessmentYearId();
    await db.insert(taxComputations).values({
      userId,
      assessmentYearId: ayId,
      regime: "new",
      engineVersion: "x",
      rulesVersion: "x",
      resultTaxPaise: 0,
      computationData: { schemaVersion: 99, unexpected: true },
    });
    const workspace = await getTaxWorkspace(userId);
    assert.deepEqual(workspace.savedRuns, []);
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

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

test("tax-engine errors map to distinct, client-safe responses", async () => {
  const malformed = await respond(new TaxInputValidationError("Income source \"Salary\" cannot be negative."));
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, "invalid_tax_input");
  assert.match(String(malformed.body.error), /cannot be negative/);

  const unsupportedYear = await respond(new UnsupportedAssessmentYearError("2031-32"));
  assert.equal(unsupportedYear.status, 422);
  assert.equal(unsupportedYear.body.code, "unsupported_assessment_year");
  assert.match(String(unsupportedYear.body.error), /2031-32/);

  const unsupportedRule = await respond(new UnsupportedTaxRuleError("This scenario is not supported."));
  assert.equal(unsupportedRule.status, 422);
  assert.equal(unsupportedRule.body.code, "unsupported_tax_rule");
  assert.match(String(unsupportedRule.body.error), /not supported/);
});

test("service-layer errors keep their existing mappings", async () => {
  assert.equal((await respond(new NotAuthenticatedError())).status, 401);
  assert.equal((await respond(new NotFoundError())).status, 404);
  const validation = await respond(new ValidationError("bad field"));
  assert.equal(validation.status, 400);
  assert.equal(validation.body.error, "bad field");
});

test("an engine self-check failure is a generic 500 that leaks nothing", async () => {
  const internal = await respond(new TaxEngineInternalError("tree failed reconciliation at C:\\secret\\path.ts:42 SELECT * FROM users"));
  assert.equal(internal.status, 500);
  assert.equal(internal.body.code, "tax_engine_error");
  const serialized = JSON.stringify(internal.body);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("SELECT"), false);
  assert.equal(serialized.includes("reconciliation"), false);
});

test("an unexpected error is a generic 500 that leaks nothing", async () => {
  const unexpected = await respond(new Error("connection to 10.0.0.5:5432 refused, password=hunter2"));
  assert.equal(unexpected.status, 500);
  assert.equal(JSON.stringify(unexpected.body).includes("hunter2"), false);
  assert.equal(unexpected.body.error, "Internal server error");
});
