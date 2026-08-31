"""Anonymous per-browser identity - no real accounts. Every request is
identified by its X-Guest-Id header (a random id the frontend generates once
and persists in its own cookie - see better_music_sheet_web/lib/guest-id.ts),
or a single shared GUEST_USER_ID if that header is missing (e.g. direct API
calls with no client-side JS involved)."""
import re

from fastapi import Header

_UUID_RE = re.compile(r"^[0-9a-fA-F-]{1,64}$")

GUEST_USER_ID = "guest"


def get_current_user_id(x_guest_id: str = Header(None)):
    # x_guest_id becomes a storage key prefix (see storage.py), so it's
    # validated as UUID-shaped rather than trusted verbatim.
    if x_guest_id and _UUID_RE.match(x_guest_id):
        return x_guest_id
    return GUEST_USER_ID
