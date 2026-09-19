// Form-validation tests. Pure — no database, session, or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
  validateCurrentPassword,
  validateEmail,
  validateName,
  validateNewPassword,
} from "../lib/auth-validation";

test("validateEmail requires a value, then a plausible shape", () => {
  assert.equal(validateEmail(""), "Enter your email address.");
  assert.equal(validateEmail("   "), "Enter your email address.");
  assert.match(validateEmail("jane")!, /valid email/);
  assert.match(validateEmail("jane@example")!, /valid email/);
  assert.match(validateEmail("jane @example.com")!, /valid email/);
  assert.equal(validateEmail("jane@example.com"), null);
  assert.equal(validateEmail("  jane.doe+tax@mail.example.co.in  "), null);
});

test("validateName only requires something non-blank", () => {
  assert.equal(validateName(""), "Enter your name.");
  assert.equal(validateName("  "), "Enter your name.");
  assert.equal(validateName("Jane"), null);
});

test("validateCurrentPassword never judges the password's strength", () => {
  assert.equal(validateCurrentPassword(""), "Enter your password.");
  assert.equal(validateCurrentPassword("a"), null);
});

test("validateNewPassword enforces the server's length bounds", () => {
  assert.equal(validateNewPassword(""), "Choose a password.");
  assert.match(validateNewPassword("short")!, /at least 8 characters/);
  assert.equal(validateNewPassword("x".repeat(MIN_PASSWORD_LENGTH - 1))!.includes("You have 7"), true);
  assert.equal(validateNewPassword("x".repeat(MIN_PASSWORD_LENGTH)), null);
  assert.equal(validateNewPassword("x".repeat(MAX_PASSWORD_BYTES)), null);
  assert.match(validateNewPassword("x".repeat(MAX_PASSWORD_BYTES + 1))!, /too long/);
});

test("validateNewPassword measures the 72-byte limit in bytes, not characters", () => {
  // "é" is 2 bytes in UTF-8: 37 of them = 74 bytes but only 37 characters.
  assert.match(validateNewPassword("é".repeat(37))!, /too long/);
  assert.equal(validateNewPassword("é".repeat(36)), null); // exactly 72 bytes
});
