"""Per-browser thread ownership. A browser identity only ever sees its own
threads (plan 1.8). Tiny JSON file store - no form data, no message bodies.

Optional durability: when COS_* is configured the store is write-through to an
IBM Cloud Object Storage object, so a container restart (Code Engine scales to
zero) does not lose thread ownership. The local file stays the working copy;
COS is a best-effort mirror that must never break a chat request.

Multi-instance safety (Code Engine may run N instances): the in-memory map is
per-process, so a thread created on instance A is unknown to instance B. Three
mechanisms keep that from turning into a spurious 404:

* read-through on an ownership miss - `owns()` re-reads the COS object (bounded
  by a per-thread throttle window and a single in-flight read per process) and
  merges it in before reporting "unknown". Callers run it off the event loop
  via `asyncio.to_thread` (see `deps.own_or_404`).
* merge-on-write - a push re-reads the object, merges (union, newest
  `updated_at` wins) and writes back conditionally, so two instances recording
  different threads at the same moment cannot drop each other's rows.
* read-through on a listing - `list_for()` refreshes from COS at most once per
  owner per window, so a thread created on instance A appears in the sidebar
  served by instance B without waiting for B to take a chat turn.
* one push worker per process - pushes are serialised through a single daemon
  thread with a coalescing "latest snapshot" slot, so a burst of `record()`
  calls never contends with itself and a failed PUT is retried rather than
  dropped.

Retention: rows older than `retention_days` (THREAD_RETENTION_DAYS) are dropped
on boot, on every merge of remote rows, and from the map about to be written
back. Expiry needs no tombstone precisely because it is a deterministic
function of the row - every instance, and the shared object itself, converge on
the same set without coordinating. An EXPLICIT delete would not have that
property (see below).

Properties worth stating plainly:

* The store is APPEND-ONLY apart from retention. There is no delete, and the
  union merge is what makes read-through safe. If a delete is ever added it
  cannot be a plain row removal: the union would resurrect it from another
  instance's snapshot (or from COS). A delete would need a tombstone row
  carrying its own `updated_at` so newest-wins can settle it. The same caveat
  applies to the out-of-band pruning in `scripts/threads_admin.py`: a running
  instance still holding the row in memory can push it back, and it only stays
  gone once retention expires it or the instance restarts.
* Residual durability window: `record()` returns as soon as the row is in
  memory; the local file write and the COS push both happen on the worker. A
  row is therefore invisible to other instances from the moment it is recorded
  until the next PUT lands - normally well under a second, but if COS is
  failing it is until the next successful push (the worker keeps retrying with
  backoff, and each push sends the whole map, so nothing is lost once one
  lands). A read-through during that window still misses, which is the one case
  that can still 404. The LANDED BARRIER below lets a caller that cannot
  tolerate that window wait it out (see `wait_landed`). If the instance dies
  inside that window the row is lost: container disk is ephemeral, so the local
  file is a restart-time fallback, not durability. Accepted - the cost is one orphaned thread id.
* Rename lost-update across instances: renames carry no per-field version, so
  two instances renaming the same thread inside one push interval settle by
  newest `updated_at` on the whole row and the older title is dropped. Accepted
  - the effect is cosmetic and self-correcting on the next rename.
"""

import json
import logging
import threading
import time
from pathlib import Path

import httpx

log = logging.getLogger("tko.threadstore")

# How long a caller waits for a freshly recorded row to be visible to the other
# instances (see ThreadStore.wait_landed). One COS round trip under contention
# measured 300-700ms on staging, so this is several times the expected wait and
# is a ceiling, not a budget: the caller logs and carries on when it expires.
LANDED_TIMEOUT = 3.0


class TokenBusy(RuntimeError):
    """Another thread holds the token lock and the caller would not wait."""


