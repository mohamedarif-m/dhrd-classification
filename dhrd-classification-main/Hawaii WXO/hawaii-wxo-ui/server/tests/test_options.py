"""Options side channel: run_to_completion, the fetch/cache service, and the
endpoint allowlist. No network - the upstream client is faked throughout."""

import asyncio
import importlib
import json
import sys

import httpx
import pytest
from fastapi.testclient import TestClient

from app.services.optionsvc import OPTIONS_META_KEY, OptionsService
from app.services.wxo import WxoClient


REG = {"agents": [
    {"key": "jobreq", "wxo_agent_name": "JobReq_C", "name": "Job Requisition",
     "option_sources": {"job-profiles": {"ttl_s": 43200}}},
    {"key": "plain", "wxo_agent_name": "Plain_C", "name": "Plain"},
]}


# ---- run_to_completion ----


class StreamOnly:
    """Only the transport is faked; run_to_completion is the real method."""

    def __init__(self, lines, statuses=None, die=False):
        self.lines = lines
        self.statuses = list(statuses or [])
        self.die = die
        self.status_calls = 0

    async def stream_run(self, payload):
        for line in self.lines:
            yield line
        if self.die:
            raise httpx.ReadError("stream died")

    async def run_status(self, run_id):
        self.status_calls += 1
        return self.statuses.pop(0) if self.statuses else {"status": "in_progress"}

    run_to_completion = WxoClient.run_to_completion


def _ev(event, **data):
    return json.dumps({"event": event, "data": data})


def test_run_to_completion_takes_terminal_from_the_stream():
    client = StreamOnly([
        "",
        "not json",
        _ev("run.started", run_id="r1", thread_id="t1"),
        "data: " + _ev("message.created", run_id="r1", thread_id="t1"),
        _ev("run.completed", run_id="r1"),
        _ev("done"),
    ])
    out = asyncio.run(client.run_to_completion({"message": {}}))
    assert out == {"run_id": "r1", "thread_id": "t1", "status": "completed"}
    assert client.status_calls == 0


def test_run_to_completion_polls_when_the_stream_dies(monkeypatch):
    # Live behavior: streams break at 20-60s while the run keeps going.
    client = StreamOnly([_ev("run.started", run_id="r2", thread_id="t2")],
                        statuses=[{"status": "in_progress"},
                                  {"status": "completed", "thread_id": "t2"}],
                        die=True)
    monkeypatch.setattr(asyncio, "sleep", _no_sleep)
    out = asyncio.run(client.run_to_completion({"message": {}}))
    assert out == {"run_id": "r2", "thread_id": "t2", "status": "completed"}
    assert client.status_calls == 2


def test_run_to_completion_times_out_without_a_terminal(monkeypatch):
    client = StreamOnly([_ev("run.started", run_id="r3", thread_id="t3")], die=True)
    monkeypatch.setattr(asyncio, "sleep", _no_sleep)
    out = asyncio.run(client.run_to_completion({"message": {}}, timeout_s=0))
    assert out["status"] == "timeout" and out["run_id"] == "r3"


async def _no_sleep(_delay, *a, **kw):
    return None


# ---- OptionsService ----


PAGES = {
    ("job-profiles", 1): {"source": "job-profiles", "page": 1, "pages": 2,
                          "total": 3, "rows": [{"key": "a", "cells": ["A"]},
                                               {"key": "b", "cells": ["B"]}]},
    ("job-profiles", 2): {"source": "job-profiles", "page": 2, "pages": 2,
                          "total": 3, "rows": [{"key": "c", "cells": ["C"]}]},
}


class FakeWxo:
    def __init__(self, pages=None, fail=False):
        self.pages = PAGES if pages is None else pages
        self.fail = fail
        self.calls: list[tuple[str, int]] = []
        self._threads: dict[str, dict] = {}

    async def resolve_agents(self, registry):
        return {"jobreq": "agent-uuid"}

    async def run_to_completion(self, payload, timeout_s=180):
        assert "thread_id" not in payload      # scratch thread per page
        kind, source, page = payload["message"]["content"].split()
        assert kind == "OPTIONS_DUMP"
        self.calls.append((source, int(page)))
        if self.fail:
            return {"run_id": "r", "thread_id": None, "status": "failed"}
        tid = f"t{len(self.calls)}"
        self._threads[tid] = self.pages[(source, int(page))]
        return {"run_id": "r", "thread_id": tid, "status": "completed"}

    async def thread_messages(self, thread_id):
        meta = self._threads[thread_id]
        content = json.dumps({"_meta": {OPTIONS_META_KEY: meta}})
        return [{"id": "m1", "role": "assistant", "step_history": [
            {"step_details": [{"type": "tool_response", "name": "jrc_options_dump",
                               "content": content}]}]}]


def test_refresh_walks_every_page_and_caches():
    fake = FakeWxo()

    async def scenario():
        svc = OptionsService(fake, REG)
        await svc.refresh("jobreq")
        return await svc.get("jobreq", "job-profiles")

    out = asyncio.run(scenario())
    assert fake.calls == [("job-profiles", 1), ("job-profiles", 2)]
    assert out["status"] == "ready" and out["source"] == "job-profiles"
    assert out["total"] == 3
    assert [r["key"] for r in out["rows"]] == ["a", "b", "c"]
    assert out["fetched_at"] > 0


