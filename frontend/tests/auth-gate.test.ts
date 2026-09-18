// Test A (unauthenticated access is rejected) and test J (passwords are
// hashed, never stored in plaintext).
import "../db/load-env";

import { test } from "node:test";
import assert from "node:assert/strict";
import { requireUserId } from "../services/session";
import { NotAuthenticatedError, NotFoundError, ValidationError } from "../services/errors";
import { respondToError } from "../app/api/_lib/respond-error";
import { hashPassword, verifyPassword, createUser, findUserByEmail } from "../services/users";
import { EmailAlreadyRegisteredError } from "../services/errors";
import { deleteTestUser, makeTestUser } from "./helpers";

// --- A. Unauthenticated access -------------------------------------------

test("A. requireUserId rejects a missing session (no user id)", () => {
  assert.throws(() => requireUserId(null), NotAuthenticatedError);
});

test("A. requireUserId accepts a real session user id", () => {
  assert.equal(requireUserId("some-user-id"), "some-user-id");
});

test("A. an unauthenticated request is mapped to HTTP 401, not data", async () => {
  const res = respondToError(new NotAuthenticatedError());
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, "Unauthorized");
});

test("A. ownership violations and missing records both map to 404 (no existence leak)", async () => {
  const res = respondToError(new NotFoundError());
  assert.equal(res.status, 404);
});

test("A. validation errors map to 400 with the specific message (not leaking internals)", async () => {
  const res = respondToError(new ValidationError("category is required."));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "category is required.");
});

test("A. unexpected errors map to a generic 500, never the raw error", async () => {
  const res = respondToError(new Error("some internal database detail that must not leak"));
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, "Internal server error");
});

// --- J. Password security -------------------------------------------------

test("J. hashing a password never returns the plaintext", async () => {
  const plaintext = "correct horse battery staple";
  const hash = await hashPassword(plaintext);
  assert.notEqual(hash, plaintext);
  assert.ok(hash.startsWith("$2"), "expected a bcrypt hash (starts with $2)");
});

test("J. verifyPassword accepts the correct password and rejects the wrong one", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("correct horse battery staple", hash), true);
  assert.equal(await verifyPassword("wrong password", hash), false);
});

test("J. createUser never stores the plaintext password in the database", async () => {
  const email = `phase1b-hash-${Date.now()}@test.smartca.invalid`;
  const password = "SuperSecretPassword1!";
  const user = await createUser({ email, password, name: "Hash Check" });
  try {
    const stored = await findUserByEmail(email);
    assert.ok(stored);
    assert.notEqual(stored!.passwordHash, password);
    assert.ok(!stored!.passwordHash.includes(password));
    assert.ok(await verifyPassword(password, stored!.passwordHash));
  } finally {
    await deleteTestUser(user.id);
  }
});

test("J. signing up twice with the same email is rejected", async () => {
  const user = await makeTestUser("dup-email");
  try {
    await assert.rejects(
      () => createUser({ email: user.email, password: "AnotherPassword1!", name: "Dup" }),
      EmailAlreadyRegisteredError,
    );
  } finally {
    await deleteTestUser(user.id);
  }
});

// --- Password policy -------------------------------------------------------

test("password policy: a too-short password is rejected", async () => {
  const email = `phase1b-pw-short-${Date.now()}@test.smartca.invalid`;
  await assert.rejects(
    () => createUser({ email, password: "short1", name: "Too Short" }), // 6 chars, min is 8
    ValidationError,
  );
});

test("password policy: an acceptable password is accepted", async () => {
  const email = `phase1b-pw-ok-${Date.now()}@test.smartca.invalid`;
  const user = await createUser({ email, password: "ReasonableLength1!", name: "OK" });
  try {
    assert.ok(user.id);
  } finally {
    await deleteTestUser(user.id);
  }
});

test("password policy: an excessively long password is rejected safely, not silently truncated", async () => {
  const email = `phase1b-pw-long-${Date.now()}@test.smartca.invalid`;
  // Well past bcrypt's 72-byte input limit — must be rejected with a
  // clear error before ever reaching bcrypt.hash, not hashed-and-truncated.
  const tooLong = "a".repeat(1000);
  const start = Date.now();
  await assert.rejects(
    () => createUser({ email, password: tooLong, name: "Too Long" }),
    ValidationError,
  );
  // "Handled safely" includes "handled fast": rejection must happen
  // before any bcrypt hashing is attempted, not after paying its cost.
  assert.ok(Date.now() - start < 200, "an over-long password must be rejected before hashing, not after");
});

// --- Email normalization ----------------------------------------------------

test("email normalization: signup lowercases and trims the stored email", async () => {
  const raw = `  Phase1B-Norm-${Date.now()}@Test.SmartCA.Invalid  `;
  const user = await createUser({ email: raw, password: "NormalizeMe1!", name: "Norm" });
  try {
    assert.equal(user.email, raw.trim().toLowerCase());
  } finally {
    await deleteTestUser(user.id);
  }
});

test("email normalization: differently-cased/whitespace variants of the same email cannot both register", async () => {
  const base = `phase1b-case-${Date.now()}@test.smartca.invalid`;
  const user = await createUser({ email: base, password: "FirstAccount1!", name: "First" });
  try {
    // USER@EXAMPLE.COM-style casing and stray whitespace must collide
    // with the already-registered address, not create a second account.
    const variants = [base.toUpperCase(), ` ${base} `, base.charAt(0).toUpperCase() + base.slice(1)];
    for (const variant of variants) {
      await assert.rejects(
        () => createUser({ email: variant, password: "SecondAttempt1!", name: "Duplicate" }),
        EmailAlreadyRegisteredError,
        `expected "${variant}" to collide with the existing account`,
      );
    }
  } finally {
    await deleteTestUser(user.id);
  }
});

test("email normalization: login lookup is case-insensitive", async () => {
  const base = `phase1b-login-case-${Date.now()}@test.smartca.invalid`;
  const user = await createUser({ email: base, password: "LoginCase1!", name: "Login Case" });
  try {
    const found = await findUserByEmail(base.toUpperCase());
    assert.ok(found, "expected findUserByEmail to find the account regardless of input casing");
    assert.equal(found!.id, user.id);
  } finally {
    await deleteTestUser(user.id);
  }
});
