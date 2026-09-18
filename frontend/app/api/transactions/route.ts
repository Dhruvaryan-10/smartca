import { NextResponse } from "next/server";
import { requireSessionUserId } from "@/services/session";
import { createTransaction, listTransactions } from "@/services/transactions";
import { respondToError } from "../_lib/respond-error";

export async function GET() {
  try {
    const userId = await requireSessionUserId();
    const data = await listTransactions(userId);
    return NextResponse.json(data);
  } catch (err) {
    return respondToError(err);
  }
}

export async function POST(req: Request) {
  try {
    const userId = await requireSessionUserId();
    const body = await req.json().catch(() => ({}));

    // Explicitly whitelist fields from the request body. This is the
    // enforcement point for "never trust a client-supplied user id":
    // even if a caller includes userId/user_id in the JSON body, it is
    // never read — ownership comes only from requireSessionUserId()
    // above, which is derived from the verified server-side session.
    const row = await createTransaction(userId, {
      type: body.type,
      amountPaise: body.amountPaise,
      category: body.category,
      description: body.description ?? null,
      source: body.source ?? null,
      occurredOn: body.occurredOn,
    });

    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    return respondToError(err);
  }
}
