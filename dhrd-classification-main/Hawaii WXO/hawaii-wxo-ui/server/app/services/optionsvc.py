"""Options side channel: full reference tables fetched out of band.

The giant pickers (job profiles, sup orgs) are too big to ride the chat
thread, so the proxy pulls them page by page over scratch runs and caches
them here. Each page is a FRESH thread with the protocol message
`OPTIONS_DUMP <source> <page>`; those threads are deliberately never recorded
in the ThreadStore, so they never surface in any user's chat list.

Only (agent_key, source) pairs listed in the registry's `option_sources` are
ever fetchable - the source name is an allowlist, not a free parameter.
"""

import asyncio
import logging
import time

from .events import extract_meta_key
from .registry import resolve_agent

log = logging.getLogger("tko.options")

OPTIONS_META_KEY = "tko/options-dump@v1"
DEFAULT_TTL_S = 43_200          # 12h, matched to the tool-side KV cache
RETRY_THROTTLE_S = 60           # a failing source retries at most once a minute
MAX_PAGES = 50                  # runaway guard on a bad `pages` value
RUN_TIMEOUT_S = 180


class OptionsService:
    def __init__(self, wxo, registry: dict, store=None) -> None:
        self._wxo = wxo
        self._registry = registry
        # ThreadStore is intentionally unused: scratch threads must NOT be
        # recorded. Kept on the signature so nothing else wires it in later.
        self._store = store
        self._cache: dict[tuple[str, str], dict] = {}
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}
        self._tasks: dict[tuple[str, str], asyncio.Task] = {}
        self._last_attempt: dict[tuple[str, str], float] = {}

    # ---- allowlist ----

    def sources_for(self, agent_key: str) -> dict:
        entry = resolve_agent(self._registry, agent_key) or {}
        sources = entry.get("option_sources")
        return sources if isinstance(sources, dict) else {}

    def _ttl(self, agent_key: str, source: str) -> int:
        cfg = self.sources_for(agent_key).get(source) or {}
        try:
            return int(cfg.get("ttl_s") or DEFAULT_TTL_S)
        except (TypeError, ValueError):
            return DEFAULT_TTL_S

    def _lock(self, key: tuple[str, str]) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = self._locks[key] = asyncio.Lock()
        return lock

    # ---- public API ----

    async def get(self, agent_key: str, source: str,
                  refresh: bool = False) -> dict:
        """Cached rows if fresh, otherwise kick a background fetch and report
        loading. Callers poll; nothing here ever blocks on the upstream.

        `refresh` IS A REFUSAL, NOT A PREFERENCE (packages/ui 1.16.0). The
        browser sends it only after the form engine has REFUSED this payload -
        its rows did not match the columns the contract declares, which is what
        a row set built by an older tool build looks like. That payload is
        wrong for every reader, not just the one who noticed, so it is dropped
        rather than served again while it ages out of a 12h TTL.

        It cannot be used to hammer the upstream: `_maybe_start` still refuses
        to start more often than RETRY_THROTTLE_S, so a client that keeps
        refusing gets one refetch a minute and the rest of the time is told
        `loading` - which renders the contract's own starter rows."""
        if source not in self.sources_for(agent_key):
            raise KeyError(source)
        key = (agent_key, source)
        entry = self._cache.get(key)
        if entry and not refresh \
                and time.time() - entry["fetched_at"] < self._ttl(agent_key, source):
            return {"status": "ready", "source": source, "total": entry["total"],
                    "rows": entry["rows"], "fetched_at": entry["fetched_at"]}
        if refresh:
            self._cache.pop(key, None)
        self._maybe_start(key)
        return {"status": "loading", "source": source}

    async def refresh(self, agent_key: str) -> None:
        """Force a refetch of every source for this agent (endpoint + startup
        warm). Never raises: a dead source degrades to the starter rows."""
        for source in self.sources_for(agent_key):
            key = (agent_key, source)
            self._last_attempt[key] = time.time()
            try:
                await self._fetch(agent_key, source, force=True)
            except Exception as e:  # noqa: BLE001 - a bad source is not fatal
                log.warning("options refresh %s/%s failed: %s",
                            agent_key, source, type(e).__name__)

    # ---- fetch ----

    def _maybe_start(self, key: tuple[str, str]) -> None:
        task = self._tasks.get(key)
        if task is not None and not task.done():
            return
        last = self._last_attempt.get(key)
        if last is not None and time.time() - last < RETRY_THROTTLE_S:
            return
        self._last_attempt[key] = time.time()
        self._tasks[key] = asyncio.create_task(self._fetch_quiet(*key))

    async def _fetch_quiet(self, agent_key: str, source: str) -> None:
        try:
            await self._fetch(agent_key, source)
        except Exception as e:  # noqa: BLE001 - background task, never propagate
            log.warning("options fetch %s/%s failed: %s",
                        agent_key, source, type(e).__name__)

    async def _fetch(self, agent_key: str, source: str, force: bool = False) -> None:
        async with self._lock((agent_key, source)):
            entry = self._cache.get((agent_key, source))
            if not force and entry and \
                    time.time() - entry["fetched_at"] < self._ttl(agent_key, source):
                return  # filled while this one waited on the lock
            agent_id = (await self._wxo.resolve_agents(self._registry)).get(agent_key)
            if not agent_id:
                raise RuntimeError("agent did not resolve")
            rows: list = []
            total = 0
            page = 1
            while page <= MAX_PAGES:
                meta = await self._dump_page(agent_id, source, page)
                if meta.get("source") != source:
                    raise RuntimeError("source mismatch in dump meta")
                page_rows = meta.get("rows") or []
                pages = int(meta.get("pages") or 1)
                total = int(meta.get("total") or 0)
                log.info("options fetch %s page %d/%d (%d rows)",
                         source, page, pages, len(page_rows))
                rows += page_rows
                if page >= pages:
                    break
                page += 1
            if not rows:
                raise RuntimeError("dump returned no rows")
            if total and len(rows) != total:
                # Serve anyway: a short/long page is a discoverability gap,
                # never a correctness one (submit re-validates every pick).
                log.warning("options fetch %s row count %d != reported total %d",
                            source, len(rows), total)
            self._cache[(agent_key, source)] = {
                "rows": rows, "total": total or len(rows), "fetched_at": time.time(),
            }

    async def _dump_page(self, agent_id: str, source: str, page: int) -> dict:
        # No thread_id: a fresh scratch thread per page, never recorded.
        payload = {"message": {"role": "user",
                               "content": f"OPTIONS_DUMP {source} {page}"},
                   "agent_id": agent_id}
        run = await self._wxo.run_to_completion(payload, timeout_s=RUN_TIMEOUT_S)
        thread_id = run.get("thread_id")
        if run.get("status") != "completed" or not thread_id:
            raise RuntimeError(f"dump run {run.get('status')}")
        meta = None
        for msg in await self._wxo.thread_messages(thread_id):
            for step in msg.get("step_history") or []:
                found = extract_meta_key(step.get("step_details") or [],
                                         OPTIONS_META_KEY)
                if isinstance(found, dict):
                    meta = found  # keep the newest
        if meta is None:
            raise RuntimeError(f"no dump meta on page {page}")
        return meta
