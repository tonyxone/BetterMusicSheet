"""Identity: optionally signed in via Cognito, otherwise an anonymous guest.

Sign-in is NOT required to use most of the app - a guest id still reads
their own history and plays sheets uploaded under it. Uploading itself is a
members feature (see server.py's upload routes): a guest id authenticates
reads, never a new upload. Signing in also gives a visitor a stable identity
that outlives their browser cookie, and files uploaded while signed in are
stored under their Cognito user id rather than a per-browser guest id - see
storage.py.

Two separate JWT concerns, deliberately not shared code:

1. Verifying a Cognito ID token - only ever done once, in POST
   /api/auth/token, to bootstrap a session. Checked against Cognito's own
   public keys (JWKS).
2. Minting/verifying this backend's OWN token - what every other endpoint
   actually checks. Signed with a secret only this backend knows (HS256), so
   verifying it never needs a network call to Cognito.

See the module docstring in server.py for why this two-step exchange exists
instead of sending the Cognito token on every request.
"""
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

import boto3
from botocore.exceptions import ClientError
from fastapi import Header, HTTPException
from jose import JWTError, jwt

from config import IS_PRODUCTION

# Both a Cognito `sub` and a frontend-generated guest id are UUIDs, and both
# end up as an S3 key prefix (see storage.py) - so whichever one identifies a
# request, it's shape-checked here rather than trusted verbatim.
_UUID_RE = re.compile(r"^[0-9a-fA-F-]{1,64}$")

# Stand-in for "no user pool configured". Kept explicit so the token exchange
# can say so, instead of building a nonsense issuer URL and failing later with
# an HTTP error nobody can act on.
UNCONFIGURED = "local-dev-unused"

COGNITO_REGION = os.environ.get("COGNITO_REGION", os.environ.get("AWS_REGION", "us-west-1"))
if IS_PRODUCTION:
    COGNITO_USER_POOL_ID = os.environ["COGNITO_USER_POOL_ID"]
    COGNITO_APP_CLIENT_ID = os.environ["COGNITO_APP_CLIENT_ID"]
    BACKEND_JWT_SECRET = os.environ["BACKEND_JWT_SECRET"]
    # Hosted-UI base URL, needed only by the social sign-in exchange below.
    # Not required: the pool works without any federated provider configured.
    COGNITO_DOMAIN = os.environ.get("COGNITO_DOMAIN", UNCONFIGURED)
else:
    # Local dev needs no Cognito setup at all: the guest path below works
    # without any of these, and POST /api/auth/token simply fails if it's
    # called without a real user pool configured. Set the same env vars
    # locally (see better_music_sheet_web/.env.local.example) to exercise
    # the real sign-in flow against a dev user pool.
    COGNITO_USER_POOL_ID = os.environ.get("COGNITO_USER_POOL_ID", UNCONFIGURED)
    COGNITO_APP_CLIENT_ID = os.environ.get("COGNITO_APP_CLIENT_ID", UNCONFIGURED)
    BACKEND_JWT_SECRET = os.environ.get("BACKEND_JWT_SECRET", "local-dev-secret-not-for-production")
    COGNITO_DOMAIN = os.environ.get("COGNITO_DOMAIN", UNCONFIGURED)
COGNITO_ISSUER = f"https://cognito-idp.{COGNITO_REGION}.amazonaws.com/{COGNITO_USER_POOL_ID}"

BACKEND_JWT_ALGORITHM = "HS256"
BACKEND_JWT_LIFETIME_SECONDS = 3600

GUEST_USER_ID = "guest"


def get_entitlement(user_id, is_guest=False):
    """Return the account's subscription fields, or the free entitlement.

    Guest identifiers are intentionally never looked up: they identify
    anonymous uploads, not an account that can own a subscription.
    """
    free = {
        "tier": "free", "plan": None, "status": None,
        "started_at": None, "current_period_end": None,
        "cancel_at_period_end": False, "platform": None,
    }
    if is_guest:
        return free

    from db import get_subscription
    subscription = get_subscription(user_id)
    if subscription is None or subscription["status"] not in ("active", "trialing"):
        return free
    # Do not depend on a provider webhook arriving at the exact cancellation
    # instant. A scheduled cancellation remains premium through its precise
    # period-end second, then becomes free on the next entitlement check.
    if (subscription["cancel_at_period_end"]
            and subscription["current_period_end"] is not None
            and subscription["current_period_end"] <= int(time.time())):
        return free
    return {
        "tier": "premium",
        "plan": subscription["plan"],
        "status": subscription["status"],
        # Absent on records written before it was stored, until the next sync.
        "started_at": subscription.get("started_at"),
        "current_period_end": subscription["current_period_end"],
        "cancel_at_period_end": subscription["cancel_at_period_end"],
        "platform": subscription["platform"],
    }

def is_trial_eligible(user_id):
    """Whether this account's next subscription gets the free trial.

    Only a first-time subscriber does. Any subscription record at all - active,
    cancelled or expired, bought through Stripe or Apple - means the account
    has subscribed before (or is subscribed now), so rejoining is billed from
    day one. An abandoned checkout never writes a record, so it doesn't count.
    """
    from db import get_subscription
    return get_subscription(user_id) is None


