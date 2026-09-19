import { NextResponse } from "next/server";
import { requireSessionUserId } from "@/services/session";
import { getTaxWorkspace } from "@/services/tax";
import { respondToError } from "../../_lib/respond-error";

// Everything the Tax page needs to render for the signed-in user: the
// supported assessment year, a ledger income suggestion for that financial
// year, and the user's own saved computations. Read-only.
export async function GET(req: Request) {
  try {
    const userId = await requireSessionUserId();
    // The only thing the client may choose here is which supported year to
    // view; the service rejects any year the engine has no rules for.
    const assessmentYear = new URL(req.url).searchParams.get("ay") ?? undefined;
    return NextResponse.json(await getTaxWorkspace(userId, assessmentYear));
  } catch (err) {
    return respondToError(err);
  }
}
