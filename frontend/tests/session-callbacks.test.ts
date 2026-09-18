// Test I: an authenticated session resolves to the correct user id.
//
// Exercises the actual jwt/session callbacks shipped in auth.config.ts
// (not a reimplementation) — the ones Auth.js calls on every request to
// shape the JWT and the session object services/session.ts reads from.
import "../db/load-env";

import { test } from "node:test";
import assert from "node:assert/strict";
import { authConfig } from "../auth.config";

test("I. the jwt callback attaches the signed-in user's id onto the token", async () => {
  const jwtCallback = authConfig.callbacks!.jwt!;
  // Minimal fixtures — only the fields these callbacks actually read.
  const token = await jwtCallback({ token: {}, user: { id: "user-123" } } as unknown as Parameters<typeof jwtCallback>[0]);
  assert.equal((token as { id?: string }).id, "user-123");
});

test("I. the jwt callback leaves an existing token untouched on subsequent requests (no user re-supplied)", async () => {
  const jwtCallback = authConfig.callbacks!.jwt!;
  const token = await jwtCallback({ token: { id: "user-123" } } as unknown as Parameters<typeof jwtCallback>[0]);
  assert.equal((token as { id?: string }).id, "user-123");
});

test("I. the session callback copies the token's user id onto session.user.id", async () => {
  const sessionCallback = authConfig.callbacks!.session!;
  const session = await sessionCallback({
    session: { user: {}, expires: new Date(Date.now() + 1000).toISOString() },
    token: { id: "user-456" },
  } as unknown as Parameters<typeof sessionCallback>[0]);
  assert.equal((session as { user: { id?: string } }).user.id, "user-456");
});

test("I. two different users' tokens never cross-resolve to each other's session", async () => {
  const jwtCallback = authConfig.callbacks!.jwt!;
  const sessionCallback = authConfig.callbacks!.session!;

  const tokenA = await jwtCallback({ token: {}, user: { id: "user-A" } } as unknown as Parameters<typeof jwtCallback>[0]);
  const tokenB = await jwtCallback({ token: {}, user: { id: "user-B" } } as unknown as Parameters<typeof jwtCallback>[0]);

  const sessionA = await sessionCallback({
    session: { user: {}, expires: new Date(Date.now() + 1000).toISOString() },
    token: tokenA,
  } as unknown as Parameters<typeof sessionCallback>[0]);
  const sessionB = await sessionCallback({
    session: { user: {}, expires: new Date(Date.now() + 1000).toISOString() },
    token: tokenB,
  } as unknown as Parameters<typeof sessionCallback>[0]);

  assert.equal((sessionA as { user: { id?: string } }).user.id, "user-A");
  assert.equal((sessionB as { user: { id?: string } }).user.id, "user-B");
  assert.notEqual(
    (sessionA as { user: { id?: string } }).user.id,
    (sessionB as { user: { id?: string } }).user.id,
  );
});
