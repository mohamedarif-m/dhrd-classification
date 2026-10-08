"""tko-agents-ui proxy: allowlist FastAPI front for the wxO Runs API.

The browser talks only to /api/*; the WO API key and agent ids live server-side
only. This module is the app factory and nothing else: middleware, security
headers and CSP, router includes, startup warm-up, and the built-UI mount.

    app/routes/    the /api surface, one module per slice
    app/services/  upstream client, stores, sanitization (no FastAPI)
    app/deps.py    the singletons and guards those routes share
    app/jobs/      standalone scheduled jobs

See ../README.md for run instructions.
"""

import asyncio
import logging
import os
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import deps
from .config import settings
from .routes import chat, class_specs, classify, library, meta, options, pd_files, pending_files, template, threads, uploads

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("tko.proxy")

@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Warm every registered options source in the background. A failure here
    # must never keep the proxy from starting - the UI falls back to the
    # starter rows the form contract already ships.
    try:
        if deps.options is not None:
            for entry in deps.registry.get("agents", []):
                if entry.get("option_sources"):
                    deps.spawn(deps.options.refresh(entry["key"]))
    except Exception as e:  # noqa: BLE001
        log.warning("options warm-up skipped: %s", type(e).__name__)
    yield
    # Shutdown: the thread store pushes to COS on a background worker, so a
    # row recorded in the last moments of the process is still in the queue
    # here. Give the queue a bounded moment to drain before the container
    # goes - local disk is ephemeral, so an unpushed row is a lost thread.
    try:
        await asyncio.to_thread(deps.store.flush)
    except Exception as e:  # noqa: BLE001
        log.warning("thread store flush skipped: %s", type(e).__name__)


app = FastAPI(title="tko-agents-ui proxy", version="0.3.0", lifespan=lifespan)

# In single-container production mode (STATIC_DIR set) the browser is always
# same-origin, so no cross-origin requests occur and CORS is irrelevant.
# We still register the middleware so it handles the explicitly configured dev
# origin (ALLOWED_ORIGIN, default localhost:5174) without crashing.
# allow_origins=["*"] is intentionally NOT used — we only allow the one
# configured origin, keeping the security posture tight.
_cors_origins = [settings.allowed_origin] if settings.allowed_origin else []
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["GET", "POST", "PATCH"],
    allow_headers=["Content-Type", "X-TKO-Client"],
    # Retry-After rides the 429; a cross-origin caller cannot read it otherwise.
    expose_headers=["Retry-After"],
)

_STATIC_ROOT: Path | None = None
if settings.static_dir and Path(settings.static_dir).is_dir():
    _STATIC_ROOT = Path(settings.static_dir).resolve()
    if not (_STATIC_ROOT / "index.html").is_file():
        log.warning("STATIC_DIR has no index.html; static serving disabled")
        _STATIC_ROOT = None

# The API-only CSP ('none') blocks a page from loading anything, which is right
# for JSON responses and wrong for the app itself. When this process also
# serves the built UI, non-/api responses get a same-origin CSP instead.
API_CSP = "default-src 'none'; frame-ancestors 'none'"
APP_CSP_BASE = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; "
                "base-uri 'self'; form-action 'self'")

# Embedding: with FRAME_ANCESTORS set (space-separated origins) the app page
# may be framed by those hosts - the Microsoft Teams tab case, where the tab
# is an iframe. Unset keeps the app unframable. frame-ancestors does NOT
# inherit from default-src, so both policies name it explicitly.
_FRAME_ANCESTORS = " ".join(settings.frame_ancestors.split()) or "'none'"
APP_CSP = APP_CSP_BASE + "; frame-ancestors " + _FRAME_ANCESTORS

# ---- rate limiting (sliding minute window, per client identity) ----
#
# Two independent buckets so the cheap path cannot starve the expensive one or
# the other way round (limits and rationale: config.Settings):
#
#   /api/options*   OPTIONS_RATE_LIMIT_PER_MIN - a cached read the browser
#                   polls once per source per few seconds while a form warms.
#   everything else RATE_LIMIT_PER_MIN - one upstream call apiece.
#
# Keying is per USER, not per source IP: behind Code Engine every request
# arrives from the router's address, so an IP key is one shared bucket for the
# whole tenant and two people with a form open would rate-limit each other. The
# key is X-TKO-Client, the anonymous per-browser identity every UI call already
# sends, falling back to the peer address. It is a rate-limit key only, never
# authentication - rotating it just buys a fresh bucket, as rotating IPs does.

_hits: dict[str, deque] = defaultdict(deque)
_options_hits: dict[str, deque] = defaultdict(deque)


def rate_key(request: Request) -> str:
    ident = request.headers.get("x-tko-client")
    if ident and 8 <= len(ident) <= 64 and ident.replace("-", "").isalnum():
        return "c:" + ident
    return "h:" + (request.client.host if request.client else "?")


