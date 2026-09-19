import { NextResponse } from "next/server";
import { requireSessionUserId } from "@/services/session";
import { deleteDocument } from "@/services/documents";
import { getForm16Detail } from "@/services/form16";
import { respondToError } from "../../_lib/respond-error";

type RouteContext = { params: Promise<{ id: string }> };

// A document with its extraction: what the parser read (untrusted) beside
// what the user confirmed. Not found for a missing document and for someone
// else's, identically.
export async function GET(_req: Request, { params }: RouteContext) {
  try {
    const userId = await requireSessionUserId();
    const { id } = await params;
    return NextResponse.json(await getForm16Detail(userId, id));
  } catch (err) {
    return respondToError(err);
  }
}

// Deletes the document; the database cascade removes its file bytes and extraction.
export async function DELETE(_req: Request, { params }: RouteContext) {
  try {
    const userId = await requireSessionUserId();
    const { id } = await params;
    await deleteDocument(userId, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return respondToError(err);
  }
}
