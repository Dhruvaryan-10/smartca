// User identity and password handling. This is the ONLY place
// passwords are hashed/verified — never stored or compared in
// plaintext anywhere else in the codebase.
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { isUniqueViolation } from "@/db/pg-errors";
import { EmailAlreadyRegisteredError, ValidationError } from "./errors";

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 8;
// bcrypt's underlying Blowfish key schedule has a hard 72-byte input
// limit — anything beyond that is silently truncated by the algorithm
// itself (not by us), which would make e.g. two passwords that only
// differ after byte 72 hash identically. Reject clearly instead of
// letting that happen silently. Checked in bytes, not characters, so
// multi-byte (non-ASCII) passwords are measured correctly.
const MAX_PASSWORD_BYTES = 72;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(email: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)));
  return user ?? null;
}

export async function getUserById(id: string) {
  const [user] = await db.select().from(users).where(eq(users.id, id));
  return user ?? null;
}

export type CreateUserInput = {
  email: string;
  password: string;
  name?: string;
};

export async function createUser(input: CreateUserInput) {
  const email = normalizeEmail(input.email);
  if (!email.includes("@")) {
    throw new ValidationError("A valid email is required.");
  }
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (Buffer.byteLength(input.password, "utf8") > MAX_PASSWORD_BYTES) {
    throw new ValidationError(`Password must be at most ${MAX_PASSWORD_BYTES} UTF-8 bytes.`);
  }

  const passwordHash = await hashPassword(input.password);

  try {
    const [user] = await db
      .insert(users)
      .values({ email, passwordHash, name: input.name?.trim() || undefined })
      .returning();
    return user;
  } catch (err) {
    // The unique index on email is the actual source of truth (closes
    // the race between two concurrent signups for the same address);
    // this just turns it into a friendly, typed error.
    if (isUniqueViolation(err)) {
      throw new EmailAlreadyRegisteredError();
    }
    throw err;
  }
}
