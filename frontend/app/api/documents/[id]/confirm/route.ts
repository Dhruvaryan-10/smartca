import { NextResponse } from "next/server";
import { requireSessionUserId } from "@/services/session";
import { confirmForm16 } from "@/services/form16";
import { respondToError } from "../../../_lib/respond-error";

type RouteContext = { params: Promise<{ id: string }> };

// Record the values the user reviewed and confirmed. The service reads a
// fixed allow-list of fields and derives the salary income itself; nothing
// derived, and no version, is accepted from the client.
export async function POST(req: Request, { params }: RouteContext) {
  try {
    const userId = await requireSessionUserId();
    const { id } = await params;
    const body: unknown = await req.json().catch(() => null);
    return NextResponse.json(await confirmForm16(userId, id, body));
  } catch (err) {
    return respondToError(err);
  }
}
