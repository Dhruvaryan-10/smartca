"use client";

import { useRef, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { AuthLayout, AuthLink } from "../components/ui/AuthLayout";
import { Button } from "../components/ui/Button";
import { TextField } from "../components/ui/TextField";
import { validateCurrentPassword, validateEmail } from "@/lib/auth-validation";

export default function Login() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // A field's message appears once it has been left (or the form was
  // submitted) — never while someone is still typing their first attempt —
  // and then updates live as they correct it.
  const [touched, setTouched] = useState({ email: false, password: false });
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const emailError = validateEmail(email);
  const passwordError = validateCurrentPassword(password);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;

    setTouched({ email: true, password: true });
    setFormError(null);

    if (emailError || passwordError) {
      (emailError ? emailRef : passwordRef).current?.focus();
      return;
    }

    setLoading(true);
    try {
      // redirect: false — we handle the redirect ourselves so we can show
      // a real error message instead of a lossy query-string redirect.
      const result = await signIn("credentials", {
        email: email.trim(),
        password,
        redirect: false,
      });

      if (!result || result.error) {
        // Deliberately generic: never reveal whether the email exists.
        setFormError("That email and password don’t match. Check them and try again.");
        passwordRef.current?.focus();
        passwordRef.current?.select();
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
      title="Log in"
      subtitle="Pick up where you left off."
      footer={
        <p>
          New to SmartCA? <AuthLink href="/signup">Create an account</AuthLink>
        </p>
      }
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        <TextField
          ref={emailRef}
          id="login-email"
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, email: true }))}
          error={touched.email ? emailError : null}
          autoComplete="email"
          autoCapitalize="none"
          autoFocus
          inputMode="email"
          spellCheck={false}
          required
        />

        <TextField
          ref={passwordRef}
          id="login-password"
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, password: true }))}
          error={touched.password ? passwordError : null}
          autoComplete="current-password"
          required
        />

        {formError && (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        )}

        <Button type="submit" size="lg" disabled={loading} className="w-full">
          {loading ? "Logging in…" : "Log in"}
        </Button>
      </form>
    </AuthLayout>
  );
}
