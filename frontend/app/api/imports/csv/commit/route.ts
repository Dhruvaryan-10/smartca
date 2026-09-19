import { NextResponse } from "next/server";
import { requireSessionUserId } from "@/services/session";
import { commitCsv } from "@/services/imports";
import { MAX_CSV_BYTES, readJsonField, readMultipartUpload } from "@/lib/file-validation";
import { ValidationError } from "@/services/errors";
import { respondToError } from "../../../_lib/respond-error";

// Import a CSV. The client sends the file and the mapping AGAIN; the service
// re-parses and re-validates everything and imports all-or-nothing. Nothing
// from the preview is trusted. Optional "includeLines" (JSON array of file
// line numbers) names matched rows to import anyway; the rest are skipped.
const MAX_INCLUDE_LINES_LENGTH = 60_000;

export async function POST(req: Request) {
  try {
    const userId = await requireSessionUserId();
    const { file, form } = await readMultipartUpload(req, MAX_CSV_BYTES);
    const mapping = readJsonField(form, "mapping");
    if (mapping === undefined) throw new ValidationError("mapping is required.");
    const includeLines = readJsonField(form, "includeLines", MAX_INCLUDE_LINES_LENGTH);
    return NextResponse.json(await commitCsv(userId, file, mapping, { includeLines }), { status: 201 });
  } catch (err) {
    return respondToError(err);
  }
}
