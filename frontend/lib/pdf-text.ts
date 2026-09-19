// Reads the TEXT LAYER of a PDF as positioned items, using unpdf (a
// serverless build of Mozilla's pdf.js). It reads text and nothing else:
// no rendering, no images, no OCR, no PDF scripts, no password handling.
//
// Anything it cannot or should not read becomes a specific, content-free
// error. Raw parser messages are never passed on: they can mention document
// structure and are not useful to the person uploading.
//
// RESOURCE LIMITS. A small compressed PDF can expand into millions of text
// items, so pages are read as a STREAM, one chunk of items at a time, and the
// item, character and time limits are enforced as each chunk arrives. Once a
// limit is hit we stop reading: pdf.js pauses on backpressure and the loading
// task is destroyed, so the rest of the document is never expanded.
//
// Two things here are deliberate and easy to break:
//   - Never `reader.cancel()` the text stream. pdf.js still has a chunk in
//     flight and enqueues it into the closed controller, which throws an
//     UNCAUGHT `ERR_INVALID_STATE` and would take the server process down.
//     Stopping reads plus `loadingTask.destroy()` is clean.
//   - The time limit is a DEADLINE checked between chunks. A `setTimeout`
//     cannot interrupt pdf.js: it yields only through microtasks, so timers do
//     not run while it works.
//
// Known gap: work that produces no text (for example millions of operators
// that draw nothing) never yields a chunk, so no limit here can interrupt it.
// Bounding that needs the parse moved out of this process.
import { getDocumentProxy } from "unpdf";
import { UnprocessableContentError } from "../services/errors";
import { MAX_PDF_PAGES } from "./file-validation";

export type PositionedItem = {
  text: string;
  /** Left edge and baseline, in PDF points (origin bottom-left: larger y is higher on the page). */
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PdfPage = { page: number; items: PositionedItem[] };

export type PdfReadLimits = {
  /** Most text items across the whole file. A real Form 16 has a few hundred. */
  maxTextItems: number;
  /** Most characters of text across the whole file. */
  maxTextCharacters: number;
  /** Wall-clock budget for reading the file. */
  timeoutMs: number;
};

export const PDF_READ_LIMITS: PdfReadLimits = {
  maxTextItems: 100_000,
  maxTextCharacters: 1_000_000,
  timeoutMs: 20_000,
};

/** Fewer visible characters than this across the whole file means there is no usable text layer. */
const MIN_TEXT_CHARACTERS = 40;

const reject = (message: string, code: string) => new UnprocessableContentError(message, code);
const damaged = () => reject("This PDF couldn’t be read. It may be damaged. Download it again and retry.", "pdf_corrupt");
const tooSlow = () => reject("This PDF took too long to read. Try a simpler or smaller file.", "pdf_too_complex");

/**
 * Gives up on a load that STALLS (a promise that stops making progress). It
 * does not protect against CPU-bound parsing: a timer cannot fire while pdf.js
 * is working, and the losing load is not cancelled. The real limits are the
 * per-chunk checks in `readPdfText`.
 */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(tooSlow()), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The parts of a pdf.js text item that are read. Marked-content entries have no `str`. */
type RawTextItem = { str?: unknown; transform?: unknown; width?: unknown; height?: unknown };

export async function readPdfText(
  bytes: Uint8Array,
  overrides: Partial<PdfReadLimits> = {},
): Promise<{ pages: PdfPage[]; pageCount: number }> {
  const limits = { ...PDF_READ_LIMITS, ...overrides };
  const deadline = Date.now() + limits.timeoutMs;

  // pdf.js may take ownership of the buffer it is given, so it gets a copy.
  const data = new Uint8Array(bytes);

  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await withTimeout(getDocumentProxy(data, { enableScripting: false, stopAtErrors: true } as never), limits.timeoutMs);
  } catch (error) {
    if (error instanceof UnprocessableContentError) throw error;
    if ((error as { name?: string } | null)?.name === "PasswordException") {
      throw reject(
        "This PDF is password-protected. SmartCA can’t open protected files. Save an unprotected copy and upload that.",
        "pdf_encrypted",
      );
    }
    throw damaged();
  }

  try {
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw reject(`This PDF has more than ${MAX_PDF_PAGES} pages, which is more than a Form 16 needs.`, "pdf_too_many_pages");
    }

    let itemCount = 0;
    let characterCount = 0;
    let visibleCharacters = 0;
    const pages: PdfPage[] = [];

    try {
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const reader = page.streamTextContent().getReader();
        const items: PositionedItem[] = [];

        for (;;) {
          const { done, value } = (await reader.read()) as { done: boolean; value?: { items: RawTextItem[] } };
          if (done) break;

          // Checked on every chunk, before its items are kept.
          if (Date.now() > deadline) throw tooSlow();
          for (const item of value?.items ?? []) {
            if (typeof item.str !== "string" || !Array.isArray(item.transform)) continue;
            itemCount++;
            characterCount += item.str.length;
            if (itemCount > limits.maxTextItems || characterCount > limits.maxTextCharacters) {
              throw reject("This PDF has more text than a Form 16 should. Upload the original file.", "pdf_too_complex");
            }
            if (item.str === "") continue;
            visibleCharacters += item.str.replace(/\s/g, "").length;
            items.push({
              text: item.str,
              x: Number(item.transform[4]),
              y: Number(item.transform[5]),
              width: Number(item.width),
              height: Number(item.height),
            });
          }
        }
        pages.push({ page: pageNumber, items });
      }
    } catch (error) {
      if (error instanceof UnprocessableContentError) throw error;
      throw damaged();
    }

    if (visibleCharacters < MIN_TEXT_CHARACTERS) {
      throw reject(
        "This looks like a scanned document with no readable text. SmartCA can only read digital PDFs; use the original PDF from your employer or the TRACES portal.",
        "pdf_scanned",
      );
    }

    return { pages, pageCount: pdf.numPages };
  } finally {
    // Release the parser's resources (and stop any work still paused mid-file);
    // a failure to clean up must not mask the result.
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}
