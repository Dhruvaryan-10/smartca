import { NextResponse } from "next/server";
import { createUser } from "@/services/users";
import { EmailAlreadyRegisteredError, ValidationError } from "@/services/errors";
import { loggableError } from "../../_lib/respond-error";

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
    // Log what failed server-side only, never the error itself: the driver's message carries the insert's parameters (email,
    // name, password hash). Never leak internals to the client.
    console.error("Signup failed:", loggableError(err));
    return NextResponse.json({ error: "Signup failed. Please try again." }, { status: 500 });
  }
}