class CosBackend:
    """Plain-REST IBM COS object read/write with an IAM bearer token.

    No SDK (no ibm_boto3): httpx only, so conditional-write headers are ours to
    set directly. Token refresh mirrors token_service (stale at 80% of TTL) but
    stays synchronous, because the callers are sync ThreadStore methods (which
    run off the event loop).
    """

    def __init__(self, api_key: str, endpoint: str, bucket: str, obj: str,
                 iam_url: str = "https://iam.cloud.ibm.com/identity/token",
                 transport: httpx.BaseTransport | None = None,
                 timeout: float = 15.0) -> None:
        self._api_key = api_key
        host = endpoint.strip().rstrip("/")
        if not host.startswith("http"):
            host = "https://" + host
        self._url = f"{host}/{bucket.strip('/')}/{obj.strip('/')}"
        self._iam_url = iam_url
        self._transport = transport
        self._timeout = timeout
        self._lock = threading.Lock()
        self._token: str | None = None
        self._issued_at = 0.0
        self._ttl = 0.0

    @property
    def url(self) -> str:
        return self._url

    def _client(self, timeout: float | None = None) -> httpx.Client:
        t = self._timeout if timeout is None else timeout
        if self._transport is not None:
            return httpx.Client(transport=self._transport, timeout=t)
        return httpx.Client(timeout=t)

    def _token_value(self, lock_timeout: float | None = None) -> str:
        """Return a live bearer token. `lock_timeout` bounds the wait for the
        refresh lock: the read-through path passes one so that a slow IAM mint
        held by the push worker cannot stall a request. Raises TokenBusy when
        the bound is hit."""
        acquired = self._lock.acquire(timeout=lock_timeout) \
            if lock_timeout is not None else self._lock.acquire()
        if not acquired:
            raise TokenBusy("token lock busy")
        try:
            fresh = (self._token is not None
                     and time.monotonic() < self._issued_at + 0.8 * self._ttl)
            if fresh:
                return self._token  # type: ignore[return-value]
            with self._client(lock_timeout) as client:
                resp = client.post(
                    self._iam_url,
                    data={"grant_type": "urn:ibm:params:oauth:grant-type:apikey",
                          "apikey": self._api_key},
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
                resp.raise_for_status()
                body = resp.json()
            self._token = body["access_token"]
            self._ttl = float(body.get("expires_in", 3600))
            self._issued_at = time.monotonic()
            return self._token
        finally:
            self._lock.release()

    def load(self) -> dict | None:
        """Return the stored mapping, or None when absent/unreadable."""
        return self.load_with_etag()[0]

    def load_with_etag(self, timeout: float | None = None
                       ) -> tuple[dict | None, str | None]:
        """Return (mapping, etag). The mapping is None when the object is
        absent; the etag is None when absent or not reported by the server.
        `timeout` bounds both the token wait and the GET."""
        token = self._token_value(lock_timeout=timeout)
        with self._client(timeout) as client:
            resp = client.get(self._url, headers={"Authorization": f"Bearer {token}"})
        if resp.status_code == 404:
            return None, None
        resp.raise_for_status()
        data = resp.json()
        etag = resp.headers.get("ETag")
        return (data if isinstance(data, dict) else None), etag

    def save(self, threads: dict, if_match: str | None = None,
             if_none_match: str | None = None) -> str:
        """PUT the mapping. Returns:

        "ok"          - written.
        "raced"       - a conditional header was rejected (412/409); the caller
                        should re-read and retry.
        "unsupported" - the server rejected the conditional header itself
                        (400/501); the caller should retry unconditionally and
                        stop sending the header.

        Any other failure raises."""
        token = self._token_value()
        headers = {"Authorization": f"Bearer {token}",
                   "Content-Type": "application/json"}
        if if_match:
            headers["If-Match"] = if_match
        if if_none_match:
            headers["If-None-Match"] = if_none_match
        conditional = bool(if_match or if_none_match)
        with self._client() as client:
            resp = client.put(self._url, headers=headers,
                              content=json.dumps(threads, indent=1).encode())
        if conditional and resp.status_code in (409, 412):
            return "raced"
        if conditional and resp.status_code in (400, 501):
            log.warning("COS rejected the conditional header (%d); "
                        "falling back to unconditional merged writes",
                        resp.status_code)
            return "unsupported"
        resp.raise_for_status()
        return "ok"


DAY_S = 86400.0


def expire(rows: dict, now: float, retention_days: float) -> dict:
    """Drop rows last touched more than `retention_days` ago. A row's age is
    its `updated_at`, falling back to `created_at`; a row with neither (or an
    unparseable one) is kept, because guessing "old" would delete it. With
    `retention_days` at 0 or below nothing expires.

    Deliberately a pure function of the row and the clock: every instance
    computes the same verdict, so no tombstone is needed to stop a merge from
    resurrecting what another instance expired."""
    if retention_days <= 0:
        return rows
    cutoff = now - retention_days * DAY_S
    kept = {}
    for tid, row in rows.items():
        if not isinstance(row, dict):
            continue
        stamp = row.get("updated_at")
        if stamp is None:
            stamp = row.get("created_at")
        try:
            age_ok = float(stamp) >= cutoff
        except (TypeError, ValueError):
            age_ok = True  # undatable: keep it rather than delete blind
        if age_ok:
            kept[tid] = row
    return kept


def cos_backend_from_settings(settings) -> CosBackend | None:
    if not settings.cos_configured:
        return None
    return CosBackend(settings.cos_api_key, settings.cos_endpoint,
                      settings.cos_bucket, settings.cos_object,
                      settings.iam_token_url)


def _updated_at(row: dict) -> float | None:
    """The row's timestamp, or None when it is unparseable. A missing or null
    value is not malformed - it reads as 0.0, so the row is kept but never wins
    a conflict."""
    raw = row.get("updated_at")
    if raw is None:
        return 0.0
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def _merge(base: dict, incoming: dict) -> dict:
    """Union of two thread maps. For a thread id in both, the row with the
    newer `updated_at` wins; ties go to `base` (the caller's own copy), so a
    local record is never replaced by an equally-dated remote one. A thread
    present in either side is never dropped.

    Defensive by design: this runs on every ownership miss, so one malformed
    row in the shared object must not raise and turn every miss into a 500.
    Rows that are not dicts, have no owner, or carry an unparseable
    `updated_at` are skipped and logged. An incoming row whose owner differs
    from the local row for the same id is never allowed to rewrite the owner -
    local wins and the collision is logged."""
    merged = dict(base)
    for tid, row in incoming.items():
        if not isinstance(row, dict) or not row.get("owner"):
            log.warning("thread store: skipping malformed remote row %r", tid)
            continue
        theirs = _updated_at(row)
        if theirs is None:
            log.warning("thread store: skipping remote row %r with bad updated_at", tid)
            continue
        mine = merged.get(tid)
        if mine is None:
            merged[tid] = row
            continue
        if isinstance(mine, dict) and mine.get("owner") != row.get("owner"):
            # Same thread id claimed by two identities. Never rewrite the owner
            # from a remote row: that would hand one browser another's thread.
            log.warning("thread store: owner collision on %r, keeping local", tid)
            continue
        ours = _updated_at(mine) if isinstance(mine, dict) else None
        if ours is None or theirs > ours:
            merged[tid] = row
    return merged


class ThreadStore:
    # Read-through budget on an ownership miss: at most one COS GET per thread
    # id per window, and never more than one GET in flight per process. Kept
    # short so a legitimate re-send of the same turn is not answered from a
    # stale miss.
    REFRESH_WINDOW = 2.0
    # The read-through is bounded so the worker thread it occupies is returned
    # quickly even when COS is slow.
    REFRESH_TIMEOUT = 4.0
    # Bound on the conditional read-modify-write retry loop within one push.
    WRITE_ATTEMPTS = 4
    # Transport-failure retries for a push (5xx, timeout), and the base backoff
    # that is multiplied by the attempt number and capped.
    PUSH_ATTEMPTS = 5
    PUSH_BACKOFF = 0.05
    PUSH_BACKOFF_CAP = 5.0
    # How long the push worker waits on an empty queue before exiting; the
    # next write starts a fresh one.
    IDLE_TIMEOUT = 30.0

    def __init__(self, data_dir: str, cos: CosBackend | None = None,
                 retention_days: float = 0.0) -> None:
        self._path = Path(data_dir) / "threads.json"
        self._lock = threading.Lock()
        self._threads: dict[str, dict] = {}
        self._cos = cos
        # Retention defaults to OFF here and is switched on by the caller
        # (deps.py passes settings.thread_retention_days, default 30 days), so
        # constructing a store in a test or a script never silently drops rows
        # whose timestamps are fixtures rather than real clock readings.
        self.retention_days = retention_days
        self._conditional_writes = True  # cleared if COS rejects the header
        # Read-through throttle. Two stamp maps: one keyed by thread id for the
        # ownership miss path, one by owner for the listing path. They are
        # separate budgets on purpose - a burst of misses on one thread must
        # not suppress the sidebar's refresh, or the other way round.
        self._refresh_lock = threading.Lock()
        self._refreshed_at: dict[str, float] = {}
        self._owner_refreshed_at: dict[str, float] = {}
        self.refreshes = 0  # observable in tests / logs
        # Push worker: one thread, one coalescing slot.
        self._push_cv = threading.Condition()
        self._pending: dict | None = None
        # Row ids recorded since the last successful push, travelling with the
        # snapshot that carries them (see the landed barrier below).
        self._pending_ids: set[str] = set()
        self._landed: dict[str, threading.Event] = {}
        self._worker: threading.Thread | None = None
        self._pushes_in_flight = 0
        self.max_concurrent_pushes = 0  # observable in tests
        self.pushes_landed = 0

        loaded = False
        if cos is not None:
            # COS wins on boot: it is the surviving copy across restarts.
            try:
                remote, _etag = cos.load_with_etag()
                if remote is not None:
                    # Through _merge, not raw: the boot load must apply the same
                    # sanitising as every later merge, or one malformed row in
                    # the shared object is served as a real thread.
                    self._threads = self._expire(_merge({}, remote))
                    loaded = True
                    log.info("thread store loaded from COS (%d threads, %d kept)",
                             len(remote), len(self._threads))
            except Exception as e:  # noqa: BLE001
                log.warning("COS thread-store load skipped: %s", type(e).__name__)
        if not loaded and self._path.is_file():
            try:
                local = json.loads(self._path.read_text())
                self._threads = (self._expire(_merge({}, local))
                                 if isinstance(local, dict) else {})
            except ValueError:
                self._threads = {}

    def _expire(self, rows: dict, now: float | None = None) -> dict:
        return expire(rows, time.time() if now is None else now,
                      self.retention_days)

    # ---------------------------------------------------------------- writes

    def _write_local(self, snapshot: dict) -> None:
        """Write the working copy to disk. Runs on the push worker (see
        `_save`), so the event loop never pays the serialisation cost."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps(snapshot, indent=1))
        tmp.replace(self._path)

    def _save(self, landed_id: str | None = None) -> None:
        """Publish the current map. HOT PATH: this runs under `_lock` inside a
        request handler, so it does no serialisation and no I/O of its own. It
        takes a shallow copy (rows are immutable - an update replaces the row
        object rather than mutating it, so a shallow copy is a real snapshot)
        and hands it to the worker, which writes the local file and then
        pushes. With no COS configured there is no worker, so the file write
        happens here.

        `landed_id` is the row whose barrier this publication releases: the
        worker sets it once a snapshot containing the row has been PUT. With no
        COS there is nothing to wait for, so it is released here."""
        snapshot = dict(self._threads)
        if self._cos is None:
            self._write_local(snapshot)
            if landed_id is not None:
                self._release({landed_id})
            return
        self._queue_push(snapshot, landed_id)

    def _queue_push(self, snapshot: dict, landed_id: str | None = None) -> None:
        """Hand a snapshot to the push worker. The slot coalesces: a newer
        snapshot replaces a pending one (snapshots are the whole map and memory
        only ever grows, so the newer one is a superset). Callers are sync
        methods invoked from async handlers, so nothing here blocks on COS and
        a COS hiccup can never fail a chat request.

        The id set coalesces with it: a superseded snapshot's ids ride along on
        the newer one, because the newer snapshot contains those rows too."""
        if self._cos is None:
            return
        with self._push_cv:
            self._pending = snapshot
            if landed_id is not None:
                self._pending_ids.add(landed_id)
            if self._worker is None or not self._worker.is_alive():
                self._worker = threading.Thread(
                    target=self._push_loop, name="cos-threadstore-push", daemon=True)
                self._worker.start()
            self._push_cv.notify_all()

    def _push_loop(self) -> None:
        while True:
            with self._push_cv:
                while self._pending is None:
                    # Idle briefly, then let the thread die; the next write
                    # starts a fresh one. Keeps a quiet process thread-free.
                    if not self._push_cv.wait(timeout=self.IDLE_TIMEOUT) \
                            and self._pending is None:
                        self._worker = None
                        return
                snapshot = self._pending
                ids = self._pending_ids
                self._pending = None
                self._pending_ids = set()
                self._pushes_in_flight += 1
                self.max_concurrent_pushes = max(self.max_concurrent_pushes,
                                                 self._pushes_in_flight)
            try:
                # Disk first: the local file is the last-known-good copy a
                # restart falls back to, so it must not wait on the network.
                try:
                    self._write_local(snapshot)
                except OSError as e:
                    log.warning("thread store local write failed: %s",
                                type(e).__name__)
                self._push_with_retries(snapshot, ids)
            except Exception as e:  # noqa: BLE001
                log.warning("COS thread-store push abandoned: %s", type(e).__name__)
                # Never leave a waiter hanging on a push that blew up.
                self._release(ids)
            finally:
                with self._push_cv:
                    self._pushes_in_flight -= 1
                    # flush() waits on this: it is the only signal that the
                    # queue has actually drained.
                    self._push_cv.notify_all()

    def flush(self, timeout: float = 5.0) -> bool:
        """Block until nothing is pending and no push is in flight, or the
        timeout expires. Returns True when the queue drained. Called from the
        app's lifespan teardown so a shutdown does not strand the rows recorded
        in the last moments of the process."""
        if self._cos is None:
            return True
        end = time.monotonic() + timeout
        with self._push_cv:
            while self._pending is not None or self._pushes_in_flight:
                remaining = end - time.monotonic()
                if remaining <= 0:
                    log.warning("thread store flush timed out with a push outstanding")
                    return False
                self._push_cv.wait(remaining)
        return True

    def _push_with_retries(self, snapshot: dict, ids: set[str] | None = None) -> None:
        """Retry a push across transport failures. A newer pending snapshot
        supersedes this one: it is a superset, so retrying the old one would be
        wasted work - and `ids` goes back on the queue with it, so the rows
        waiting on a barrier are released by whichever push actually lands."""
        ids = set() if ids is None else ids
        for attempt in range(1, self.PUSH_ATTEMPTS + 1):
            with self._push_cv:
                if self._pending is not None:
                    # A newer snapshot is queued; let it carry the rows AND the
                    # barriers - it contains every row this one did.
                    self._pending_ids |= ids
                    return
            try:
                if self._push_merged(self._cos, snapshot):
                    self.pushes_landed += 1
                    self._release(ids)
                    return
            except Exception as e:  # noqa: BLE001
                log.warning("COS thread-store save failed (attempt %d/%d): %s",
                            attempt, self.PUSH_ATTEMPTS, type(e).__name__)
            if attempt < self.PUSH_ATTEMPTS:
                time.sleep(min(self.PUSH_BACKOFF * attempt, self.PUSH_BACKOFF_CAP))
        log.warning("COS thread-store push gave up after %d attempts; rows stay "
                    "local until the next successful push", self.PUSH_ATTEMPTS)
        if ids:
            # Releasing an UNLANDED barrier is deliberate: a waiter that blocks
            # forever is worse than one that proceeds with the row still only
            # in memory, which is exactly where this store was before the
            # barrier existed.
            log.warning("landed barrier released unlanded for %d row(s) after a "
                        "failed push", len(ids))
        self._release(ids)

    def _push_merged(self, cos: CosBackend, snapshot: dict) -> bool:
        """One conditional read-modify-write cycle. Returns True when the write
        landed, False when the conditional retries were exhausted; raises on a
        transport failure so the caller can back off."""
        for attempt in range(self.WRITE_ATTEMPTS):
            # A FAILED pre-read is not an absent object. Letting it fall
            # through to `remote=None` would, once the "unsupported" latch has
            # cleared conditional writes, PUT this process's snapshot alone
            # over the shared object and delete every row only the other
            # instance holds. Raise instead: the caller backs off and retries
            # the whole cycle, pre-read included.
            remote, etag = cos.load_with_etag()
            merged = self._expire(_merge(snapshot, remote or {}))
            if remote:
                self._absorb(remote)
            if not self._conditional_writes:
                result = cos.save(merged)
            elif etag:
                result = cos.save(merged, if_match=etag)
            elif remote is None:
                result = cos.save(merged, if_none_match="*")
            else:
                # Object exists but the server reported no etag: unconditional
                # write of the already-merged map (last writer wins, but the
                # pre-read means it still carries everyone's rows).
                result = cos.save(merged)
            if result == "ok":
                return True
            if result == "unsupported":
                # Conditional headers are not honoured here. Stop sending them
                # and fall back to the merged last-writer-wins path, which is
                # what actually protects the rows.
                self._conditional_writes = False
                continue
            log.info("COS thread-store write raced (attempt %d), retrying", attempt + 1)
            time.sleep(0.05 * (attempt + 1))
        return False

    def _absorb(self, remote: dict) -> None:
        """Merge remote rows into memory without triggering another push."""
        with self._lock:
            self._threads = self._expire(_merge(self._threads, remote))

    # Rows are IMMUTABLE: every update replaces the row object instead of
    # mutating it. That is what lets `_save` snapshot with a shallow `dict()`
    # copy - a deep copy of the whole map on the hot path cost ~12ms at 4,800
    # rows, on the event loop, under the store lock.

    def record(self, thread_id: str, owner: str, agent_key: str,
               title: str) -> threading.Event:
        """Record (or touch) a row and return its LANDED BARRIER - an event set
        once a snapshot containing this row has been pushed to COS, or
        immediately when there is no COS to push to. Callers that need other
        instances to see the row before they answer wait on it via
        `wait_landed`; everyone else ignores the return value, as before."""
        with self._lock:
            entry = self._threads.get(thread_id)
            now = time.time()
            if entry is None:
                self._threads[thread_id] = {
                    "owner": owner, "agent_key": agent_key,
                    "title": title[:80], "created_at": now, "updated_at": now,
                }
            else:
                self._threads[thread_id] = {**entry, "updated_at": now}
            event = self._barrier(thread_id)
            self._save(landed_id=thread_id)
        return event

    def rename(self, thread_id: str, title: str) -> None:
        with self._lock:
            entry = self._threads.get(thread_id)
            if entry is not None:
                self._threads[thread_id] = {**entry, "title": title[:80],
                                            "updated_at": time.time()}
                self._save()

    # ------------------------------------------------------- landed barrier
    # Two instances, one shared object: a row recorded on A is invisible to B
    # until A's PUT lands, and B's read-through can (and on staging did) miss a
    # thread the browser was told about milliseconds earlier. These three
    # methods let a caller wait for that PUT instead of racing it. The events
    # map holds only rows still in flight - `_release` pops each one, and an
    # unknown id therefore reads as "already landed", which is the right answer
    # both for a row that has landed and for one this process never recorded.

    def _barrier(self, thread_id: str) -> threading.Event:
        with self._push_cv:
            event = self._landed.get(thread_id)
            if event is None:
                event = threading.Event()
                self._landed[thread_id] = event
            return event

    def _release(self, ids) -> None:
        """Set (and forget) the barriers for every id a push carried."""
        if not ids:
            return
        with self._push_cv:
            events = [self._landed.pop(tid, None) for tid in ids]
        for event in events:
            if event is not None:
                event.set()

    def landed(self, thread_id: str) -> threading.Event | None:
        """The row's barrier, or None when nothing is waiting to land."""
        with self._push_cv:
            return self._landed.get(thread_id)

    def wait_landed(self, thread_id: str, timeout: float = LANDED_TIMEOUT) -> bool:
        """Block until the row has been pushed to COS. Returns True when it has
        landed (or was never in flight), False on timeout. BLOCKING: async
        callers run it via asyncio.to_thread."""
        event = self.landed(thread_id)
        if event is None:
            return True
        return event.wait(timeout)

    # ---------------------------------------------------------------- reads

    def _refresh_from_cos(self, key: str, stamps: dict[str, float]) -> None:
        """Re-read the COS object and merge it in. Bounded four ways: at most
        one read per key per REFRESH_WINDOW, one in-flight read per process (a
        second caller blocks on the lock, then finds the window fresh and
        returns without a read of its own), REFRESH_TIMEOUT on the token wait
        and the GET, and REFRESH_TIMEOUT on the wait for the refresh lock
        itself - an unbounded wait there would hand a slow COS the very stall
        this path exists to avoid.

        `stamps` is the throttle map to charge the read against: one keyed by
        thread id for ownership misses, one by owner for listings.

        The stamp is written only AFTER a successful read. Stamping up front
        would make one COS blip suppress the retry for the whole window, so a
        legitimate cross-instance thread answers two 404s in a row instead of
        one - the immediate re-send is exactly the case the short window is
        there to serve."""
        if self._cos is None:
            return
        now = time.monotonic()
        if now - stamps.get(key, 0.0) < self.REFRESH_WINDOW:
            return
        if not self._refresh_lock.acquire(timeout=self.REFRESH_TIMEOUT):
            log.info("COS thread-store refresh skipped: another read in flight")
            return
        try:
            now = time.monotonic()
            if now - stamps.get(key, 0.0) < self.REFRESH_WINDOW:
                return
            try:
                remote, _etag = self._cos.load_with_etag(timeout=self.REFRESH_TIMEOUT)
                self.refreshes += 1
            except TokenBusy:
                log.info("COS thread-store refresh skipped: token lock busy")
                return
            except Exception as e:  # noqa: BLE001
                log.warning("COS thread-store refresh failed: %s", type(e).__name__)
                return
            stamps[key] = time.monotonic()
            if len(stamps) > 2048:  # keep the throttle map bounded
                cutoff = stamps[key] - self.REFRESH_WINDOW
                stale = [k for k, v in stamps.items() if v < cutoff]
                for k in stale:
                    del stamps[k]
            if remote:
                self._absorb(remote)
        finally:
            self._refresh_lock.release()

    def _owns_local(self, thread_id: str, owner: str) -> bool:
        entry = self._threads.get(thread_id)
        return bool(isinstance(entry, dict) and entry.get("owner") == owner)

    def owns(self, thread_id: str, owner: str) -> bool:
        """Ownership check behind every 404/ownership decision. A miss is
        re-checked against COS before it is believed, because the thread may
        have been created on another instance. Blocking: callers in async
        handlers must run this via asyncio.to_thread."""
        if self._owns_local(thread_id, owner):
            return True
        self._refresh_from_cos(thread_id, self._refreshed_at)
        return self._owns_local(thread_id, owner)

    def list_for(self, owner: str, agent_key: str | None = None) -> list[dict]:
        """This browser's threads, newest first.

        Read-through, throttled per owner: without it the sidebar is whatever
        THIS instance happens to know, so a thread started on instance A is
        missing from the list served by instance B until B takes a chat turn
        for it. Any COS failure degrades to the local list. Blocking, like
        `owns` - async callers run it via asyncio.to_thread."""
        self._refresh_from_cos(owner, self._owner_refreshed_at)
        rows = [
            {"thread_id": tid, "agent_key": e["agent_key"], "title": e["title"],
             "created_at": e["created_at"], "updated_at": e["updated_at"]}
            for tid, e in list(self._threads.items())
            if e["owner"] == owner and (agent_key is None or e["agent_key"] == agent_key)
        ]
        rows.sort(key=lambda r: r["updated_at"], reverse=True)
        return rows
