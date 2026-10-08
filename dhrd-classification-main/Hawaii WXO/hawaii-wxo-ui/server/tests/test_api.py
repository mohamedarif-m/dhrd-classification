"""Endpoint-level checks with the app unconfigured (no upstream calls)."""

import importlib
import sys

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.delenv("WO_INSTANCE", raising=False)
    monkeypatch.delenv("WO_API_KEY", raising=False)
    monkeypatch.delenv("TKO_ENV_FILE", raising=False)
    for mod in [m for m in list(sys.modules) if m.startswith("app")]:
        del sys.modules[mod]
    main = importlib.import_module("app.main")
    # The runtime singletons live in app.deps; import it after app.main so both
    # see the same freshly built instances.
    return TestClient(main.app), importlib.import_module("app.deps")


def test_registry_is_sanitized_and_reports_mode(client):
    c, _ = client
    body = c.get("/api/registry").json()
    assert body["mode"] == "unconfigured"
    import json
    dumped = json.dumps(body)
    assert "wxo_agent_name" not in dumped and "JobReq_C" not in dumped


def test_identity_header_is_required(client):
    c, _ = client
    assert c.get("/api/threads").status_code == 400
    assert c.get("/api/threads", headers={"X-TKO-Client": "x"}).status_code == 400


def test_thread_listing_scoped_per_identity(client):
    c, deps = client
    deps.store.record("t-a", "aaaaaaaa-1", "jobreq", "Mine")
    deps.store.record("t-b", "bbbbbbbb-2", "jobreq", "Theirs")
    mine = c.get("/api/threads", headers={"X-TKO-Client": "aaaaaaaa-1"}).json()
    assert [t["thread_id"] for t in mine["threads"]] == ["t-a"]


def test_foreign_thread_messages_404(client):
    c, deps = client
    deps.store.record("t-b", "bbbbbbbb-2", "jobreq", "Theirs")
    r = c.get("/api/threads/t-b/messages", headers={"X-TKO-Client": "aaaaaaaa-1"})
    assert r.status_code == 404


def test_chat_unconfigured_is_503(client):
    c, _ = client
    r = c.post("/api/chat", headers={"X-TKO-Client": "aaaaaaaa-1"},
               json={"agent_key": "jobreq", "content": "hello"})
    assert r.status_code == 503


# ---- rate limiting: per-identity keying and the separate options bucket ----


@pytest.fixture()
def limited(tmp_path, monkeypatch):
    """Same app, with tiny limits so the windows are cheap to fill."""
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("RATE_LIMIT_PER_MIN", "3")
    monkeypatch.setenv("OPTIONS_RATE_LIMIT_PER_MIN", "6")
    monkeypatch.delenv("WO_INSTANCE", raising=False)
    monkeypatch.delenv("WO_API_KEY", raising=False)
    monkeypatch.delenv("TKO_ENV_FILE", raising=False)
    for mod in [m for m in list(sys.modules) if m.startswith("app")]:
        del sys.modules[mod]
    main = importlib.import_module("app.main")
    return TestClient(main.app), main


def _codes(c, path, headers, n, **kw):
    return [c.get(path, headers=headers, **kw).status_code for _ in range(n)]


def test_limit_is_per_identity_not_per_source_ip(limited):
    c, _ = limited
    a = {"X-TKO-Client": "aaaaaaaa-1"}
    b = {"X-TKO-Client": "bbbbbbbb-2"}
    # Behind Code Engine both callers share one IP; one must not spend the
    # other's budget.
    assert _codes(c, "/api/registry", a, 4) == [200, 200, 200, 429]
    assert _codes(c, "/api/registry", b, 3) == [200, 200, 200]


def test_requests_without_an_identity_fall_back_to_the_peer_address(limited):
    c, _ = limited
    assert _codes(c, "/api/registry", {}, 4) == [200, 200, 200, 429]
    # A malformed identity is not a key either; it lands in the same host bucket.
    assert c.get("/api/registry", headers={"X-TKO-Client": "x"}).status_code == 429


def test_options_has_its_own_larger_bucket(limited):
    c, _ = limited
    hdr = {"X-TKO-Client": "aaaaaaaa-1"}
    params = {"agent_key": "jobreq", "source": "job-profiles"}
    # 503 = past the limiter, into the unconfigured route. Six get through on
    # the options bucket, where the global bucket would have stopped at three.
    assert _codes(c, "/api/options", hdr, 6, params=params) == [503] * 6
    assert c.get("/api/options", headers=hdr, params=params).status_code == 429
    # ...and the options traffic never touched the global window.
    assert c.get("/api/registry", headers=hdr).status_code == 200


def test_429_carries_a_retry_after(limited):
    c, _ = limited
    hdr = {"X-TKO-Client": "aaaaaaaa-1"}
    _codes(c, "/api/registry", hdr, 3)
    r = c.get("/api/registry", headers=hdr)
    assert r.status_code == 429
    assert 1 <= int(r.headers["Retry-After"]) <= 61