_jwks_cache = None  # fetched lazily, cached for the process lifetime


def _get_jwks():
    global _jwks_cache
    if _jwks_cache is None:
        with urllib.request.urlopen(f"{COGNITO_ISSUER}/.well-known/jwks.json", timeout=10) as resp:
            _jwks_cache = json.load(resp)["keys"]
    return _jwks_cache


def is_cognito_configured():
    """Whether this server can verify Cognito tokens at all."""
    return COGNITO_USER_POOL_ID != UNCONFIGURED and COGNITO_APP_CLIENT_ID != UNCONFIGURED


def exchange_authorization_code(code, redirect_uri):
    """Trade a hosted-UI authorization code for Cognito's ID token.

    Google, Apple and Facebook cannot go through the password flow the app's
    own modal uses, because the credentials are typed on the provider's site,
    not ours. The browser comes back from that round trip holding a one-time
    code instead, and this turns it into a token.

    The swap happens on the server rather than in the browser so the code and
    the tokens it becomes never pass through page scripts. The app client has
    no secret (it is a public client), so no client authentication is sent.

    `redirect_uri` is not validated here on purpose: Cognito checks it against
    the pool client's registered callback_urls and rejects a mismatch, so a
    forged value fails the exchange rather than redirecting anyone anywhere.

    Returns (id_token, refresh_token) - refresh_token may be None if Cognito
    didn't issue one."""
    if not is_cognito_configured():
        raise HTTPException(
            503,
            "Sign-in isn't configured on this server: set COGNITO_USER_POOL_ID "
            "and COGNITO_APP_CLIENT_ID (see .env.example).",
        )
    if COGNITO_DOMAIN == UNCONFIGURED:
        raise HTTPException(
            503,
            "Social sign-in isn't configured on this server: set COGNITO_DOMAIN "
            "to the hosted-UI base URL (terraform output cognito_hosted_ui_domain).",
        )
    request = urllib.request.Request(
        f"{COGNITO_DOMAIN}/oauth2/token",
        data=urllib.parse.urlencode({
            "grant_type": "authorization_code",
            "client_id": COGNITO_APP_CLIENT_ID,
            "code": code,
            "redirect_uri": redirect_uri,
        }).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as e:
        # Cognito answers invalid_grant for a code that is expired or already
        # spent - which someone hits just by reloading the callback page. That
        # is the caller's problem to retry, not a server fault, so it is a 400.
        try:
            reason = json.load(e).get("error", e.reason)
        except (ValueError, OSError):
            reason = e.reason
        raise HTTPException(400, f"That sign-in could not be completed ({reason}). Please try again.")
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise HTTPException(502, f"Couldn't reach Cognito to complete the sign-in ({e}).")

    id_token = payload.get("id_token")
    if not id_token:
        raise HTTPException(502, "Cognito completed the sign-in without returning an ID token.")
    # refresh_token: the frontend has no Cognito tokens of its own for a
    # social sign-in (unlike the password flow, which calls Cognito directly
    # and already holds one) - this is the only chance to hand it one, or the
    # session is stuck expiring at BACKEND_JWT_LIFETIME_SECONDS with no way to
    # renew short of signing in again.
    return id_token, payload.get("refresh_token")


def verify_cognito_id_token(token):
    """Verify a Cognito ID token's signature/claims and return
    (sub, email, display_name). Raises HTTPException(401) on anything
    invalid.

    display_name is whatever the pool actually gave us, in descending order
    of how human it reads. Sign-up asks for a name, so new accounts have the
    `name` claim; the rest of the chain covers accounts made before that and
    identity providers that spell it differently.

    It deliberately does NOT fall back to the sub: showing someone a raw UUID
    where their name belongs looks broken. None means "no name known", and
    the caller decides what to render."""
    if not is_cognito_configured():
        # Without this the issuer URL is built from a placeholder, the JWKS
        # fetch 400s, and an unhandled HTTPError becomes an opaque 500 - which
        # reaches the browser as a bare "Failed to fetch" with no CORS headers.
        raise HTTPException(
            503,
            "Sign-in isn't configured on this server: set COGNITO_USER_POOL_ID "
            "and COGNITO_APP_CLIENT_ID (see .env.example).",
        )
    try:
        header = jwt.get_unverified_header(token)
        try:
            keys = _get_jwks()
        except (urllib.error.URLError, OSError, ValueError, KeyError) as e:
            # Network trouble, or a pool id that doesn't resolve. Not the
            # caller's fault, and not a bad token - say so.
            raise HTTPException(
                502, f"Couldn't reach Cognito to verify the sign-in ({e}).",
            )
        key = next((k for k in keys if k["kid"] == header["kid"]), None)
        if key is None:
            raise JWTError("no matching JWKS key")
        claims = jwt.decode(
            token, key, algorithms=["RS256"],
            audience=COGNITO_APP_CLIENT_ID, issuer=COGNITO_ISSUER,
            # Cognito's authorization-code-flow ID tokens carry an at_hash
            # claim binding them to a specific access token. We deliberately
            # never request/use Cognito's access token (see module docstring -
            # this backend mints its own), so there's no access_token to
            # validate that hash against; jose requires explicitly opting out
            # of that check rather than silently skipping it.
            options={"verify_at_hash": False},
        )
        if claims.get("token_use") != "id":
            raise JWTError("not an ID token")
    except JWTError as e:
        raise HTTPException(401, f"invalid Cognito token: {e}")

    sub = claims["sub"]
    email = claims.get("email")
    display_name = (
        claims.get("name")
        or claims.get("given_name")
        or claims.get("preferred_username")
        or (email.split("@")[0] if email else None)
    )
    return sub, email, display_name


def mint_backend_token(user_id):
    now = int(time.time())
    return jwt.encode(
        {"sub": user_id, "iat": now, "exp": now + BACKEND_JWT_LIFETIME_SECONDS},
        BACKEND_JWT_SECRET, algorithm=BACKEND_JWT_ALGORITHM,
    )


def _user_id_from_backend_token(token):
    try:
        claims = jwt.decode(token, BACKEND_JWT_SECRET, algorithms=[BACKEND_JWT_ALGORITHM])
    except JWTError as e:
        raise HTTPException(401, f"invalid token: {e}")
    user_id = claims["sub"]
    # This backend minted the token, so the sub is already trustworthy - but
    # it still becomes a storage key prefix, so it gets the same shape check
    # a guest id does rather than being special-cased as trusted.
    if not _UUID_RE.match(user_id):
        raise HTTPException(401, "malformed subject in token")
    return user_id


def get_current_user_id(authorization: str = Header(None), x_guest_id: str = Header(None)):
    """FastAPI dependency, in priority order:
    1. This backend's own token, if sent - the visitor is signed in, and the
       returned id is their Cognito `sub`.
    2. X-Guest-Id, an anonymous per-browser id the frontend generates itself
       and persists in a cookie on ITS OWN origin (see
       better_music_sheet_web/lib/guest-id.ts) - not a cross-origin cookie
       read by this API, just a value it's told on each request.
    3. A single shared GUEST_USER_ID, if neither is present (e.g. direct API
       calls with no client-side JS involved at all).

    Used by every route that reads or manages a job a visitor already owns
    (history, status, assets, delete) - not by the upload routes, which
    require a real sign-in (get_signed_in_user_id) and treat any of the
    guest identities above as anonymous. A visitor who signs in after
    uploading as a guest keeps reading their guest-owned jobs under the old
    id; work is not retroactively moved (see server.py)."""
    if authorization and authorization.startswith("Bearer "):
        return _user_id_from_backend_token(authorization.removeprefix("Bearer "))
    if x_guest_id and _UUID_RE.match(x_guest_id):
        return x_guest_id
    return GUEST_USER_ID


def get_signed_in_user_id(authorization: str = Header(None)):
    """Like get_current_user_id, but None for a guest instead of a guest id -
    for endpoints that only mean anything for a real account (GET /api/me)."""
    if authorization and authorization.startswith("Bearer "):
        return _user_id_from_backend_token(authorization.removeprefix("Bearer "))
    return None


def require_premium(authorization: str = Header(None), x_guest_id: str = Header(None)):
    """FastAPI dependency that admits only signed-in premium accounts."""
    if not authorization or not authorization.startswith("Bearer "):
        # An X-Guest-Id never grants entitlement, regardless of its value.
        raise HTTPException(403, {"code": "premium_required", "tier": "free"})
    user_id = _user_id_from_backend_token(authorization.removeprefix("Bearer "))
    entitlement = get_entitlement(user_id)
    if entitlement["tier"] != "premium":
        raise HTTPException(403, {"code": "premium_required", "tier": entitlement["tier"]})
    return user_id


def delete_cognito_user(sub):
    """Delete the Cognito account itself - required by Apple's App Store
    guideline 5.1.1(v): an app that lets someone create an account has to
    let them delete it, and deletion has to remove the actual account, not
    just some in-app data next to a Cognito account that still exists.

    AdminDeleteUser takes a Username, which is NOT the same as the sub for a
    federated sign-in - Cognito assigns Google/Apple users a Username like
    "Google_<id>" instead, since username_attributes=["email"] only makes
    email an alias for native accounts (see cognito.tf). So the user has to
    be looked up by sub first; ListUsers supports filtering on it directly.

    A no-op in local dev (no real pool to call), and idempotent in
    production - a sub that's already gone is treated as success rather than
    an error, since the end state ("no such account") is what was asked for
    either way."""
    if not is_cognito_configured():
        return
    client = boto3.client("cognito-idp", region_name=COGNITO_REGION)
    try:
        found = client.list_users(UserPoolId=COGNITO_USER_POOL_ID, Filter=f'sub = "{sub}"').get("Users", [])
        if not found:
            return
        client.admin_delete_user(UserPoolId=COGNITO_USER_POOL_ID, Username=found[0]["Username"])
    except ClientError as e:
        raise HTTPException(502, f"Couldn't delete the Cognito account ({e}).")
