"""GET /api/template/{key} - streams a static blank template from COS.

The templates are blank vendor workbooks, not user data: nothing here is
scoped to a person, a thread or a tenant, and the response is byte-identical
for every caller. That is the whole reason this route exists as a plain proxy
rather than as another envelope the agent has to carry.

The COS credentials are the same COS_API_KEY / COS_ENDPOINT / COS_BUCKET env
vars the threadstore already uses; if those are absent the endpoint is 503.

NOTE ON THE MISSING IDENTITY GATE: unlike every other /api route, this one
deliberately does NOT call `client_id(x_tko_client)` (compare main.py's rate-
limit keying and uploads.py). The download is a bare <a href download> anchor
rendered by the form's filedownload field, and an anchor cannot send a custom
header - gating on X-TKO-Client would simply break the link. Nothing is
disclosed by leaving it open: the allow-list below is the entire reachable
surface, and every entry is a blank template. The rate limiter still applies,
since it keys on the header only when one is present and falls back to the
peer address otherwise.
"""

import time
import urllib.parse

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from ..config import settings

router = APIRouter()

COS_IAM_URL = "https://iam.cloud.ibm.com/identity/token"
XLSX_MIME = ("application/vnd.openxmlformats-officedocument"
             ".spreadsheetml.sheet")

# THE ALLOW-LIST IS THE ROUTE'S SECURITY BOUNDARY. `key` is a path parameter
# and is never concatenated into a COS object URL - it is only ever looked up
# here, so no caller can walk the bucket or reach another agent's state. An
# unknown key is a 404, the same answer an unknown route would give.
#
# Each cos_key lives under its agent's state prefix, the scheme the tools'
# workday/cosstore.py documents; the tool-side copy of the eib entry is
# eibc/support/constants.py::TEMPLATE_COS_KEY / TEMPLATE_FILENAME.
TEMPLATES: dict[str, dict[str, str]] = {
    "eib": {
        "cos_key": "agent-state/eibc/template/EIB Load Template _TKO_v41.0.xlsx",
        "filename": "EIB Load Template _TKO_v41.0.xlsx",
        "mime": XLSX_MIME,
    },
}

# How long a browser may keep a template before asking again. The objects are
# immutable in practice - the version is IN the filename, so a new template is
# a new key and a new URL - which is what makes any positive max-age safe.
TEMPLATE_MAX_AGE_S = 3600

# Process-scoped IAM token cache: (token, expires_at)
_iam_cache: tuple[str, float] | None = None
# Process-scoped template body cache, keyed by template key. Same shape and
# lifetime as _iam_cache above (a module dict cleared only by a restart) rather
# than optionsvc's TTL service: that machinery exists to age out data that goes
# stale, and a versioned-filename template never does. A pod that has served
# one template holds ~100 KB and makes no further COS calls for it.
_body_cache: dict[str, bytes] = {}


async def _get_iam_token() -> str:
    global _iam_cache
    if _iam_cache and time.monotonic() < _iam_cache[1]:
        return _iam_cache[0]
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(
                COS_IAM_URL,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                data={"grant_type": "urn:ibm:params:oauth:grant-type:apikey",
                      "apikey": settings.cos_api_key},
            )
    except httpx.HTTPError:
        raise HTTPException(502, "COS IAM token mint failed")
    if r.status_code != 200:
        raise HTTPException(502, "COS IAM token mint failed")
    body = r.json()
    token = body["access_token"]
    ttl = float(body.get("expires_in") or 3600)
    _iam_cache = (token, time.monotonic() + 0.8 * ttl)
    return token


async def _fetch(cos_key: str) -> bytes:
    """The object's bytes, from COS or from this process's memo."""
    token = await _get_iam_token()
    endpoint = settings.cos_endpoint.rstrip("/")
    bucket = settings.cos_bucket.strip("/")
    # URL-encode the key so the spaces and the slashes are handled correctly
    key = urllib.parse.quote(cos_key, safe="")
    url = f"{endpoint}/{bucket}/{key}"

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.get(url,
                                 headers={"Authorization": f"Bearer {token}"})
    except httpx.HTTPError:
        raise HTTPException(502, "Template storage unreachable")

    if r.status_code == 404:
        raise HTTPException(404, "Template not found in storage")
    if r.status_code != 200:
        raise HTTPException(502, f"COS returned {r.status_code}")
    return r.content


@router.get("/api/template/{key}")
async def get_template(key: str) -> Response:
    """Download a blank template workbook by its allow-listed key."""
    spec = TEMPLATES.get(key)
    if spec is None:
        raise HTTPException(404, "Unknown template")
    if not settings.cos_configured:
        raise HTTPException(503, "Template storage not configured")

    content = _body_cache.get(key)
    if content is None:
        content = await _fetch(spec["cos_key"])
        _body_cache[key] = content

    return Response(
        content=content,
        media_type=spec["mime"],
        headers={
            "Content-Disposition": (
                f'attachment; filename="{spec["filename"]}"'
            ),
            "Cache-Control": f"public, max-age={TEMPLATE_MAX_AGE_S}",
        },
    )
