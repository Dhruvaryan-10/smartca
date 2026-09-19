// Client-side form validation for the sign-in and sign-up screens. These
// checks exist to give immediate, specific feedback — they are NOT the
// security boundary. The server (services/users.ts, the Auth.js
// Credentials provider) re-validates everything and remains the only
// authority on what is accepted.
//
// Each validator returns a message for the person filling the form, or
// null when the value is fine. Messages say what to do, not what went
// wrong in the abstract.

// Deliberately permissive: enough to catch typos, not to police what a
// valid address is (the server does the real check).
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Mirrors services/users.ts. Kept in sync by hand; the server rejects
// anything outside these bounds regardless.
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_BYTES = 72;

export function validateEmail(value: string): string | null {
  const email = value.trim();
  if (!email) return "Enter your email address.";
  if (!EMAIL_SHAPE.test(email)) return "Enter a valid email address, like name@example.com.";
  return null;
}

export function validateName(value: string): string | null {
  return value.trim() ? null : "Enter your name.";
}

/** Sign-in: any non-empty password is submitted; the server decides. */
export function validateCurrentPassword(value: string): string | null {
  return value ? null : "Enter your password.";
}

/** Sign-up: enforce the same bounds the server will. */
export function validateNewPassword(value: string): string | null {
  if (!value) return "Choose a password.";
  if (value.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters. You have ${value.length}.`;
  }
  if (new TextEncoder().encode(value).length > MAX_PASSWORD_BYTES) {
    return `That password is too long. Use ${MAX_PASSWORD_BYTES} characters or fewer.`;
  }
  return null;
}
