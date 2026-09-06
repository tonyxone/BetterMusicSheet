"use client";

import { useEffect, useRef, useState } from "react";
import { signIn } from "@/lib/auth";
import {
  CognitoError,
  confirmForgotPassword,
  confirmSignUp,
  forgotPassword,
  resendConfirmationCode,
  signUp,
} from "@/lib/cognito";

/** Which step of the flow the modal is showing. Sign-up and password reset
 * both end at a code-entry step, so they're separate views rather than one
 * generic one - the copy and the next action differ. */
type View = "signin" | "signup" | "confirm" | "forgot" | "reset";

const TITLES: Record<View, string> = {
  signin: "Sign in",
  signup: "Create an account",
  confirm: "Check your email",
  forgot: "Reset your password",
  reset: "Choose a new password",
};

export function SignInModal({ onClose, onSignedIn }: { onClose: () => void; onSignedIn: () => void }) {
  const [view, setView] = useState<View>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  // Escape closes, matching the backdrop click. Bound to the document so it
  // works no matter what inside the dialog has focus.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // The page behind a modal shouldn't scroll with it.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, [view]);

  function go(next: View, message?: string) {
    setView(next);
    setError(null);
    setNotice(message ?? null);
  }

  function describe(err: unknown) {
    if (err instanceof CognitoError) {
      // Cognito's raw messages are mostly fine, but a few are cryptic or
      // leak more than they should.
      switch (err.code) {
        case "NotAuthorizedException":
          return "Incorrect email or password.";
        case "UserNotFoundException":
          return "Incorrect email or password.";
        case "UsernameExistsException":
          return "An account with that email already exists.";
        case "CodeMismatchException":
          return "That code doesn't match. Check it and try again.";
        case "ExpiredCodeException":
          return "That code has expired - request a new one.";
        case "LimitExceededException":
          return "Too many attempts. Wait a few minutes and try again.";
        case "InvalidPasswordException":
          return "That password doesn't meet the requirements below.";
        case "UserNotConfirmedException":
          return "This account still needs the emailed confirmation code.";
        case "NetworkError":
        case "NotConfigured":
          // Already written for a human by cognito.ts.
          return err.message;
        default:
          return err.message;
      }
    }
    return err instanceof Error ? err.message : String(err);
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;

    if (view === "signin") {
      return run(async () => {
        try {
          await signIn(email, password);
          onSignedIn();
        } catch (err) {
          // Signing in before confirming the emailed code is common enough
          // to route straight to the code step instead of a dead end.
          if (err instanceof CognitoError && err.code === "UserNotConfirmedException") {
            await resendConfirmationCode(email).catch(() => {});
            go("confirm", "Your account isn't confirmed yet - we've sent you a new code.");
            return;
          }
          throw err;
        }
      });
    }

    if (view === "signup") {
      return run(async () => {
        const needsCode = await signUp(email, password, name);
        if (needsCode) {
          go("confirm", "We've emailed you a confirmation code.");
        } else {
          await signIn(email, password);
          onSignedIn();
        }
      });
    }

    if (view === "confirm") {
      return run(async () => {
        await confirmSignUp(email, code);
        // The password is still in state from the previous step, so finish
        // the job rather than making them type it again.
        await signIn(email, password);
        onSignedIn();
      });
    }

    if (view === "forgot") {
      return run(async () => {
        await forgotPassword(email);
        go("reset", "We've emailed you a reset code.");
      });
    }

    // reset
    return run(async () => {
      await confirmForgotPassword(email, code, password);
      await signIn(email, password);
      onSignedIn();
    });
  }

  const submitLabel: Record<View, string> = {
    signin: busy ? "Signing in…" : "Sign in",
    signup: busy ? "Creating…" : "Create account",
    confirm: busy ? "Confirming…" : "Confirm",
    forgot: busy ? "Sending…" : "Send reset code",
    reset: busy ? "Saving…" : "Save and sign in",
  };

  return (
    <div
      className="modal-backdrop"
      // Only a click that both starts and ends on the backdrop dismisses -
      // otherwise dragging to select text inside the dialog and releasing
      // outside it would close the modal and lose what was typed.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-card" role="dialog" aria-modal="true" aria-label={TITLES[view]} ref={dialogRef}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>

        <h2 className="serif modal-title">{TITLES[view]}</h2>

        {view === "confirm" && (
          <p className="modal-sub">Enter the code we sent to {email}.</p>
        )}
        {view === "forgot" && (
          <p className="modal-sub">We&apos;ll email you a code to set a new password.</p>
        )}

        {notice && <p className="modal-notice">{notice}</p>}
        {error && <p className="modal-error">{error}</p>}

        <form onSubmit={handleSubmit}>
          {(view === "signin" || view === "signup" || view === "forgot") && (
            <label className="modal-field">
              <span>Email</span>
              <input
                ref={firstFieldRef}
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
          )}

          {view === "signup" && (
            <label className="modal-field">
              <span>Name <em>(optional)</em></span>
              <input type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          )}

          {(view === "confirm" || view === "reset") && (
            <label className="modal-field">
              <span>Code</span>
              <input
                ref={firstFieldRef}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
          )}

          {view !== "forgot" && view !== "confirm" && (
            <label className="modal-field">
              <span>{view === "reset" ? "New password" : "Password"}</span>
              <input
                type="password"
                autoComplete={view === "signin" ? "current-password" : "new-password"}
                required
                minLength={view === "signin" ? undefined : 8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {view !== "signin" && (
                <em className="modal-hint">At least 8 characters, with a number, an uppercase and a lowercase letter.</em>
              )}
            </label>
          )}

          <button type="submit" className="btn-block ready" disabled={busy}>
            {submitLabel[view]}
          </button>
        </form>

        <div className="modal-links">
          {view === "signin" && (
            <>
              <button type="button" onClick={() => go("forgot")}>Forgot password?</button>
              <button type="button" onClick={() => go("signup")}>Create an account</button>
            </>
          )}
          {(view === "signup" || view === "forgot") && (
            <button type="button" onClick={() => go("signin")}>Back to sign in</button>
          )}
          {view === "confirm" && (
            <button
              type="button"
              onClick={() => run(async () => {
                await resendConfirmationCode(email);
                setNotice("Sent - check your email again.");
              })}
            >
              Resend code
            </button>
          )}
          {view === "reset" && (
            <button type="button" onClick={() => go("signin")}>Back to sign in</button>
          )}
        </div>
      </div>
    </div>
  );
}
