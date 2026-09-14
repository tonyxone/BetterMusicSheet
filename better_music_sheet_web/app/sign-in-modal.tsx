"use client";

import { useEffect, useRef, useState } from "react";
import { signIn } from "@/lib/auth";
import {
  CognitoError,
  callbackRedirectUri,
  configuredSocialProviders,
  confirmForgotPassword,
  confirmSignUp,
  forgotPassword,
  isCognitoConfigured,
  resendConfirmationCode,
  signUp,
  socialSignInUrl,
  type SocialProvider,
} from "@/lib/cognito";

/** Which step of the flow the modal is showing. Sign-up and password reset
 * both end at a code-entry step, so they're separate views rather than one
 * generic one - the copy and the next action differ. */
type View = "signin" | "signup" | "confirm" | "forgot" | "reset";

/** Each provider's own mark and wording. "Sign in with X" is the sanctioned
 * phrasing for all three, and the logos below are the official ones drawn
 * unmodified - which is what Google's and Apple's brand guidelines require of
 * a sign-in button, and why these colours are hardcoded rather than themed:
 * the Google G's four colours and Apple's black are part of the mark, not of
 * this site's palette. `css` names the style variant in globals.css. */
const SOCIAL: Record<SocialProvider, { label: string; css: string }> = {
  Google: { label: "Sign in with Google", css: "google" },
  SignInWithApple: { label: "Sign in with Apple", css: "apple" },
  Facebook: { label: "Sign in with Facebook", css: "facebook" },
};

function SocialIcon({ provider }: { provider: SocialProvider }) {
  if (provider === "Google") {
    // The four-colour G, on its own transparent ground so it sits on the
    // white button exactly as Google supplies it.
    return (
      <svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.28-3.14.76-4.59l-7.97-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
      </svg>
    );
  }
  if (provider === "Facebook") {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
        <path d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.09 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.09 24 18.1 24 12.07z" />
      </svg>
    );
  }
  // Apple's mark, white on the black button - currentColor so it follows the
  // button's own text colour rather than being pinned to one variant.
  return (
    <svg viewBox="0 0 384 512" width="18" height="18" fill="currentColor" aria-hidden="true">
      <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
    </svg>
  );
}

function SocialButtons() {
  // Both checked: NEXT_PUBLIC_COGNITO_SOCIAL_PROVIDERS naming a provider
  // means nothing without the region/client id that make socialSignInUrl
  // safe to call - and it's called directly in the href below, not behind a
  // click handler, so this has to be right before render rather than caught.
  if (!isCognitoConfigured || configuredSocialProviders.length === 0) return null;
  return (
    <>
      <div className="modal-social">
        {configuredSocialProviders.map((provider) => (
          <a
            key={provider}
            className={`modal-social-btn ${SOCIAL[provider].css}`}
            href={socialSignInUrl(provider, callbackRedirectUri())}
          >
            <SocialIcon provider={provider} />
            {SOCIAL[provider].label}
          </a>
        ))}
      </div>
      <div className="modal-divider">or</div>
    </>
  );
}

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
      if (!name.trim()) {
        setError("Please enter a display name.");
        return;
      }
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
        <button type="button" className="modal-close" title="Close" aria-label="Close" onClick={onClose}>
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

        {/* Only on the sign-in screen: a federated provider creates the pool
            user itself on first use, the same way it signs one in on every
            later use - there's no separate "create account" step for it. */}
        {view === "signin" && <SocialButtons />}

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
              <span>Display name</span>
              <input
                type="text"
                autoComplete="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
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

          <button type="submit" className="btn-block ready" disabled={busy} title={submitLabel[view]}>
            {submitLabel[view]}
          </button>
        </form>

        <div className="modal-links">
          {view === "signin" && (
            <>
              <button type="button" title="Reset a forgotten password" onClick={() => go("forgot")}>Forgot password?</button>
              <button type="button" title="Register a new account" onClick={() => go("signup")}>Create an account</button>
            </>
          )}
          {(view === "signup" || view === "forgot") && (
            <button type="button" title="Return to the sign-in form" onClick={() => go("signin")}>Back to sign in</button>
          )}
          {view === "confirm" && (
            <button
              type="button"
              title="Send another confirmation code"
              onClick={() => run(async () => {
                await resendConfirmationCode(email);
                setNotice("Sent - check your email again.");
              })}
            >
              Resend code
            </button>
          )}
          {view === "reset" && (
            <button type="button" title="Return to the sign-in form" onClick={() => go("signin")}>Back to sign in</button>
          )}
        </div>
      </div>
    </div>
  );
}
