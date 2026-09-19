import { NextResponse } from "next/server";
import { requireSessionUserId } from "@/services/session";
import { getDocumentFile } from "@/services/documents";
import { contentDispositionAttachment } from "@/lib/file-validation";
import { respondToError } from "../../../_lib/respond-error";

type RouteContext = { params: Promise<{ id: string }> };

// Download the original file, only for its owner. Always an attachment (never
// rendered in the browser), never sniffed, never cached. The type served is
// the one the server determined from the file's bytes at upload.
export async function GET(_req: Request, { params }: RouteContext) {
  try {
    const userId = await requireSessionUserId();
    const { id } = await params;
    const file = await getDocumentFile(userId, id);
    if (!file) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = new Uint8Array(file.bytes);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": file.contentType,
        "Content-Length": String(body.length),
        "Content-Disposition": contentDispositionAttachment(file.filename),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    return respondToError(err);
  }
}
