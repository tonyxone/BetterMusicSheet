"use client";

// Direct calls to Cognito's user-pool API, so sign-in can live in the app's
// own UI instead of redirecting to the hosted UI (which can't be themed to
// match the site, can't be framed, and can't be given a close button).
//
// No AWS SDK: every operation here is an UNAUTHENTICATED user-pool call, so
// none of them need SigV4 signing - they're plain JSON POSTs identified by
// an X-Amz-Target header. That keeps the bundle small.
//
// The app client has no secret (see infra/cognito.tf), so there is no
// SECRET_HASH to compute - which is also why doing this from a browser is
// sound rather than a leak.

const REGION = process.env.NEXT_PUBLIC_COGNITO_REGION;
const CLIENT_ID = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;
// Hosted-UI base URL. Only social sign-in needs it - see socialSignInUrl
// below - because that is the one flow Cognito insists on redirecting for;
// email/password stays on this page, calling the API above directly.
const DOMAIN = process.env.NEXT_PUBLIC_COGNITO_DOMAIN;

export const isCognitoConfigured = Boolean(REGION && CLIENT_ID);

/** Which social buttons to show, from a build-time comma list
 * (terraform output cognito_social_providers). Empty until at least one
 * provider has real credentials configured in infra/cognito-idp.tf. */
export type SocialProvider = "Google" | "Facebook" | "SignInWithApple";

export const configuredSocialProviders: SocialProvider[] = (
  process.env.NEXT_PUBLIC_COGNITO_SOCIAL_PROVIDERS ?? ""
)
  .split(",")
  .map((s) => s.trim())
  .filter((s): s is SocialProvider => s === "Google" || s === "Facebook" || s === "SignInWithApple");

/** This app's own callback route - has to match next.config.ts's
 * trailingSlash setting and the app client's registered callback_urls (see
 * infra/cognito.tf) exactly, byte for byte, or Cognito refuses the redirect.
 * Computed rather than hardcoded so it's correct on localhost too. */
export function callbackRedirectUri(): string {
  return `${window.location.origin}/auth/callback/`;
}

/** The hosted-UI URL that starts a social sign-in. The browser is sent here
 * directly (a real navigation, not fetch) - the provider's own login page has
 * to be able to set its own cookies and show its own UI, which an XHR can't
 * do. `redirectUri` must exactly match one of the app client's callback_urls
 * (see infra/cognito.tf) - Cognito rejects anything else outright. */
export function socialSignInUrl(provider: SocialProvider, redirectUri: string): string {
  if (!isCognitoConfigured || !DOMAIN) {
    throw new CognitoError("NotConfigured", "Social sign-in isn't configured for this build.");
  }
  const params = new URLSearchParams({
    identity_provider: provider,
    redirect_uri: redirectUri,
    response_type: "code",
    client_id: CLIENT_ID!,
    scope: "openid email profile",
  });
  return `${DOMAIN}/oauth2/authorize?${params.toString()}`;
}

export type CognitoTokens = {
  IdToken: string;
  AccessToken: string;
  RefreshToken?: string;
  ExpiresIn: number;
};

/** Cognito's own error shape, surfaced so the UI can react to specific
 * failures (unconfirmed account, wrong password) rather than only showing a
 * message. */
export class CognitoError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "CognitoError";
  }
}

async function call(target: string, body: Record<string, unknown>) {
  if (!isCognitoConfigured) {
    throw new CognitoError(
      "NotConfigured",
      "Sign-in isn't configured for this build (NEXT_PUBLIC_COGNITO_REGION / _CLIENT_ID).",
    );
  }

  let res: Response;
  try {
    res = await fetch(`https://cognito-idp.${REGION}.amazonaws.com/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}`,
      },
      body: JSON.stringify({ ClientId: CLIENT_ID, ...body }),
    });
  } catch {
    // fetch only rejects for transport-level failures, and the browser hides
    // the reason - all we get is "Failed to fetch", which tells the user
    // nothing. Name what we were trying to reach instead.
    throw new CognitoError(
      "NetworkError",
      "Couldn't reach the sign-in service. Check your internet connection and try again.",
    );
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    // Errors come back as {__type: "NotAuthorizedException", message: "..."},
    // where __type may be prefixed with a namespace.
    const code = String(data.__type || "UnknownError").split("#").pop()!;
    throw new CognitoError(code, data.message || data.Message || `Cognito request failed (${res.status})`);
  }
  return data;
}

export async function signInWithPassword(email: string, password: string): Promise<CognitoTokens> {
  const data = await call("InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH",
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });
  if (!data.AuthenticationResult) {
    // A challenge (MFA, forced password reset) rather than a completed
    // sign-in. The pool isn't configured for any of these today, so rather
    // than half-implement the flows, fail loudly.
    throw new CognitoError(
      data.ChallengeName || "ChallengeRequired",
      "This account needs an extra sign-in step that isn't supported yet.",
    );
  }
  return data.AuthenticationResult as CognitoTokens;
}

export async function refreshTokens(refreshToken: string): Promise<CognitoTokens> {
  const data = await call("InitiateAuth", {
    AuthFlow: "REFRESH_TOKEN_AUTH",
    AuthParameters: { REFRESH_TOKEN: refreshToken },
  });
  if (!data.AuthenticationResult) throw new CognitoError("NoResult", "could not refresh session");
  return data.AuthenticationResult as CognitoTokens;
}

/** Returns true when Cognito still needs the emailed code before this
 * account can sign in (the normal case for self sign-up). */
export async function signUp(email: string, password: string, name: string): Promise<boolean> {
  // The pool's `name` attribute can't be made required after creation
  // (Cognito schema attributes are immutable), so sign-up enforces it here
  // and always sends one.
  const attributes = [
    { Name: "email", Value: email },
    { Name: "name", Value: name.trim() },
  ];
  const data = await call("SignUp", {
    Username: email,
    Password: password,
    UserAttributes: attributes,
  });
  return !data.UserConfirmed;
}

export function confirmSignUp(email: string, code: string) {
  return call("ConfirmSignUp", { Username: email, ConfirmationCode: code });
}

export function resendConfirmationCode(email: string) {
  return call("ResendConfirmationCode", { Username: email });
}

export function forgotPassword(email: string) {
  return call("ForgotPassword", { Username: email });
}

export function confirmForgotPassword(email: string, code: string, newPassword: string) {
  return call("ConfirmForgotPassword", { Username: email, ConfirmationCode: code, Password: newPassword });
}
