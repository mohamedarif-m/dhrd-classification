"""Static (built UI) serving. STATIC_DIR unset must leave the app unchanged."""

import importlib
import sys

import pytest
from fastapi.testclient import TestClient


def _fresh_app(tmp_path, monkeypatch, static_dir: str | None,
               frame_ancestors: str | None = None):
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    if frame_ancestors is None:
        monkeypatch.delenv("FRAME_ANCESTORS", raising=False)
    else:
        monkeypatch.setenv("FRAME_ANCESTORS", frame_ancestors)
    monkeypatch.delenv("WO_INSTANCE", raising=False)
    monkeypatch.delenv("WO_API_KEY", raising=False)
    monkeypatch.delenv("TKO_ENV_FILE", raising=False)
    for var in ("COS_API_KEY", "COS_ENDPOINT", "COS_BUCKET"):
        monkeypatch.delenv(var, raising=False)
    if static_dir is None:
        monkeypatch.delenv("STATIC_DIR", raising=False)
    else:
        monkeypatch.setenv("STATIC_DIR", static_dir)
    for mod in [m for m in list(sys.modules) if m.startswith("app")]:
        del sys.modules[mod]
    main = importlib.import_module("app.main")
    return TestClient(main.app), main


@pytest.fixture()
def built(tmp_path):
    root = tmp_path / "static"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text(
        '<!doctype html><html><body><div id="root"></div></body></html>')
    (root / "assets" / "index-abc123.js").write_text("console.log('app')")
    (root / "favicon.svg").write_text("<svg/>")
    return root


def test_no_static_dir_leaves_root_404(tmp_path, monkeypatch):
    c, _ = _fresh_app(tmp_path, monkeypatch, None)
    assert c.get("/").status_code == 404
    assert c.get("/threads/anything").status_code == 404
    r = c.get("/api/health")
    assert r.status_code == 200 and r.json()["mode"] == "unconfigured"
    assert r.headers["Content-Security-Policy"] == "default-src 'none'; frame-ancestors 'none'"


def test_static_dir_serves_spa(tmp_path, monkeypatch, built):
    c, _ = _fresh_app(tmp_path, monkeypatch, str(built))

    root = c.get("/")
    assert root.status_code == 200
    assert 'id="root"' in root.text
    assert root.headers["content-type"].startswith("text/html")
    assert "'self'" in root.headers["Content-Security-Policy"]

    asset = c.get("/assets/index-abc123.js")
    assert asset.status_code == 200 and "console.log" in asset.text

    fav = c.get("/favicon.svg")
    assert fav.status_code == 200 and fav.text == "<svg/>"

    health = c.get("/api/health")
    assert health.status_code == 200
    assert health.json() == {"mode": "unconfigured"}
    assert health.headers["Content-Security-Policy"] == "default-src 'none'; frame-ancestors 'none'"

    # Unknown client-side route falls back to index.html, not 404.
    deep = c.get("/agents/jobreq/thread/123")
    assert deep.status_code == 200 and 'id="root"' in deep.text

    # Unknown API paths stay 404 - never the SPA shell.
    assert c.get("/api/nope").status_code == 404
    # Missing asset under the mount is a real 404 (no HTML for a .js request).
    assert c.get("/assets/missing.js").status_code == 404


# The value tko-teams-launcher/README.md tells us to set on the Code Engine app.
TEAMS_ANCESTORS = ("https://teams.microsoft.com https://*.teams.microsoft.com "
                   "https://*.cloud.microsoft https://*.office.com "
                   "https://*.microsoft365.com")


def test_default_refuses_framing(tmp_path, monkeypatch, built):
    """FRAME_ANCESTORS unset must leave the shipped headers exactly as before."""
    c, _ = _fresh_app(tmp_path, monkeypatch, str(built))
    root = c.get("/")
    assert "frame-ancestors 'none'" in root.headers["Content-Security-Policy"]
    assert root.headers["X-Frame-Options"] == "DENY"
    api = c.get("/api/health")
    assert "frame-ancestors 'none'" in api.headers["Content-Security-Policy"]
    assert api.headers["X-Frame-Options"] == "DENY"


