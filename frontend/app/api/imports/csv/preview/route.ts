import { NextResponse } from "next/server";
import { requireSessionUserId } from "@/services/session";
import { previewCsv } from "@/services/imports";
import { MAX_CSV_BYTES, readJsonField, readMultipartUpload } from "@/lib/file-validation";
import { respondToError } from "../../../_lib/respond-error";

// Read and validate a CSV and describe what an import would do. WRITES
// NOTHING. Fields: "file" (required) and "mapping" (optional JSON).
export async function POST(req: Request) {
  try {
    const userId = await requireSessionUserId();
    const { file, form } = await readMultipartUpload(req, MAX_CSV_BYTES);
    return NextResponse.json(await previewCsv(userId, file, readJsonField(form, "mapping")));
  } catch (err) {
    return respondToError(err);
  }
}
