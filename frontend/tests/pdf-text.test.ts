// PDF text-reading tests, against PDFs built in tests/helpers-pdf.ts.
// Pure — no database, session, or network.
//
// What must hold: a text PDF yields positioned text; anything we cannot or
// must not read (password-protected, scanned, over the page limit, corrupt)
// is refused with a specific, content-free error, and no raw parser message
// ever escapes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PDF_READ_LIMITS, readPdfText } from "../lib/pdf-text";
import { MAX_PDF_PAGES } from "../lib/file-validation";
import { UnprocessableContentError } from "../services/errors";
import { buildCompressedPdf, buildPdf, linesToPlacements } from "./helpers-pdf";

const rejectsWith = (code: string) => (e: unknown) => e instanceof UnprocessableContentError && e.code === code;

test("a text PDF yields its text with page numbers and positions", async () => {
  const bytes = buildPdf([
    linesToPlacements([[[50, "Gross Salary"], [400, "12,00,000.00"]], [[50, "Standard deduction"], [400, "75,000.00"]]]),
    linesToPlacements([[[50, "Second page text"]]]),
  ]);
  const { pages, pageCount } = await readPdfText(bytes);

  assert.equal(pageCount, 2);
  assert.deepEqual(pages.map((p) => p.page), [1, 2]);
  const texts = pages[0].items.map((i) => i.text.trim()).filter(Boolean);
  assert.ok(texts.includes("Gross Salary"), JSON.stringify(texts));
  assert.ok(texts.includes("12,00,000.00"), JSON.stringify(texts));
  assert.ok(pages[1].items.some((i) => i.text.includes("Second page text")));

  // Positions are real: the amount sits to the right of, and level with, its label.
  const label = pages[0].items.find((i) => i.text.includes("Gross Salary"))!;
  const amount = pages[0].items.find((i) => i.text.includes("12,00,000.00"))!;
  assert.ok(amount.x > label.x + 100);
  assert.ok(Math.abs(amount.y - label.y) < 2);
  // The first line is higher on the page than the second.
  const second = pages[0].items.find((i) => i.text.includes("Standard deduction"))!;
  assert.ok(label.y > second.y);
});

test("the reader does not consume or mutate the caller's bytes", async () => {
  const bytes = buildPdf([linesToPlacements([[[50, "Gross Salary"], [400, "12,00,000.00"]], [[50, "Standard deduction"], [400, "75,000.00"]]])]);
  const copy = bytes.slice();
  await readPdfText(bytes);
  assert.deepEqual(bytes, copy);
  await readPdfText(bytes); // and it can be read again
});

test("a scanned (no text layer) PDF is refused as scanned", async () => {
  await assert.rejects(() => readPdfText(buildPdf([[], []])), rejectsWith("pdf_scanned"));
});

test("a PDF with almost no text is treated as scanned rather than extracted from", async () => {
  await assert.rejects(() => readPdfText(buildPdf([linesToPlacements([[[50, "x"]]])])), rejectsWith("pdf_scanned"));
});

test("a password-protected PDF is refused as encrypted, and no password is requested or accepted", async () => {
  const encrypted = buildPdf([linesToPlacements([[[50, "Gross Salary"], [400, "12,00,000.00"]]])], { encrypted: true });
  await assert.rejects(() => readPdfText(encrypted), rejectsWith("pdf_encrypted"));
});

test("a PDF over the page limit is refused", async () => {
  const many = buildPdf(Array.from({ length: MAX_PDF_PAGES + 1 }, () => linesToPlacements([[[50, "A page with enough text to count"]]])));
  await assert.rejects(() => readPdfText(many), rejectsWith("pdf_too_many_pages"));

  const atLimit = buildPdf(Array.from({ length: MAX_PDF_PAGES }, () => linesToPlacements([[[50, "A page with enough text to count"]]])));
  const { pageCount } = await readPdfText(atLimit);
  assert.equal(pageCount, MAX_PDF_PAGES);
});