def test_get_reports_loading_then_ready():
    fake = FakeWxo()

    async def scenario():
        svc = OptionsService(fake, REG)
        first = await svc.get("jobreq", "job-profiles")
        await asyncio.gather(*svc._tasks.values())
        second = await svc.get("jobreq", "job-profiles")
        return first, second

    first, second = asyncio.run(scenario())
    assert first == {"status": "loading", "source": "job-profiles"}
    assert second["status"] == "ready" and len(second["rows"]) == 3
    assert fake.calls == [("job-profiles", 1), ("job-profiles", 2)]


def test_a_refused_payload_is_dropped_and_refetched():
    """`refresh=1` is the form engine reporting that it REFUSED these rows:
    their cell count did not match the columns its contract declares, which is
    what a row set built by an older tool build looks like (packages/ui
    1.16.0). That payload is wrong for everybody, so it is dropped rather than
    served again for the rest of a 12h TTL."""
    fake = FakeWxo()

    async def scenario():
        svc = OptionsService(fake, REG)
        await svc.get("jobreq", "job-profiles")
        await asyncio.gather(*svc._tasks.values())
        ready = await svc.get("jobreq", "job-profiles")
        # the engine refuses it: the next read must NOT be answered from cache
        refused = await svc.get("jobreq", "job-profiles", refresh=True)
        svc._last_attempt.clear()                  # a minute has passed
        again = await svc.get("jobreq", "job-profiles", refresh=True)
        await asyncio.gather(*svc._tasks.values())
        return ready, refused, again, await svc.get("jobreq", "job-profiles")

    ready, refused, again, healed = asyncio.run(scenario())
    assert ready["status"] == "ready"
    assert refused == {"status": "loading", "source": "job-profiles"}
    assert again["status"] == "loading"
    # ...and the refetch lands, so the field self-heals rather than sitting on
    # the starter rows until the TTL expires
    assert healed["status"] == "ready" and len(healed["rows"]) == 3


def test_a_refusing_client_cannot_hammer_the_upstream():
    """The bust is a refusal, not a cache-control knob a browser may spin on:
    the ordinary retry throttle still caps how often a source is refetched."""
    fake = FakeWxo()

    async def scenario():
        svc = OptionsService(fake, REG)
        await svc.get("jobreq", "job-profiles")
        await asyncio.gather(*svc._tasks.values())
        before = len(fake.calls)
        for _ in range(5):
            await svc.get("jobreq", "job-profiles", refresh=True)
        await asyncio.gather(*[t for t in svc._tasks.values() if not t.done()])
        return before, len(fake.calls)

    before, after = asyncio.run(scenario())
    # five refusals inside one throttle window buy ONE refetch (2 pages), not five
    assert after - before <= 2, (before, after)


def test_service_get_is_an_allowlist():
    async def scenario():
        svc = OptionsService(FakeWxo(), REG)
        with pytest.raises(KeyError):
            await svc.get("jobreq", "sup-orgs")     # not listed for this agent
        with pytest.raises(KeyError):
            await svc.get("plain", "job-profiles")  # agent has no sources

    asyncio.run(scenario())


def test_failed_fetch_retries_at_most_once_a_minute():
    fake = FakeWxo(fail=True)

    async def scenario():
        svc = OptionsService(fake, REG)
        for _ in range(3):
            assert (await svc.get("jobreq", "job-profiles"))["status"] == "loading"
            await asyncio.gather(*svc._tasks.values())
        attempts_inside_window = len(fake.calls)
        # Throttle window elapsed -> exactly one more attempt.
        svc._last_attempt[("jobreq", "job-profiles")] -= 61
        await svc.get("jobreq", "job-profiles")
        await asyncio.gather(*svc._tasks.values())
        return attempts_inside_window, len(fake.calls)

    inside, after = asyncio.run(scenario())
    assert inside == 1
    assert after == 2


# ---- endpoints (unconfigured app: allowlist before upstream) ----


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.delenv("WO_INSTANCE", raising=False)
    monkeypatch.delenv("WO_API_KEY", raising=False)
    monkeypatch.delenv("TKO_ENV_FILE", raising=False)
    for mod in [m for m in list(sys.modules) if m.startswith("app")]:
        del sys.modules[mod]
    main = importlib.import_module("app.main")
    return TestClient(main.app), main


HDR = {"X-TKO-Client": "aaaaaaaa-1"}


def test_options_requires_identity(client):
    c, _ = client
    r = c.get("/api/options", params={"agent_key": "jobreq", "source": "job-profiles"})
    assert r.status_code == 400


def test_options_unknown_agent_or_source_is_404(client):
    c, _ = client
    assert c.get("/api/options", headers=HDR,
                 params={"agent_key": "nope", "source": "job-profiles"}).status_code == 404
    assert c.get("/api/options", headers=HDR,
                 params={"agent_key": "jobreq", "source": "nope"}).status_code == 404
    assert c.post("/api/options/refresh", headers=HDR,
                  json={"agent_key": "nope"}).status_code == 404


def test_options_unconfigured_is_503(client):
    c, _ = client
    assert c.get("/api/options", headers=HDR,
                 params={"agent_key": "jobreq", "source": "job-profiles"}).status_code == 503
    assert c.post("/api/options/refresh", headers=HDR,
                  json={"agent_key": "jobreq"}).status_code == 503
