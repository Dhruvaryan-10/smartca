import { NextResponse } from "next/server";
import { requireSessionUserId } from "@/services/session";
import { computeTax, saveTaxComputation } from "@/services/tax";
import { respondToError } from "../../_lib/respond-error";

// Runs the deterministic tax engine on the posted INPUT and returns the
// result. The client never sends, and this route never reads, a result, a
// version, a user id or an assessment-year row id: the service parses a
// fixed allow-list of input fields, computes on the server, and (only when
// the client explicitly asks with `save: true`) stores the engine's own
// output for the signed-in user.
export async function POST(req: Request) {
  try {
    const userId = await requireSessionUserId();
    const body: unknown = await req.json().catch(() => null);

    const wantsSave = typeof body === "object" && body !== null && (body as { save?: unknown }).save === true;
    if (wantsSave) {
      return NextResponse.json(await saveTaxComputation(userId, body), { status: 201 });
    }
    return NextResponse.json(await computeTax(userId, body));
  } catch (err) {
    return respondToError(err);
  }
}
