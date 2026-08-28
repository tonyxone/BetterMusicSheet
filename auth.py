"""Two separate JWT concerns, deliberately not shared code:

1. Verifying a Cognito ID token - only ever done once, in POST /api/auth/token,
   to bootstrap a session. Checked against Cognito's own public keys (JWKS).
2. Minting/verifying this backend's OWN token - what every other endpoint
   actually checks. Signed with a secret only this backend knows (HS256), so
   verifying it never needs a network call to Cognito.

See the module docstring in server.py for why this two-step exchange exists
instead of sending the Cognito token on every request.
"""
import json
import os
import time
import urllib.request

from fastapi import Header, HTTPException
from jose import JWTError, jwt

COGNITO_REGION = os.environ.get("COGNITO_REGION", "us-west-1")
COGNITO_USER_POOL_ID = os.environ["COGNITO_USER_POOL_ID"]
COGNITO_APP_CLIENT_ID = os.environ["COGNITO_APP_CLIENT_ID"]
COGNITO_ISSUER = f"https://cognito-idp.{COGNITO_REGION}.amazonaws.com/{COGNITO_USER_POOL_ID}"

BACKEND_JWT_SECRET = os.environ["BACKEND_JWT_SECRET"]
BACKEND_JWT_ALGORITHM = "HS256"
BACKEND_JWT_LIFETIME_SECONDS = 3600

_jwks_cache = None  # fetched lazily, cached for the process lifetime


def _get_jwks():
    global _jwks_cache
    if _jwks_cache is None:
        with urllib.request.urlopen(f"{COGNITO_ISSUER}/.well-known/jwks.json", timeout=10) as resp:
            _jwks_cache = json.load(resp)["keys"]
    return _jwks_cache


def verify_cognito_id_token(token):
    """Verify a Cognito ID token's signature/claims and return (sub, email).
    Raises HTTPException(401) on anything invalid."""
    try:
        header = jwt.get_unverified_header(token)
        key = next((k for k in _get_jwks() if k["kid"] == header["kid"]), None)
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
    return claims["sub"], claims.get("email")


def mint_backend_token(user_id):
    now = int(time.time())
    return jwt.encode(
        {"sub": user_id, "iat": now, "exp": now + BACKEND_JWT_LIFETIME_SECONDS},
        BACKEND_JWT_SECRET, algorithm=BACKEND_JWT_ALGORITHM,
    )


def get_current_user_id(authorization: str = Header(None)):
    """FastAPI dependency - verifies this backend's own token (not Cognito's)."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing Bearer token")
    token = authorization.removeprefix("Bearer ")
    try:
        claims = jwt.decode(token, BACKEND_JWT_SECRET, algorithms=[BACKEND_JWT_ALGORITHM])
    except JWTError as e:
        raise HTTPException(401, f"invalid token: {e}")
    return claims["sub"]
