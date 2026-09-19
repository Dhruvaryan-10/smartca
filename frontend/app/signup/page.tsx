"use client";

import { useRef, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { AuthLayout, AuthLink } from "../components/ui/AuthLayout";
import { Button } from "../components/ui/Button";
import { TextField } from "../components/ui/TextField";
import {
  MIN_PASSWORD_LENGTH,
  validateEmail,
  validateName,
  validateNewPassword,
} from "@/lib/auth-validation";

export default function Signup() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [touched, setTouched] = useState({ name: false, email: false, password: false });
  // Set when the server rejects the address (already registered); cleared
  // as soon as the address is edited, so it never lingers on a new value.
  const [serverEmailError, setServerEmailError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const nameError = validateName(name);
  const emailError = validateEmail(email);
  const passwordError = validateNewPassword(password);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;

    setTouched({ name: true, email: true, password: true });
    setFormError(null);

    if (nameError || emailError || passwordError) {
      (nameError ? nameRef : emailError ? emailRef : passwordRef).current?.focus();
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), password }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const message: string = data.error || "Sign-up didn’t go through. Please try again.";
        if (res.status === 409) {
          setServerEmailError(message);
          emailRef.current?.focus();
        } else {
          setFormError(message);
        }
        return;
      }

      // Signed up — now sign in with the same credentials.
      const result = await signIn("credentials", { email: email.trim(), password, redirect: false });

      if (!result || result.error) {
        // Account was created but sign-in somehow failed — send them to
        // login rather than leaving them stuck on this form.
        router.push("/login");
        return;
      }

      router.push("/dashboard");
    } catch {
      setFormError("Couldn’t reach SmartCA. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Keep your income, expenses and tax in one place."
      footer={
        <p>
          Already have an account? <AuthLink href="/login">Log in</AuthLink>
        </p>
      }
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        <TextField
          ref={nameRef}
          id="signup-name"
          label="Full name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, name: true }))}
          error={touched.name ? nameError : null}
          autoComplete="name"
          autoFocus
          required
        />

        <TextField
          ref={emailRef}
          id="signup-email"
          label="Email"
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setServerEmailError(null);
          }}
          onBlur={() => setTouched((t) => ({ ...t, email: true }))}
          error={serverEmailError ?? (touched.email ? emailError : null)}
          autoComplete="email"
          autoCapitalize="none"
          inputMode="email"
          spellCheck={false}
          required
        />

        <TextField
          ref={passwordRef}
          id="signup-password"
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, password: true }))}
          error={touched.password ? passwordError : null}
          hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          autoComplete="new-password"
          required
        />

        {formError && (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        )}

        <Button type="submit" size="lg" disabled={loading} className="w-full">
          {loading ? "Creating account…" : "Create account"}
        </Button>
      </form>
    </AuthLayout>
  );
}
