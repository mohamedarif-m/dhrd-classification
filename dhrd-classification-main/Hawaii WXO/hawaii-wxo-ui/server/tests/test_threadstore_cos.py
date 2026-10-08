"""ThreadStore COS write-through. No network: httpx.MockTransport everywhere."""

import asyncio
import json
import logging
import threading
import time

import httpx
import pytest

from app.services.threadstore import (LANDED_TIMEOUT, CosBackend, ThreadStore,
                                      TokenBusy, cos_backend_from_settings)


class FakeCos:
    """Stands in for IAM + the COS object over a mock transport."""

    def __init__(self, initial: dict | None = None, fail_put: bool = False,
                 put_delay: float = 0.0) -> None:
        self.stored = initial
        self.puts: list[dict] = []
        self.gets = 0
        self.mints = 0
        self.fail_put = fail_put
        self.put_delay = put_delay  # stands in for a slow / contended COS

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/identity/token"):
            self.mints += 1
            assert b"apikey=" in request.content
            return httpx.Response(200, json={"access_token": "tok-1",
                                             "expires_in": 3600})
        assert request.headers["Authorization"] == "Bearer tok-1"
        if request.method == "GET":
            self.gets += 1
            if self.stored is None:
                return httpx.Response(404)
            return httpx.Response(200, json=self.stored)
        if request.method == "PUT":
            if self.put_delay:
                time.sleep(self.put_delay)
            if self.fail_put:
                return httpx.Response(500, text="boom")
            self.puts.append(json.loads(request.content))
            self.stored = self.puts[-1]
            return httpx.Response(200)
        return httpx.Response(405)


def _backend(fake: FakeCos) -> CosBackend:
    return CosBackend("secret-key", "https://s3.us-east.cloud-object-storage.appdomain.cloud",
                      "tko-bucket", "tko-agents-ui/threads.json",
                      transport=fake.transport())


def _wait_for(pred, timeout: float = 3.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.02)
    return pred()


def test_url_is_endpoint_bucket_object():
    b = CosBackend("k", "s3.us-east.cloud-object-storage.appdomain.cloud/",
                   "tko-bucket", "/tko-agents-ui/threads.json")
    assert b.url == ("https://s3.us-east.cloud-object-storage.appdomain.cloud"
                     "/tko-bucket/tko-agents-ui/threads.json")


def test_load_from_cos_on_init(tmp_path):
    remote = {"t-remote": {"owner": "aaaaaaaa-1", "agent_key": "jobreq",
                           "title": "From COS", "created_at": 1.0, "updated_at": 2.0}}
    fake = FakeCos(initial=remote)
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    assert fake.gets == 1
    assert store.owns("t-remote", "aaaaaaaa-1")
    assert [r["thread_id"] for r in store.list_for("aaaaaaaa-1")] == ["t-remote"]


def test_cos_load_beats_stale_local_file(tmp_path):
    (tmp_path / "threads.json").write_text(json.dumps(
        {"t-local": {"owner": "o", "agent_key": "jobreq", "title": "Local",
                     "created_at": 1.0, "updated_at": 1.0}}))
    fake = FakeCos(initial={"t-remote": {"owner": "o", "agent_key": "jobreq",
                                         "title": "Remote", "created_at": 1.0,
                                         "updated_at": 1.0}})
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    assert store.owns("t-remote", "o") and not store.owns("t-local", "o")


def test_missing_cos_object_falls_back_to_local(tmp_path):
    (tmp_path / "threads.json").write_text(json.dumps(
        {"t-local": {"owner": "o", "agent_key": "jobreq", "title": "Local",
                     "created_at": 1.0, "updated_at": 1.0}}))
    fake = FakeCos(initial=None)  # 404 from COS
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    assert store.owns("t-local", "o")


def test_record_puts_to_cos(tmp_path):
    fake = FakeCos(initial={})
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    store.record("t-1", "aaaaaaaa-1", "jobreq", "New req")
    assert _wait_for(lambda: len(fake.puts) == 1)
    assert fake.puts[0]["t-1"]["owner"] == "aaaaaaaa-1"
    assert fake.puts[0]["t-1"]["title"] == "New req"
    # Local file still written first.
    assert "t-1" in json.loads((tmp_path / "threads.json").read_text())

    store.rename("t-1", "Renamed")
    assert _wait_for(lambda: len(fake.puts) == 2)
    assert fake.puts[1]["t-1"]["title"] == "Renamed"
    # One IAM mint reused across calls.
    assert fake.mints == 1


def test_cos_put_failure_never_breaks_the_write(tmp_path):
    fake = FakeCos(initial={}, fail_put=True)
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    store.record("t-1", "aaaaaaaa-1", "jobreq", "New req")
    assert store.owns("t-1", "aaaaaaaa-1")
    # The local copy is written by the push worker, before the doomed PUT.
    assert _wait_for(lambda: (tmp_path / "threads.json").is_file())
    assert "t-1" in json.loads((tmp_path / "threads.json").read_text())


def test_cos_load_failure_never_raises(tmp_path):
    def boom(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="iam down")

    backend = CosBackend("k", "https://cos.example", "b", "o",
                         transport=httpx.MockTransport(boom))
    store = ThreadStore(str(tmp_path), cos=backend)
    assert store.list_for("anyone") == []


