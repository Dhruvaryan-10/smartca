import { NextResponse } from "next/server";
import { requireSessionUserId } from "@/services/session";
import { deleteTransaction, getTransaction, updateTransaction } from "@/services/transactions";
import { respondToError } from "../../_lib/respond-error";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: RouteContext) {
  try {
    const userId = await requireSessionUserId();
    const { id } = await params;
    const row = await getTransaction(userId, id);
    // getTransaction returns null for "doesn't exist" and for "exists
    // but belongs to someone else" — identically, by design.
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(row);
  } catch (err) {
    return respondToError(err);
  }
}

export async function PATCH(req: Request, { params }: RouteContext) {
  try {
    const userId = await requireSessionUserId();
    const { id } = await params;
    const body = await req.json().catch(() => ({}));

    const row = await updateTransaction(userId, id, {
      ...(body.type !== undefined ? { type: body.type } : {}),
      ...(body.amountPaise !== undefined ? { amountPaise: body.amountPaise } : {}),
      ...(body.category !== undefined ? { category: body.category } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.source !== undefined ? { source: body.source } : {}),
      ...(body.occurredOn !== undefined ? { occurredOn: body.occurredOn } : {}),
    });

    return NextResponse.json(row);
  } catch (err) {
    return respondToError(err);
  }
}

export async function DELETE(_req: Request, { params }: RouteContext) {
  try {
    const userId = await requireSessionUserId();
    const { id } = await params;
    await deleteTransaction(userId, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return respondToError(err);
  }
}
