import { NextResponse } from "next/server";
import { requireSessionUserId } from "@/services/session";
import { listDocumentSummaries } from "@/services/documents";
import { uploadForm16 } from "@/services/form16";
import { ValidationError } from "@/services/errors";
import { MAX_PDF_BYTES, readMultipartUpload } from "@/lib/file-validation";
import { respondToError } from "../_lib/respond-error";

// The signed-in user's documents. Summaries only: no storage reference and
// no file content.
export async function GET() {
  try {
    const userId = await requireSessionUserId();
    return NextResponse.json({ documents: await listDocumentSummaries(userId) });
  } catch (err) {
    return respondToError(err);
  }
}

// Upload a Form 16 PDF (multipart/form-data, field "file"). The body is
// size-capped before it is parsed, and everything about the file is decided
// from its bytes by the service. The client supplies nothing but the file.
export async function POST(req: Request) {
  try {
    const userId = await requireSessionUserId();
    const { file, form } = await readMultipartUpload(req, MAX_PDF_BYTES);

    const documentType = form.get("documentType");
    if (documentType !== null && documentType !== "form16") {
      throw new ValidationError('Only "form16" documents can be uploaded.');
    }

    return NextResponse.json(await uploadForm16(userId, file), { status: 201 });
  } catch (err) {
    return respondToError(err);
  }
}