def test_backend_is_none_unless_all_vars_set(tmp_path, monkeypatch):
    import importlib

    import app.config as config

    for var in ("COS_API_KEY", "COS_ENDPOINT", "COS_BUCKET", "COS_OBJECT"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.delenv("TKO_ENV_FILE", raising=False)
    config = importlib.reload(config)
    assert config.settings.cos_configured is False
    assert cos_backend_from_settings(config.settings) is None

    monkeypatch.setenv("COS_API_KEY", "k")
    monkeypatch.setenv("COS_ENDPOINT", "https://cos.example")
    monkeypatch.setenv("COS_BUCKET", "b")
    config = importlib.reload(config)
    assert config.settings.cos_configured is True
    assert config.settings.cos_object == "tko-agents-ui/threads.json"
    backend = cos_backend_from_settings(config.settings)
    assert backend is not None
    assert backend.url == "https://cos.example/b/tko-agents-ui/threads.json"


def test_no_cos_configured_behaves_as_before(tmp_path):
    store = ThreadStore(str(tmp_path))
    store.record("t-1", "aaaaaaaa-1", "jobreq", "Plain")
    assert store.owns("t-1", "aaaaaaaa-1")
    assert json.loads((tmp_path / "threads.json").read_text())["t-1"]["title"] == "Plain"
    reopened = ThreadStore(str(tmp_path))
    assert reopened.owns("t-1", "aaaaaaaa-1")


# --------------------------------------------------------------- multi-instance


def _row(owner: str, title: str, updated: float, created: float = 1.0) -> dict:
    return {"owner": owner, "agent_key": "jobreq", "title": title,
            "created_at": created, "updated_at": updated}


def test_ownership_miss_reads_through_and_finds_the_thread(tmp_path):
    """Instance B does not know t-a; COS does (instance A wrote it)."""
    fake = FakeCos(initial={})
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    assert fake.gets == 1  # boot load
    fake.stored = {"t-a": _row("aaaaaaaa-1", "From instance A", 10.0)}

    assert store.owns("t-a", "aaaaaaaa-1") is True
    assert fake.gets == 2  # exactly one read-through
    assert store.refreshes == 1
    # Merged into memory: the listing sees it too. The listing spends one GET
    # of its own - the per-owner read-through has a separate budget from the
    # per-thread one, so the sidebar refreshes even after an ownership check.
    assert [r["thread_id"] for r in store.list_for("aaaaaaaa-1")] == ["t-a"]
    assert fake.gets == 3
    assert [r["thread_id"] for r in store.list_for("aaaaaaaa-1")] == ["t-a"]
    assert fake.gets == 3  # inside the owner window: no further read


def test_read_through_then_still_missing_reports_not_owned(tmp_path):
    fake = FakeCos(initial={"t-a": _row("aaaaaaaa-1", "A", 10.0)})
    store = ThreadStore(str(tmp_path), cos=_backend(fake))

    assert store.owns("t-nope", "aaaaaaaa-1") is False
    assert fake.gets == 2
    # Wrong owner is a miss too, and it is still a miss after the read-through.
    assert store.owns("t-a", "bbbbbbbb-2") is False


def test_read_through_is_throttled_per_thread_id(tmp_path):
    fake = FakeCos(initial={})
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    fake.gets = 0

    assert store.owns("t-x", "o") is False
    assert fake.gets == 1
    assert store.owns("t-x", "o") is False  # inside the window: no second read
    assert fake.gets == 1
    assert store.owns("t-y", "o") is False  # different id: its own budget
    assert fake.gets == 2

    store._refreshed_at["t-x"] = time.monotonic() - store.REFRESH_WINDOW - 0.1
    assert store.owns("t-x", "o") is False
    assert fake.gets == 3


def test_read_through_skipped_when_already_owned_locally(tmp_path):
    fake = FakeCos(initial={})
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    store.record("t-mine", "o", "jobreq", "Mine")
    fake.gets = 0
    assert store.owns("t-mine", "o") is True
    assert fake.gets == 0


def test_read_through_failure_is_a_plain_miss(tmp_path):
    def boom(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/identity/token"):
            return httpx.Response(200, json={"access_token": "tok-1",
                                             "expires_in": 3600})
        return httpx.Response(500, text="cos down")

    backend = CosBackend("k", "https://cos.example", "b", "o",
                         transport=httpx.MockTransport(boom))
    store = ThreadStore(str(tmp_path), cos=backend)
    assert store.owns("t-x", "o") is False


def test_merge_is_union_with_newest_wins():
    from app.services.threadstore import _merge

    local = {"only-local": _row("o", "L", 5.0),
             "both-local-newer": _row("o", "local wins", 9.0),
             "both-remote-newer": _row("o", "local loses", 3.0),
             "tie": _row("o", "local on tie", 7.0)}
    remote = {"only-remote": _row("o", "R", 5.0),
              "both-local-newer": _row("o", "remote loses", 4.0),
              "both-remote-newer": _row("o", "remote wins", 8.0),
              "tie": _row("o", "remote on tie", 7.0)}
    merged = _merge(local, remote)

    assert set(merged) == {"only-local", "only-remote", "both-local-newer",
                           "both-remote-newer", "tie"}
    assert merged["both-local-newer"]["title"] == "local wins"
    assert merged["both-remote-newer"]["title"] == "remote wins"
    assert merged["tie"]["title"] == "local on tie"
    assert merged["only-remote"]["title"] == "R"


def test_concurrent_instances_do_not_drop_each_others_rows(tmp_path):
    """Instance B's push re-reads and merges, so instance A's row survives."""
    fake = FakeCos(initial={})
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    # Instance A wrote t-a straight into COS while this process was idle.
    fake.stored = {"t-a": _row("aaaaaaaa-1", "From A", 10.0)}

    store.record("t-b", "bbbbbbbb-2", "jobreq", "From B")
    assert _wait_for(lambda: bool(fake.puts))
    written = fake.puts[-1]
    assert set(written) == {"t-a", "t-b"}
    # And this process learned about t-a from its own push.
    assert store.owns("t-a", "aaaaaaaa-1")


def test_conditional_write_retries_when_the_etag_moves(tmp_path):
    class EtagCos(FakeCos):
        def __init__(self) -> None:
            super().__init__(initial={})
            self.version = 1
            self.rejected = 0

        def handle(self, request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/identity/token"):
                return super().handle(request)
            if request.method == "GET":
                self.gets += 1
                return httpx.Response(200, json=self.stored,
                                      headers={"ETag": f'"v{self.version}"'})
            if request.method == "PUT":
                if request.headers.get("If-Match") != f'"v{self.version}"':
                    self.rejected += 1
                    return httpx.Response(412)
                if self.rejected == 0:
                    # First PUT: another instance slips in between read and write.
                    self.version += 1
                    self.stored = {"t-a": _row("aaaaaaaa-1", "From A", 10.0)}
                    self.rejected += 1
                    return httpx.Response(412)
                self.stored = json.loads(request.content)
                self.puts.append(self.stored)
                self.version += 1
                return httpx.Response(200)
            return httpx.Response(405)

    fake = EtagCos()
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    store.record("t-b", "bbbbbbbb-2", "jobreq", "From B")
    assert _wait_for(lambda: bool(fake.puts))
    assert set(fake.puts[-1]) == {"t-a", "t-b"}
    assert fake.rejected == 1


def test_missing_object_is_created_with_if_none_match(tmp_path):
    seen: list[dict] = []

    class AbsentCos(FakeCos):
        def handle(self, request: httpx.Request) -> httpx.Response:
            if request.method == "PUT":
                seen.append(dict(request.headers))
            return super().handle(request)

    fake = AbsentCos(initial=None)
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    store.record("t-1", "o", "jobreq", "First")
    assert _wait_for(lambda: bool(fake.puts))
    assert seen[0].get("if-none-match") == "*"


# --------------------------------------------------- off the event loop (item 2)


def _slow_backend(delay: float, stored: dict | None = None) -> CosBackend:
    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/identity/token"):
            return httpx.Response(200, json={"access_token": "tok-1",
                                             "expires_in": 3600})
        time.sleep(delay)
        if request.method == "GET":
            if stored is None:
                return httpx.Response(404)
            return httpx.Response(200, json=stored)
        return httpx.Response(200)

    return CosBackend("k", "https://cos.example", "b", "o",
                      transport=httpx.MockTransport(handle))


def test_own_or_404_is_a_coroutine_function():
    import asyncio as _asyncio

    from app.deps import own_or_404
    assert _asyncio.iscoroutinefunction(own_or_404)


@pytest.mark.asyncio
async def test_slow_cos_read_does_not_block_a_concurrent_handler(tmp_path):
    """The read-through runs on a worker thread, so another handler keeps
    making progress while COS is slow."""
    store = ThreadStore(str(tmp_path), cos=_slow_backend(0.4))
    ticks = 0

    async def other_handler():
        nonlocal ticks
        while not lookup.done():
            ticks += 1
            await asyncio.sleep(0.01)

    lookup = asyncio.ensure_future(asyncio.to_thread(store.owns, "t-x", "o"))
    await asyncio.gather(lookup, other_handler())

    assert lookup.result() is False
    # A blocked event loop would have produced ~0 ticks during the 0.4s read.
    assert ticks > 10, f"event loop only ticked {ticks} times"


def test_token_lock_wait_is_bounded_on_the_read_path(tmp_path):
    backend = _slow_backend(0.0)
    held = threading.Event()
    release = threading.Event()

    def hog():
        with backend._lock:
            held.set()
            release.wait(5.0)

    t = threading.Thread(target=hog, daemon=True)
    t.start()
    assert held.wait(2.0)
    try:
        started = time.monotonic()
        with pytest.raises(TokenBusy):
            backend.load_with_etag(timeout=0.1)
        assert time.monotonic() - started < 2.0
    finally:
        release.set()
        t.join(2.0)


def test_token_busy_on_refresh_is_a_plain_miss(tmp_path):
    backend = _slow_backend(0.0)
    store = ThreadStore(str(tmp_path), cos=backend)
    store.REFRESH_TIMEOUT = 0.05
    release = threading.Event()
    held = threading.Event()

    def hog():
        with backend._lock:
            held.set()
            release.wait(5.0)

    t = threading.Thread(target=hog, daemon=True)
    t.start()
    assert held.wait(2.0)
    try:
        assert store.owns("t-x", "o") is False  # no raise, just a miss
    finally:
        release.set()
        t.join(2.0)


# ------------------------------------------------------- push worker (item 3)


def _idle(store: ThreadStore) -> bool:
    with store._push_cv:
        return store._pending is None and store._pushes_in_flight == 0


def test_burst_of_records_lands_every_row_through_one_worker(tmp_path):
    class CountingCos(FakeCos):
        def __init__(self) -> None:
            super().__init__(initial={})
            self.concurrent = 0
            self.max_concurrent = 0

        def handle(self, request: httpx.Request) -> httpx.Response:
            if request.method == "PUT" and not request.url.path.endswith("token"):
                self.concurrent += 1
                self.max_concurrent = max(self.max_concurrent, self.concurrent)
                try:
                    time.sleep(0.01)
                    return super().handle(request)
                finally:
                    self.concurrent -= 1
            return super().handle(request)

    fake = CountingCos()
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    for i in range(8):
        store.record(f"t-{i}", "o", "jobreq", f"Thread {i}")

    assert _wait_for(lambda: _idle(store) and bool(fake.puts), timeout=10.0)
    assert set(fake.stored) == {f"t-{i}" for i in range(8)}
    # One worker: pushes never overlap, and coalescing keeps the count small.
    assert fake.max_concurrent == 1
    assert store.max_concurrent_pushes == 1
    assert len(fake.puts) <= 8
    assert threading.active_count() < 20


def test_push_worker_retries_a_5xx_then_succeeds(tmp_path):
    class FlakyCos(FakeCos):
        def __init__(self) -> None:
            super().__init__(initial={})
            self.failures = 0

        def handle(self, request: httpx.Request) -> httpx.Response:
            if request.method == "PUT" and self.failures < 2:
                self.failures += 1
                return httpx.Response(503, text="slow down")
            return super().handle(request)

    fake = FlakyCos()
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    store.record("t-1", "o", "jobreq", "Retried")

    assert _wait_for(lambda: bool(fake.puts), timeout=10.0)
    assert fake.failures == 2
    assert "t-1" in fake.stored
    assert store.pushes_landed == 1


def test_push_worker_gives_up_after_the_attempt_bound(tmp_path):
    fake = FakeCos(initial={}, fail_put=True)
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    store.PUSH_ATTEMPTS = 2
    store.record("t-1", "o", "jobreq", "Doomed")

    assert _wait_for(lambda: _idle(store), timeout=10.0)
    assert store.pushes_landed == 0
    # The row is still served locally: a failed mirror never loses the thread.
    assert store.owns("t-1", "o")


def test_a_newer_snapshot_supersedes_a_pending_one(tmp_path):
    fake = FakeCos(initial={})
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    # Queue a snapshot with no worker running, so the replacement is certain
    # to happen before anything can be pushed.
    with store._push_cv:
        store._pending = {"stale": _row("o", "stale", 1.0)}
    store.record("t-new", "o", "jobreq", "New")
    with store._push_cv:
        pending = store._pending
    assert pending is None or "t-new" in pending

    # And what actually reaches COS is the NEWER snapshot: the superseded one
    # is never pushed on its own, which would have written a map missing the
    # row the caller just recorded.
    assert _wait_for(lambda: _idle(store) and bool(fake.puts), timeout=10.0)
    assert all("t-new" in put for put in fake.puts)
    assert all("stale" not in put for put in fake.puts)
    assert "t-new" in fake.stored and "stale" not in fake.stored


# ----------------------------------------------------------- landed barrier


def test_the_barrier_is_set_once_the_row_has_been_pushed(tmp_path):
    fake = FakeCos(initial={}, put_delay=0.1)
    store = ThreadStore(str(tmp_path), cos=_backend(fake))

    landed = store.record("t-1", "o", "jobreq", "First")
    assert not landed.is_set()  # in memory, not yet shared
    assert landed.wait(10.0)
    # Set only AFTER a snapshot carrying the row actually reached COS.
    assert "t-1" in (fake.stored or {})
    assert store.pushes_landed == 1


def test_wait_landed_returns_true_once_the_push_lands(tmp_path):
    fake = FakeCos(initial={}, put_delay=0.1)
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    store.record("t-1", "o", "jobreq", "First")

    started = time.monotonic()
    assert store.wait_landed("t-1", timeout=10.0)
    assert time.monotonic() - started >= 0.05
    assert "t-1" in (fake.stored or {})


def test_wait_landed_on_an_unknown_id_returns_immediately(tmp_path):
    fake = FakeCos(initial={})
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    started = time.monotonic()
    # Never recorded here - and, once released, a landed row reads the same way.
    assert store.wait_landed("never-seen", timeout=5.0)
    assert time.monotonic() - started < 0.5
    store.record("t-1", "o", "jobreq", "First")
    assert store.wait_landed("t-1", timeout=10.0)
    assert store.landed("t-1") is None  # the map does not grow with landed rows
    assert store.wait_landed("t-1", timeout=5.0)


def test_barrier_is_already_set_without_cos(tmp_path):
    """No COS to wait for: the row is as shared as it is ever going to be."""
    store = ThreadStore(str(tmp_path))
    landed = store.record("t-1", "o", "jobreq", "First")
    assert landed.is_set()
    started = time.monotonic()
    assert store.wait_landed("t-1", timeout=5.0)
    assert time.monotonic() - started < 0.5


def test_a_burst_of_records_releases_every_barrier(tmp_path):
    """Coalescing must not strand a barrier: the snapshots that actually reach
    COS carry the ids of every snapshot they superseded."""
    fake = FakeCos(initial={}, put_delay=0.05)
    store = ThreadStore(str(tmp_path), cos=_backend(fake))

    events = [store.record(f"t-{i}", "o", "jobreq", f"Chat {i}") for i in range(12)]
    assert all(e.wait(15.0) for e in events)
    assert set(fake.stored) == {f"t-{i}" for i in range(12)}
    # Coalesced, not one push per row.
    assert len(fake.puts) < 12


def test_a_superseded_snapshot_hands_its_barriers_to_the_newer_one(tmp_path):
    fake = FakeCos(initial={})
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    barrier = store._barrier("t-1")
    # A newer snapshot is already queued, so this push must not happen at all.
    with store._push_cv:
        store._pending = {"t-2": _row("o", "Newer", 2.0)}

    store._push_with_retries({"t-1": _row("o", "Older", 1.0)}, {"t-1"})

    assert fake.puts == []
    assert not barrier.is_set()
    with store._push_cv:
        assert "t-1" in store._pending_ids  # carried over to the newer push


def test_exhausted_retries_release_the_barrier_with_a_warning(tmp_path, caplog):
    fake = FakeCos(initial={}, fail_put=True)
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    store.PUSH_ATTEMPTS = 2

    with caplog.at_level(logging.WARNING, logger="tko.threadstore"):
        landed = store.record("t-1", "o", "jobreq", "Doomed")
        # Released even though nothing landed: waiting forever is worse.
        assert landed.wait(10.0)
    assert store.pushes_landed == 0
    assert any("landed barrier released unlanded" in r.message
               for r in caplog.records)
    assert store.owns("t-1", "o")  # and the row is still served locally


def _chat_app(store, monkeypatch, frames):
    """A live-mode /api/chat wired to `store` and a scripted upstream stream.

    The app modules are purged and re-imported the way test_api.py does it, so
    the route under test and the module globals patched here are the same
    objects.
    """
    import importlib
    import sys

    from fastapi.testclient import TestClient

    for mod in [m for m in list(sys.modules) if m.startswith("app")]:
        del sys.modules[mod]
    main = importlib.import_module("app.main")
    chat = importlib.import_module("app.routes.chat")
    deps = importlib.import_module("app.deps")

    class FakeWxo:
        async def stream_run(self, payload):
            for frame in frames:
                yield json.dumps(frame)

    monkeypatch.setattr(chat, "store", store)
    monkeypatch.setattr(deps, "store", store)  # own_or_404 reads the deps one
    monkeypatch.setattr(chat, "require_live", lambda: FakeWxo())

    async def _agent_id(key):
        return "agent-1"

    monkeypatch.setattr(chat, "agent_id_for", _agent_id)
    return TestClient(main.app)


_STARTED = {"id": "e1", "event": "run.started",
            "data": {"run_id": "r-1", "thread_id": "t-new"}}
_DONE = {"id": "e2", "event": "run.completed", "data": {}}


def _first_frame(client) -> tuple[str, float]:
    """POST a new chat and return (first SSE event line, seconds to get it)."""
    started = time.monotonic()
    with client.stream("POST", "/api/chat",
                       headers={"X-TKO-Client": "aaaaaaaa-1"},
                       json={"agent_key": "jobreq", "content": "hello"}) as r:
        assert r.status_code == 200
        for line in r.iter_lines():
            if line.startswith("event:"):
                return line, time.monotonic() - started
    raise AssertionError("no event frame")


def test_chat_holds_run_started_until_the_row_lands(tmp_path, monkeypatch):
    """The browser refreshes its sidebar the moment it reads this frame, and
    that GET may be served by another instance - so the row must be in COS
    before the frame goes out."""
    fake = FakeCos(initial={}, put_delay=0.4)
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    client = _chat_app(store, monkeypatch, [_STARTED, _DONE])

    line, elapsed = _first_frame(client)

    assert line == "event: run.started"
    assert "t-new" in (fake.stored or {})  # landed BEFORE the frame was yielded
    assert elapsed >= 0.4


def test_chat_yields_anyway_when_the_row_will_not_land(tmp_path, monkeypatch,
                                                       caplog):
    """A sick COS delays the first frame by the timeout and no more."""
    fake = FakeCos(initial={}, fail_put=True)
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    store.PUSH_ATTEMPTS = 1
    client = _chat_app(store, monkeypatch, [_STARTED, _DONE])

    with caplog.at_level(logging.WARNING):
        line, elapsed = _first_frame(client)

    assert line == "event: run.started"
    assert elapsed < LANDED_TIMEOUT + 2.0
    assert fake.stored == {}  # nothing landed; the reply went out regardless


def test_first_turn_latency_with_a_healthy_cos(tmp_path, monkeypatch, capsys):
    """What the barrier actually costs on the first turn of a new conversation:
    one COS round trip (a GET and a PUT over the fake transport here)."""
    fake = FakeCos(initial={})
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    client = _chat_app(store, monkeypatch, [_STARTED, _DONE])

    _line, elapsed = _first_frame(client)
    with capsys.disabled():
        print(f"\n  first-turn barrier cost (fake transport): {elapsed * 1000:.1f} ms")
    assert elapsed < 1.0
    assert "t-new" in (fake.stored or {})


def test_follow_up_turns_do_not_wait(tmp_path, monkeypatch):
    """Only a NEW thread pays the barrier; an existing thread_id skips it."""
    fake = FakeCos(initial={}, put_delay=0.5)
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    store.record("t-new", "aaaaaaaa-1", "jobreq", "First")
    assert store.wait_landed("t-new", timeout=10.0)
    fake.put_delay = 2.0
    client = _chat_app(store, monkeypatch, [_STARTED, _DONE])

    started = time.monotonic()
    with client.stream("POST", "/api/chat",
                       headers={"X-TKO-Client": "aaaaaaaa-1"},
                       json={"agent_key": "jobreq", "content": "again",
                             "thread_id": "t-new"}) as r:
        assert r.status_code == 200
        line = next(ln for ln in r.iter_lines() if ln.startswith("event:"))
    assert line == "event: run.started"
    assert time.monotonic() - started < 1.0


def test_landed_timeout_is_a_ceiling_not_a_budget():
    """Documented constant: several times a contended COS round trip, and the
    caller carries on when it expires."""
    assert 1.0 <= LANDED_TIMEOUT <= 10.0


# ------------------------------------------------------- robustness (item 4)


def test_merge_skips_rows_with_an_unparseable_updated_at():
    from app.services.threadstore import _merge

    local = {"t-a": _row("o", "good local", 5.0)}
    remote = {"t-a": {"owner": "o", "agent_key": "jobreq", "title": "bad",
                      "created_at": 1.0, "updated_at": "not-a-number"},
              "t-b": {"owner": "o", "agent_key": "jobreq", "title": "undated",
                      "created_at": 1.0, "updated_at": None},
              "t-c": "not-a-dict",
              "t-d": {"agent_key": "jobreq", "title": "no owner",
                      "created_at": 1.0, "updated_at": 9.0},
              "t-e": _row("o", "fine", 9.0)}
    merged = _merge(local, remote)

    assert merged["t-a"]["title"] == "good local"          # bad remote skipped
    assert merged["t-b"]["title"] == "undated"             # null date is not malformed
    assert "t-c" not in merged and "t-d" not in merged     # not-a-dict, no owner
    assert merged["t-e"]["title"] == "fine"


def test_a_malformed_remote_row_cannot_break_the_miss_path(tmp_path):
    fake = FakeCos(initial={"t-bad": {"owner": "o", "updated_at": "junk"}})
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    assert store.owns("t-x", "o") is False  # no exception
    assert store.owns("t-bad", "o") is False


def test_remote_never_rewrites_a_local_owner():
    from app.services.threadstore import _merge

    local = {"t-a": _row("aaaaaaaa-1", "mine", 1.0)}
    remote = {"t-a": _row("bbbbbbbb-2", "theirs", 99.0)}
    merged = _merge(local, remote)
    assert merged["t-a"]["owner"] == "aaaaaaaa-1"
    assert merged["t-a"]["title"] == "mine"


def test_miss_throttle_window_is_short_enough_to_re_send():
    assert ThreadStore.REFRESH_WINDOW == 2.0


# ------------------------------------------------------------ retention


def _aged(days_ago: float, owner: str = "o", title: str = "Aged") -> dict:
    when = time.time() - days_ago * 86400.0
    return {"owner": owner, "agent_key": "jobreq", "title": title,
            "created_at": when, "updated_at": when}


def test_expired_rows_are_dropped_at_boot(tmp_path):
    fake = FakeCos(initial={"t-old": _aged(45), "t-new": _aged(2)})
    store = ThreadStore(str(tmp_path), cos=_backend(fake), retention_days=30)
    assert [r["thread_id"] for r in store.list_for("o")] == ["t-new"]
    assert store.owns("t-old", "o") is False


def test_expired_rows_are_dropped_from_the_local_file_at_boot(tmp_path):
    (tmp_path / "threads.json").write_text(json.dumps(
        {"t-old": _aged(45), "t-new": _aged(1)}))
    store = ThreadStore(str(tmp_path), retention_days=30)
    assert [r["thread_id"] for r in store.list_for("o")] == ["t-new"]


def test_expired_remote_rows_are_dropped_on_merge(tmp_path):
    fake = FakeCos(initial={})
    store = ThreadStore(str(tmp_path), cos=_backend(fake), retention_days=30)
    fake.stored = {"t-old": _aged(60), "t-fresh": _aged(0.5)}

    assert store.owns("t-old", "o") is False   # read-through, then expired out
    assert store.owns("t-fresh", "o") is True


def test_expired_rows_are_dropped_before_the_put(tmp_path):
    fake = FakeCos(initial={"t-old": _aged(99)})
    store = ThreadStore(str(tmp_path), cos=_backend(fake), retention_days=30)
    store.record("t-1", "o", "jobreq", "Fresh")
    assert _wait_for(lambda: bool(fake.puts))
    assert set(fake.puts[-1]) == {"t-1"}
    # A row inside the window is never touched by expiry.
    assert fake.puts[-1]["t-1"]["title"] == "Fresh"


def test_retention_zero_keeps_everything(tmp_path):
    fake = FakeCos(initial={"t-ancient": _aged(4000)})
    store = ThreadStore(str(tmp_path), cos=_backend(fake), retention_days=0)
    assert store.owns("t-ancient", "o") is True
    store.record("t-1", "o", "jobreq", "Fresh")
    assert _wait_for(lambda: bool(fake.puts))
    assert set(fake.puts[-1]) == {"t-ancient", "t-1"}


def test_expire_falls_back_to_created_at_and_keeps_undatable_rows():
    from app.services.threadstore import expire

    now = time.time()
    rows = {"no-updated": {"owner": "o", "created_at": now - 90 * 86400.0,
                           "updated_at": None},
            "no-updated-fresh": {"owner": "o", "created_at": now - 60.0,
                                 "updated_at": None},
            "undatable": {"owner": "o", "title": "no timestamps at all"},
            "junk": {"owner": "o", "updated_at": "not-a-number"}}
    kept = expire(rows, now, 30)
    assert set(kept) == {"no-updated-fresh", "undatable", "junk"}


def test_retention_default_is_thirty_days(monkeypatch):
    import importlib

    import app.config as config
    monkeypatch.delenv("THREAD_RETENTION_DAYS", raising=False)
    monkeypatch.delenv("TKO_ENV_FILE", raising=False)
    assert importlib.reload(config).settings.thread_retention_days == 30.0


# --------------------------------------------------- sidebar read-through


def test_listing_reads_through_to_find_another_instances_thread(tmp_path):
    fake = FakeCos(initial={})
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    fake.gets = 0
    # Instance A created the thread straight into COS.
    fake.stored = {"t-a": _row("aaaaaaaa-1", "From A", time.time())}

    rows = store.list_for("aaaaaaaa-1")
    assert [r["thread_id"] for r in rows] == ["t-a"]
    assert fake.gets == 1
    # Inside the per-owner window a second listing costs nothing.
    assert len(store.list_for("aaaaaaaa-1")) == 1
    assert fake.gets == 1
    # A different owner has its own budget.
    store.list_for("bbbbbbbb-2")
    assert fake.gets == 2


def test_listing_read_through_failure_degrades_to_the_local_list(tmp_path):
    class BrokenGetCos(FakeCos):
        def handle(self, request: httpx.Request) -> httpx.Response:
            if request.method == "GET" and not request.url.path.endswith("token"):
                self.gets += 1
                return httpx.Response(500, text="cos down")
            return super().handle(request)

    fake = BrokenGetCos(initial={})
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    store.record("t-mine", "o", "jobreq", "Mine")
    assert [r["thread_id"] for r in store.list_for("o")] == ["t-mine"]


def test_list_route_is_a_coroutine_function():
    from app.routes.threads import list_threads
    assert asyncio.iscoroutinefunction(list_threads)


# ------------------------------------------------------------ shutdown flush


def test_flush_waits_for_the_pending_push(tmp_path):
    class SlowPutCos(FakeCos):
        def handle(self, request: httpx.Request) -> httpx.Response:
            if request.method == "PUT":
                time.sleep(0.15)
            return super().handle(request)

    fake = SlowPutCos(initial={})
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    store.record("t-1", "o", "jobreq", "Last gasp")
    assert store.flush(timeout=5.0) is True
    assert fake.stored is not None and "t-1" in fake.stored


def test_flush_is_a_no_op_without_cos(tmp_path):
    assert ThreadStore(str(tmp_path)).flush(timeout=0.01) is True


def test_flush_returns_false_when_the_queue_will_not_drain(tmp_path):
    fake = FakeCos(initial={}, fail_put=True)
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    store.record("t-1", "o", "jobreq", "Doomed")
    assert store.flush(timeout=0.05) is False


# ------------------------------------------------------------ hot path


def test_record_does_not_touch_the_filesystem_synchronously(tmp_path):
    fake = FakeCos(initial={})
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    calls: list[str] = []
    real = store._write_local

    def spy(snapshot: dict) -> None:
        calls.append(threading.current_thread().name)
        real(snapshot)

    store._write_local = spy  # type: ignore[method-assign]
    caller = threading.current_thread().name
    store.record("t-1", "o", "jobreq", "Hot")
    assert calls == []  # nothing written on the request path

    assert _wait_for(lambda: bool(calls))
    assert calls[0] != caller
    assert calls[0] == "cos-threadstore-push"
    assert "t-1" in json.loads((tmp_path / "threads.json").read_text())


def test_rows_are_replaced_not_mutated(tmp_path):
    store = ThreadStore(str(tmp_path))
    store.record("t-1", "o", "jobreq", "First")
    held = store._threads["t-1"]
    store.record("t-1", "o", "jobreq", "")
    store.rename("t-1", "Renamed")
    # The snapshot taken before the updates is unchanged: a pending push
    # carrying it can never be rewritten underneath the worker.
    assert held["title"] == "First"
    assert held["updated_at"] != store._threads["t-1"]["updated_at"]
    assert store._threads["t-1"]["title"] == "Renamed"


# ------------------------------------------------- read-path failure handling


def test_a_failed_read_through_does_not_burn_the_window(tmp_path):
    """One COS blip must not answer two 404s: the immediate re-send re-reads."""

    class FlakyGetCos(FakeCos):
        def __init__(self) -> None:
            super().__init__(initial={})
            self.fail_next = False

        def handle(self, request: httpx.Request) -> httpx.Response:
            if (request.method == "GET" and self.fail_next
                    and not request.url.path.endswith("token")):
                self.fail_next = False
                self.gets += 1
                return httpx.Response(500, text="blip")
            return super().handle(request)

    fake = FlakyGetCos()
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    fake.gets = 0
    fake.fail_next = True

    assert store.owns("t-a", "o") is False   # the blip: a plain miss
    assert fake.gets == 1
    fake.stored = {"t-a": _row("o", "From A", time.time())}
    assert store.owns("t-a", "o") is True    # re-sent immediately: reads again
    assert fake.gets == 2


def test_a_failed_owner_read_through_does_not_burn_the_window(tmp_path):
    class FlakyGetCos(FakeCos):
        def __init__(self) -> None:
            super().__init__(initial={})
            self.fail_next = False

        def handle(self, request: httpx.Request) -> httpx.Response:
            if (request.method == "GET" and self.fail_next
                    and not request.url.path.endswith("token")):
                self.fail_next = False
                self.gets += 1
                return httpx.Response(500, text="blip")
            return super().handle(request)

    fake = FlakyGetCos()
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    fake.gets = 0
    fake.fail_next = True

    assert store.list_for("o") == []
    assert fake.gets == 1
    fake.stored = {"t-a": _row("o", "From A", time.time())}
    assert [r["thread_id"] for r in store.list_for("o")] == ["t-a"]
    assert fake.gets == 2


def test_refresh_lock_wait_is_bounded(tmp_path):
    store = ThreadStore(str(tmp_path), cos=_slow_backend(0.0))
    store.REFRESH_TIMEOUT = 0.05
    release = threading.Event()
    held = threading.Event()

    def hog():
        with store._refresh_lock:
            held.set()
            release.wait(5.0)

    t = threading.Thread(target=hog, daemon=True)
    t.start()
    assert held.wait(2.0)
    try:
        started = time.monotonic()
        assert store.owns("t-x", "o") is False  # a plain miss, promptly
        assert time.monotonic() - started < 2.0
    finally:
        release.set()
        t.join(2.0)


# ------------------------------------------------------------ push worker


def test_conditional_header_rejection_latches_to_unconditional_writes(tmp_path):
    class NoConditionalsCos(FakeCos):
        def __init__(self) -> None:
            super().__init__(initial={})
            self.rejected = 0

        def handle(self, request: httpx.Request) -> httpx.Response:
            if request.method == "GET" and not request.url.path.endswith("token"):
                self.gets += 1
                return httpx.Response(200, json=self.stored,
                                      headers={"ETag": '"v1"'})
            if request.method == "PUT" and (request.headers.get("If-Match")
                                            or request.headers.get("If-None-Match")):
                self.rejected += 1
                return httpx.Response(400, text="not supported")
            return super().handle(request)

    fake = NoConditionalsCos()
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    store.record("t-1", "o", "jobreq", "First")
    assert _wait_for(lambda: bool(fake.puts))
    assert fake.rejected == 1
    assert store._conditional_writes is False
    assert "t-1" in fake.stored

    # Latched: the next push sends no conditional header at all.
    store.record("t-2", "o", "jobreq", "Second")
    assert _wait_for(lambda: len(fake.puts) == 2)
    assert fake.rejected == 1
    assert set(fake.stored) == {"t-1", "t-2"}


def test_a_failed_pre_read_never_writes(tmp_path):
    """A GET failure is not an absent object. Writing the local snapshot alone
    would delete every row only the other instance holds."""

    class ReadBrokenCos(FakeCos):
        def handle(self, request: httpx.Request) -> httpx.Response:
            if request.method == "GET" and not request.url.path.endswith("token"):
                self.gets += 1
                return httpx.Response(500, text="cos down")
            return super().handle(request)

    fake = ReadBrokenCos(initial={})
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    store.PUSH_ATTEMPTS = 2
    store._conditional_writes = False  # the dangerous state: no If-Match guard
    store.record("t-1", "o", "jobreq", "Local only")

    assert _wait_for(lambda: _idle(store), timeout=10.0)
    assert fake.puts == []
    assert store.pushes_landed == 0
    assert store.owns("t-1", "o")  # still served locally


def test_idle_worker_exits_and_a_later_record_starts_a_new_one(tmp_path):
    fake = FakeCos(initial={})
    store = ThreadStore(str(tmp_path), cos=_backend(fake))
    store.IDLE_TIMEOUT = 0.05
    store.record("t-1", "o", "jobreq", "First")
    assert _wait_for(lambda: bool(fake.puts))

    first = store._worker
    assert _wait_for(lambda: store._worker is None, timeout=3.0)
    assert first is not None and _wait_for(lambda: not first.is_alive())

    store.record("t-2", "o", "jobreq", "Second")
    assert _wait_for(lambda: len(fake.puts) == 2)
    assert store._worker is not None and store._worker is not first
    assert set(fake.stored) == {"t-1", "t-2"}


def test_app_shutdown_flushes_the_thread_store(tmp_path, monkeypatch):
    """The lifespan teardown drains the push queue before the process goes."""
    import importlib
    import sys

    from fastapi.testclient import TestClient

    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.delenv("TKO_ENV_FILE", raising=False)
    for mod in [m for m in list(sys.modules) if m.startswith("app")]:
        del sys.modules[mod]
    main = importlib.import_module("app.main")
    deps = importlib.import_module("app.deps")

    flushed: list[bool] = []
    monkeypatch.setattr(deps.store, "flush",
                        lambda *a, **k: flushed.append(True) or True)
    with TestClient(main.app):
        assert flushed == []
    assert flushed == [True]


# ------------------------------------------------- maintenance script (admin)


def _admin():
    """The maintenance script, loaded from scripts/ (not an importable pkg)."""
    import importlib.util
    from pathlib import Path

    path = Path(__file__).resolve().parent.parent / "scripts" / "threads_admin.py"
    spec = importlib.util.spec_from_file_location("threads_admin", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def test_admin_filter_rows_by_age_and_owner_prefix():
    admin = _admin()
    now = time.time()
    rows = {"old": _aged(40), "fresh": _aged(1),
            "e2e-old": _aged(40, owner="e2e-abc"),
            "e2e-fresh": _aged(1, owner="e2e-abc"),
            "undated": {"owner": "o", "title": "no timestamps"}}

    by_age = admin.filter_rows(rows, now, older_than=14)
    assert set(by_age) == {"fresh", "e2e-fresh", "undated"}

    by_owner = admin.filter_rows(rows, now, owner_prefix="e2e-")
    assert set(by_owner) == {"old", "fresh", "undated"}

    both = admin.filter_rows(rows, now, older_than=14, owner_prefix="e2e-")
    assert set(both) == {"fresh", "undated"}

    assert admin.filter_rows(rows, now) == rows  # no filter, no removals


def test_admin_stats_counts_without_reading_row_content():
    admin = _admin()
    now = time.time()
    rows = {"a": _aged(0.2), "b": _aged(3), "c": _aged(20),
            "d": _aged(45, owner="other"), "e": _aged(200),
            "f": {"owner": "o", "title": "undated"}}
    s = admin.summarize(rows, now)

    assert s["rows"] == 6 and s["owners"] == 2 and s["bytes"] > 0
    assert s["ages"] == {"under 1 day": 1, "1-7 days": 1, "7-30 days": 1,
                         "30-90 days": 1, "over 90 days": 1, "undated": 1}
    dumped = json.dumps(s)
    assert "undated" in dumped  # bucket label, not the row title
    assert "other" not in dumped and "jobreq" not in dumped


def test_admin_dry_run_never_writes(tmp_path):
    admin = _admin()
    fake = FakeCos(initial={"old": _aged(40), "fresh": _aged(1)})
    removed = admin.apply_change(
        _backend(fake), lambda rows: admin.filter_rows(rows, time.time(), 14),
        apply=False)
    assert removed == 0
    assert fake.puts == [] and set(fake.stored) == {"old", "fresh"}


def test_admin_apply_writes_the_filtered_index(tmp_path):
    admin = _admin()
    fake = FakeCos(initial={"old": _aged(40), "fresh": _aged(1),
                            "e2e": _aged(1, owner="e2e-abc")})
    removed = admin.apply_change(
        _backend(fake),
        lambda rows: admin.filter_rows(rows, time.time(), 14, "e2e-"),
        apply=True)
    assert removed == 2
    assert set(fake.stored) == {"fresh"}


def test_admin_clear_writes_an_empty_index(tmp_path):
    admin = _admin()
    fake = FakeCos(initial={"a": _aged(1), "b": _aged(2)})
    assert admin.apply_change(_backend(fake), lambda rows: {}, apply=True) == 2
    assert fake.stored == {}


def test_admin_retries_when_the_etag_moves(tmp_path):
    admin = _admin()

    class EtagCos(FakeCos):
        def __init__(self) -> None:
            super().__init__(initial={"old": _aged(40), "fresh": _aged(1)})
            self.version = 1
            self.rejected = 0

        def handle(self, request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/identity/token"):
                return super().handle(request)
            if request.method == "GET":
                self.gets += 1
                return httpx.Response(200, json=self.stored,
                                      headers={"ETag": f'"v{self.version}"'})
            if request.method == "PUT":
                if self.rejected == 0:
                    # Another writer lands between our read and our write.
                    self.rejected += 1
                    self.version += 1
                    self.stored = dict(self.stored, other=_aged(1))
                    return httpx.Response(412)
                if request.headers.get("If-Match") != f'"v{self.version}"':
                    return httpx.Response(412)
                self.stored = json.loads(request.content)
                self.puts.append(self.stored)
                return httpx.Response(200)
            return httpx.Response(405)

    fake = EtagCos()
    removed = admin.apply_change(
        _backend(fake), lambda rows: admin.filter_rows(rows, time.time(), 14),
        apply=True)
    assert fake.rejected == 1
    assert removed == 1
    # The re-read picked up the row the other writer added; only "old" went.
    assert set(fake.stored) == {"fresh", "other"}


def test_admin_cli_requires_a_filter_and_an_acknowledgement(monkeypatch, tmp_path):
    admin = _admin()
    monkeypatch.setenv("COS_API_KEY", "k")
    monkeypatch.setenv("COS_ENDPOINT", "https://cos.example")
    monkeypatch.setenv("COS_BUCKET", "b")
    fake = FakeCos(initial={})
    monkeypatch.setattr(admin, "backend_from_env", lambda obj=None: _backend(fake))

    with pytest.raises(SystemExit):
        admin.main(["prune"])           # neither --older-than nor --owner-prefix
    with pytest.raises(SystemExit):
        admin.main(["clear"])           # no --yes
    assert fake.puts == []
    assert admin.main(["stats"]) == 0


def test_admin_object_override_targets_a_named_object(monkeypatch):
    admin = _admin()
    monkeypatch.setenv("COS_API_KEY", "k")
    monkeypatch.setenv("COS_ENDPOINT", "https://cos.example")
    monkeypatch.setenv("COS_BUCKET", "b")
    monkeypatch.setenv("COS_OBJECT", "prod/threads.json")
    assert admin.backend_from_env().url.endswith("/b/prod/threads.json")
    assert admin.backend_from_env(
        "tko-agents-ui-staging/threads.json").url.endswith(
            "/b/tko-agents-ui-staging/threads.json")

    monkeypatch.delenv("COS_BUCKET")
    with pytest.raises(SystemExit):
        admin.backend_from_env()