@app.middleware("http")
async def rate_limit_and_headers(request: Request, call_next):
    if request.url.path.startswith("/api/"):
        is_options = request.url.path.startswith("/api/options")
        buckets = _options_hits if is_options else _hits
        limit = (settings.options_rate_limit_per_min if is_options
                 else settings.rate_limit_per_min)
        key = rate_key(request)
        now = time.time()
        window = buckets[key]
        while window and window[0] < now - 60:
            window.popleft()
        if len(window) >= limit:
            # Retry-After says when the window frees up, so a polling client can
            # back off precisely instead of guessing.
            retry_after = max(1, int(60 - (now - window[0])) + 1)
            return StreamingResponse(iter(['{"detail": "rate limited"}']),
                                     status_code=429, media_type="application/json",
                                     headers={"Retry-After": str(retry_after)})
        window.append(now)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    is_app = _STATIC_ROOT is not None and not request.url.path.startswith("/api/")
    response.headers["Content-Security-Policy"] = APP_CSP if is_app else API_CSP
    # X-Frame-Options has no allowlist form, so it cannot express "Teams may
    # frame this". Where framing is deliberately allowed it is omitted and CSP
    # frame-ancestors (which supersedes it in every current browser) governs;
    # everywhere else it stays as the belt-and-braces DENY.
    if not (is_app and settings.frame_ancestors):
        response.headers["X-Frame-Options"] = "DENY"
    return response


# ---- /api surface ----

app.include_router(meta.router)
app.include_router(chat.router)
app.include_router(classify.router)
app.include_router(class_specs.router)
app.include_router(pd_files.router)
app.include_router(library.router)
app.include_router(threads.router)
app.include_router(options.router)
app.include_router(uploads.router)
app.include_router(pending_files.router)
app.include_router(template.router)


# ---- built UI (single-container deploy) ----
#
# Registered LAST so every /api route above wins the match. Two pieces:
#   1. /assets/* -> StaticFiles over the vite build output (hashed bundles).
#   2. a catch-all GET that serves any other real file at the static root
#      (favicon, logos) and otherwise returns index.html, so client-side
#      routes and deep links boot the SPA instead of 404ing.
# With STATIC_DIR unset neither is registered and the app is unchanged.

# Cache-Control, the standard SPA split. LIVE DEFECT 2026-08-12: neither piece
# sent one, so browsers fell back to HEURISTIC caching (roughly a tenth of the
# time since Last-Modified) and served a stale index.html pointing at a bundle
# that no longer existed. A plain refresh after a deploy kept running the old
# app; only a hard refresh picked the new one up. A deployed change has to be
# there on a normal refresh.
#
# The two halves are opposites on purpose:
#   * index.html is the ONLY unhashed document and the thing that names the
#     current bundle, so it must be revalidated every single load.
#   * everything under /assets carries a content hash IN ITS FILENAME, so a
#     given URL's bytes can never change. Caching those forever is not a
#     trade-off - it is strictly faster than today AND strictly safer, because
#     a new build produces new names rather than new content at old names.
IMMUTABLE_CACHE = "public, max-age=31536000, immutable"
NO_CACHE = "no-cache"


class _HashedAssets(StaticFiles):
    """StaticFiles + the immutable header. Subclassed rather than wrapped in
    middleware so Starlette's conditional-request handling (304s) is kept."""

    def file_response(self, *args, **kwargs):  # type: ignore[override]
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = IMMUTABLE_CACHE
        return response


if _STATIC_ROOT is not None:
    _INDEX = _STATIC_ROOT / "index.html"

    if (_STATIC_ROOT / "assets").is_dir():
        app.mount("/assets", _HashedAssets(directory=_STATIC_ROOT / "assets"),
                  name="assets")

    def _revalidating(path: Path, request: Request, media_type: str | None = None):
        """An unhashed file, served must-revalidate - and answering 304 when
        the browser already has it.

        The 304 half is not decoration. `no-cache` means "ask me every load",
        and a bare FileResponse ANSWERS every such ask with the whole file:
        Starlette implements conditional requests in StaticFiles, not in
        FileResponse (verified against the live app - /assets/* returned 304
        for a matching If-None-Match while / returned 200). Without this the
        fix would trade a staleness bug for a re-download on every page load.
        """
        # stat_result is passed explicitly: Starlette only computes the etag
        # and last-modified headers eagerly when it is, otherwise it stats
        # during __call__ and there is no validator to compare against here.
        response = FileResponse(path, media_type=media_type,
                                stat_result=os.stat(path))
        response.headers["Cache-Control"] = NO_CACHE
        etag = response.headers.get("etag")
        if etag and etag in [
            t.strip() for t in (request.headers.get("if-none-match") or "").split(",")
        ]:
            # Same validators back on the 304, per RFC 9110.
            keep = {k: v for k, v in response.headers.items()
                    if k.lower() in ("etag", "last-modified", "cache-control")}
            return Response(status_code=304, headers=keep)
        return response

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str, request: Request):
        if full_path.startswith("api/"):
            raise HTTPException(404, "Not found")
        if full_path:
            candidate = (_STATIC_ROOT / full_path).resolve()
            # Path-traversal guard: never serve outside the static root.
            if candidate.is_file() and candidate.is_relative_to(_STATIC_ROOT):
                # Root-level files (favicon, logos) are unhashed too, so they
                # revalidate like index.html rather than being pinned.
                return _revalidating(candidate, request)
        return _revalidating(_INDEX, request, media_type="text/html")

    log.info("serving built UI from %s", _STATIC_ROOT)
