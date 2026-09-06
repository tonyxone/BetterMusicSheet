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

export const isCognitoConfigured = Boolean(REGION && CLIENT_ID);

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
