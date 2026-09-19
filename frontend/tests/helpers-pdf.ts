// Test helper: builds tiny, valid PDFs byte by byte so the PDF path can be
// exercised end to end without a PDF-writing dependency or binary fixtures.
// ASCII only (byte offsets in the xref table are computed from string length).
// This is a helper, not a test file: the test glob only runs *.test.ts.
import { deflateSync } from "node:zlib";

export type Placement = { x: number; y: number; text: string; size?: number };

const escapePdfText = (text: string) => text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/**
 * One page per entry. A page with no placements draws only a rectangle: a
 * page with no text layer, which is what a scanned document looks like to a
 * text extractor. With `encrypted`, the file carries a standard-security
 * /Encrypt dictionary whose keys do not match an empty password, so a reader
 * must ask for one, exactly like a password-protected Form 16.
 */
export function buildPdf(pages: Placement[][], options: { encrypted?: boolean } = {}): Uint8Array {
  const objects: string[] = [];
  const pageNumbers = pages.map((_, i) => 4 + i * 2);

  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${pageNumbers.map((n) => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  pages.forEach((placements, i) => {
    const stream =
      placements.length > 0
        ? placements.map((p) => `BT /F1 ${p.size ?? 10} Tf ${p.x} ${p.y} Td (${escapePdfText(p.text)}) Tj ET`).join("\n")
        : "0.5 g 50 50 400 300 re f";
    objects[3 + i * 2] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R ` +
      "/Resources << /Font << /F1 3 0 R >> >> >>";
    objects[4 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  let trailerExtras = "";
  if (options.encrypted) {
    objects.push(
      `<< /Filter /Standard /V 1 /R 2 /O <${"00".repeat(32)}> /U <${"11".repeat(32)}> /P -4 >>`,
    );
    trailerExtras = ` /Encrypt ${objects.length} 0 R /ID [<${"ab".repeat(16)}> <${"ab".repeat(16)}>]`;
  }

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerExtras} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return new TextEncoder().encode(out);
}

/** Lay lines of `[x, text]` cells down a page from the top, 14 points apart. */
export function linesToPlacements(lines: Array<Array<[number, string]>>, startY = 760): Placement[] {
  const placements: Placement[] = [];
  lines.forEach((cells, row) => {
    for (const [x, text] of cells) placements.push({ x, y: startY - row * 14, text });
  });
  return placements;
}

/** One `Tj` text operator: each one becomes a text item when the page is read. */
const ONE_TEXT_ITEM = "BT /F1 10 Tf 40 700 Td (x) Tj ET\n";

/**
 * A one-page PDF whose content stream is `operator` repeated `repeats` times
 * and DEFLATE-compressed. Repetition compresses about a thousand to one, so a
 * file of a few hundred KB stands for millions of operators: the shape of a
 * decompression bomb. With the default operator every repeat is one text item.
 */
export function buildCompressedPdf(repeats: number, operator = ONE_TEXT_ITEM): Uint8Array {
  const stream = deflateSync(Buffer.from(operator.repeat(repeats)), { level: 9 });
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const add = (piece: Buffer | string) => {
    const buffer = Buffer.isBuffer(piece) ? piece : Buffer.from(piece, "latin1");
    parts.push(buffer);
    length += buffer.length;
  };
  const object = (n: number, body: Buffer | string) => {
    offsets[n] = length;
    add(`${n} 0 obj\n`);
    add(body);
    add("\nendobj\n");
  };

  add("%PDF-1.4\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, "<< /Type /Pages /Kids [4 0 R] /Count 1 >>");
  object(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  object(4, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 3 0 R >> >> >>");
  object(5, Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), stream, Buffer.from("\nendstream", "latin1")]));
  const xref = length;
  add(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => `${String(offsets[n]).padStart(10, "0")} 00000 n \n`).join("")}`);
  add(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(parts));
}