def test_frame_ancestors_env_opens_app_pages_only(tmp_path, monkeypatch, built):
    c, _ = _fresh_app(tmp_path, monkeypatch, str(built),
                      frame_ancestors=TEAMS_ANCESTORS)

    for path in ("/", "/a/jobreq", "/favicon.svg"):
        r = c.get(path)
        assert r.status_code == 200, path
        csp = r.headers["Content-Security-Policy"]
        assert f"frame-ancestors {TEAMS_ANCESTORS}" in csp, path
        # X-Frame-Options cannot express an allowlist; it must not be sent or
        # browsers that honor it would block the frame anyway.
        assert "X-Frame-Options" not in r.headers, path
        # Everything else about the app policy is unchanged.
        assert csp.startswith("default-src 'self'; script-src 'self'"), path

    api = c.get("/api/health")
    assert api.headers["Content-Security-Policy"] == "default-src 'none'; frame-ancestors 'none'"
    assert api.headers["X-Frame-Options"] == "DENY"


def test_frame_ancestors_whitespace_is_normalized(tmp_path, monkeypatch, built):
    c, _ = _fresh_app(tmp_path, monkeypatch, str(built),
                      frame_ancestors="  https://teams.microsoft.com\n https://*.office.com ")
    csp = c.get("/").headers["Content-Security-Policy"]
    assert csp.endswith("frame-ancestors https://teams.microsoft.com https://*.office.com")


def test_static_serving_does_not_leak_outside_root(tmp_path, monkeypatch, built):
    secret = built.parent / "secret.txt"
    secret.write_text("nope")
    c, _ = _fresh_app(tmp_path, monkeypatch, str(built))
    r = c.get("/../secret.txt")
    assert "nope" not in r.text


# ---------------------------------------------------------------------------
# Cache-Control: the deploy-visibility contract
# ---------------------------------------------------------------------------
#
# LIVE DEFECT 2026-08-12: no Cache-Control on anything, so browsers heuristic-
# cached index.html and a plain refresh after a deploy kept running the old
# bundle. The acceptance bar is the user's: a deployed change is there on a
# NORMAL refresh, with no hard refresh and no waiting.


def test_index_html_must_revalidate_on_every_load(tmp_path, monkeypatch, built):
    """index.html is the only unhashed document and it names the current
    bundle, so it can never be served from cache without asking."""
    c, _ = _fresh_app(tmp_path, monkeypatch, str(built))
    r = c.get("/")
    assert r.headers["Cache-Control"] == "no-cache"
    # A deep link boots the same document and needs the same treatment.
    assert c.get("/a/jobreq").headers["Cache-Control"] == "no-cache"


def test_unhashed_root_files_also_revalidate(tmp_path, monkeypatch, built):
    c, _ = _fresh_app(tmp_path, monkeypatch, str(built))
    assert c.get("/favicon.svg").headers["Cache-Control"] == "no-cache"


def test_hashed_assets_are_cached_forever(tmp_path, monkeypatch, built):
    """The filename carries the content hash, so these bytes can never change
    at this URL. Anything less than immutable is a needless round trip."""
    c, _ = _fresh_app(tmp_path, monkeypatch, str(built))
    r = c.get("/assets/index-abc123.js")
    assert r.status_code == 200
    assert r.headers["Cache-Control"] == "public, max-age=31536000, immutable"


def test_index_answers_304_when_the_browser_already_has_it(tmp_path, monkeypatch, built):
    """`no-cache` means "ask every load", so the ask has to be cheap. Starlette
    implements conditional requests in StaticFiles but NOT in FileResponse, so
    without explicit handling every page load re-downloads the document."""
    c, _ = _fresh_app(tmp_path, monkeypatch, str(built))
    first = c.get("/")
    etag = first.headers["etag"]
    again = c.get("/", headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert again.headers["Cache-Control"] == "no-cache"
    assert again.headers["etag"] == etag


def test_a_changed_index_breaks_the_etag_so_the_new_bundle_is_picked_up(
        tmp_path, monkeypatch, built):
    """The actual deploy scenario: the document changes, the old validator no
    longer matches, and the browser is handed the new one on a plain load."""
    c, _ = _fresh_app(tmp_path, monkeypatch, str(built))
    old_etag = c.get("/").headers["etag"]

    # A redeploy: index.html now points at a different hashed bundle.
    (built / "index.html").write_text(
        '<!doctype html><html><body><div id="root"></div>'
        '<script src="/assets/index-def456.js"></script></body></html>')

    fresh = c.get("/", headers={"If-None-Match": old_etag})
    assert fresh.status_code == 200, "a stale validator must not yield a 304"
    assert "index-def456.js" in fresh.text
    assert fresh.headers["etag"] != old_etag


def test_api_responses_carry_no_cache_control_of_their_own(tmp_path, monkeypatch, built):
    """The static rules must not leak onto the API surface."""
    c, _ = _fresh_app(tmp_path, monkeypatch, str(built))
    assert "Cache-Control" not in c.get("/api/health").headers
