import { NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import Transaction from "@/models/Transaction";

export async function GET() {
  await connectDB();
  const data = await Transaction.find().sort({ date: -1 });
  return NextResponse.json(data);
}

export async function POST(req: Request) {
  await connectDB();
  const body = await req.json();

  const transaction = await Transaction.create(body);

  return NextResponse.json(transaction);
}