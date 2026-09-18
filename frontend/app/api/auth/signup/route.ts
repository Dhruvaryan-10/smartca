import { NextResponse } from "next/server";
import { createUser } from "@/services/users";
import { EmailAlreadyRegisteredError, ValidationError } from "@/services/errors";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);

  const email = typeof body?.email === "string" ? body.email : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const name = typeof body?.name === "string" ? body.name : undefined;

  try {
    const user = await createUser({ email, password, name });
    // Never echo back anything beyond id/email — never the password or
    // its hash.
    return NextResponse.json({ id: user.id, email: user.email }, { status: 201 });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof EmailAlreadyRegisteredError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    // Log the real cause server-side only; never leak internals to the client.
    console.error("Signup failed:", err);
    return NextResponse.json({ error: "Signup failed. Please try again." }, { status: 500 });
  }
}