test("a corrupt PDF is refused as corrupt, with a message that carries no parser detail", async () => {
  const garbage = new TextEncoder().encode("%PDF-1.4\nthis is not a real pdf body at all, just words\n%%EOF\n");
  await assert.rejects(
    () => readPdfText(garbage),
    (e: unknown) => {
      assert.ok(e instanceof UnprocessableContentError);
      assert.equal(e.code, "pdf_corrupt");
      assert.doesNotMatch(e.message, /Exception|stack|at .*\(|pdfjs|Invalid PDF structure/i);
      return true;
    },
  );
});

test("a structurally broken cross-reference table does not crash the process", async () => {
  const good = buildPdf([linesToPlacements([[[50, "Gross Salary"], [400, "12,00,000.00"]]])]);
  const text = new TextDecoder().decode(good).replace("startxref\n", "startxref\n99999");
  // Either it recovers and reads, or it is refused with our error; it must never throw anything else.
  try {
    await readPdfText(new TextEncoder().encode(text));
  } catch (e) {
    assert.ok(e instanceof UnprocessableContentError, String(e));
  }
});

// --- resource limits -----------------------------------------------------------
//
// A small compressed PDF can stand for millions of text items. The limits must
// be enforced WHILE the file is read, so an over-complex file is refused
// without being expanded in full, and stopping must not leave stray errors
// behind (cancelling pdf.js's text stream throws an uncaught ERR_INVALID_STATE).

const NO_LIMITS = { maxTextItems: Infinity, maxTextCharacters: Infinity, timeoutMs: 120_000 };
const timed = async <T>(work: () => Promise<T>): Promise<{ ms: number; error?: unknown; value?: T }> => {
  const start = performance.now();
  try {
    const value = await work();
    return { ms: performance.now() - start, value };
  } catch (error) {
    return { ms: performance.now() - start, error };
  }
};

test("the default limits are the documented ones", () => {
  assert.deepEqual(PDF_READ_LIMITS, { maxTextItems: 100_000, maxTextCharacters: 1_000_000, timeoutMs: 20_000 });
});

test("a compressed file of far more text items than the default cap is refused as too complex", async () => {
  const bomb = buildCompressedPdf(1_000_000); // ~100 KB on disk, a million text items when expanded
  assert.ok(bomb.length < 500_000, `fixture should be small, was ${bomb.length} bytes`);
  await assert.rejects(() => readPdfText(bomb), rejectsWith("pdf_too_complex"));
});

test("the item cap is enforced during reading: a capped read stops long before a full read would finish", async () => {
  const bomb = buildCompressedPdf(400_000);

  const full = await timed(() => readPdfText(bomb, NO_LIMITS));
  assert.ok(full.value, "the uncapped control read should complete");
  assert.equal(full.value.pages[0].items.length, 400_000);

  const capped = await timed(() => readPdfText(bomb, { maxTextItems: 500 }));
  assert.ok(rejectsWith("pdf_too_complex")(capped.error), String(capped.error));
  // Extraction after the cap is not carried out: reading 500 items is a tiny fraction of reading 400,000.
  assert.ok(capped.ms * 4 < full.ms, `capped ${Math.round(capped.ms)} ms vs full ${Math.round(full.ms)} ms`);
});

test("a file with more text than the character cap is refused as too complex", async () => {
  const lines = Array.from({ length: 10 }, (_, i) => [[50, `Line ${i}: text that adds up to more characters than the cap`] as [number, string]]);
  const pdf = buildPdf([linesToPlacements(lines)]);
  await assert.rejects(() => readPdfText(pdf, { maxTextCharacters: 100 }), rejectsWith("pdf_too_complex"));
  // The same file is fine under a roomier cap, so the refusal is the cap and not the file.
  const { pages } = await readPdfText(pdf, { maxTextCharacters: 10_000 });
  assert.equal(pages[0].items.length, 10);
});

test("the time budget is checked while reading, and a file that outruns it is refused", async () => {
  const bomb = buildCompressedPdf(300_000);
  await assert.rejects(
    () => readPdfText(bomb, { ...NO_LIMITS, timeoutMs: 1 }),
    (e: unknown) => rejectsWith("pdf_too_complex")(e) && /too long/.test((e as Error).message),
  );
});

test("stopping at a limit leaves no stray errors behind and the process stays usable", async () => {
  const stray: unknown[] = [];
  const onError = (e: unknown) => stray.push(e);
  process.on("uncaughtException", onError);
  process.on("unhandledRejection", onError);
  try {
    for (const limit of [{ maxTextItems: 200 }, { maxTextCharacters: 300 }, { timeoutMs: 1, maxTextItems: Infinity, maxTextCharacters: Infinity }]) {
      await assert.rejects(() => readPdfText(buildCompressedPdf(200_000), limit), rejectsWith("pdf_too_complex"));
    }
    // Give any in-flight pdf.js work time to misbehave after we stopped reading.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(stray, []);

    // And a normal file still reads afterwards.
    const normal = buildPdf([linesToPlacements([[[50, "Gross Salary"], [400, "12,00,000.00"]], [[50, "Standard deduction"], [400, "75,000.00"]]])]);
    const { pages } = await readPdfText(normal);
    assert.ok(pages[0].items.some((i) => i.text.includes("12,00,000.00")));
  } finally {
    process.off("uncaughtException", onError);
    process.off("unhandledRejection", onError);
  }
});

test("a file inside every limit is read completely and unchanged by the limits", async () => {
  const lines = Array.from({ length: 40 }, (_, i) => [[50, `Row ${i}`] as [number, string], [400, `${i},000.00`] as [number, string]]);
  const pdf = buildPdf([linesToPlacements(lines, 780), linesToPlacements(lines.slice(0, 5))]);
  const limited = await readPdfText(pdf);
  const unlimited = await readPdfText(pdf, NO_LIMITS);
  assert.deepEqual(limited, unlimited);
  // 40 rows of two cells (pdf.js adds whitespace items between cells, so there are more than 80 items).
  assert.ok(limited.pages[0].items.length >= 80);
});
