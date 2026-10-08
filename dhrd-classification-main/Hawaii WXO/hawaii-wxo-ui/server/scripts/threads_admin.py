"""Maintenance for the shared thread-ownership index in COS.

The index is the object the proxy write-throughs to (`COS_OBJECT`); it holds
one row per thread - owner, agent key, title, timestamps - and nothing else.
Test batteries and long-lived browsers make it grow, so this script reports on
it and prunes it out of band.

It reuses the app's own `CosBackend`, so the IAM mint, the GET and the
conditional PUT are the exact code paths the running proxy uses. Credentials
come from the environment the same way the app reads them (COS_API_KEY,
COS_ENDPOINT, COS_BUCKET, COS_OBJECT); `--object` overrides the object name so
one shell can target staging or prod explicitly.

    .venv/bin/python scripts/threads_admin.py stats
    .venv/bin/python scripts/threads_admin.py \
        --object tko-agents-ui-staging/threads.json prune --older-than 14
    .venv/bin/python scripts/threads_admin.py prune --owner-prefix e2e- --apply
    .venv/bin/python scripts/threads_admin.py clear --yes --apply

DRY RUN BY DEFAULT. Nothing is written without `--apply`; every run prints the
before/after counts either way.

RUNNING INSTANCES KEEP THEIR OWN COPY. Each proxy instance holds the index in
memory and every push re-reads and MERGES, so a row pruned here comes back the
moment an instance that still holds it pushes. Retention expiry does not have
that problem (it is a pure function of the row, so every instance agrees), but
an explicit prune does - it is not a tombstone. In practice:

* `prune --older-than N` with N at or above THREAD_RETENTION_DAYS is stable:
  the instances expire the same rows on their own.
* `prune --owner-prefix ...` and `clear` are best run right before a deploy or
  restart, so the instances that could resurrect rows are replaced anyway.
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.threadstore import DAY_S, CosBackend  # noqa: E402

WRITE_ATTEMPTS = 5
AGE_BUCKETS = ((1.0, "under 1 day"), (7.0, "1-7 days"), (30.0, "7-30 days"),
               (90.0, "30-90 days"), (float("inf"), "over 90 days"))


def backend_from_env(obj: str | None = None) -> CosBackend:
    missing = [v for v in ("COS_API_KEY", "COS_ENDPOINT", "COS_BUCKET")
               if not os.getenv(v)]
    if missing:
        raise SystemExit("missing environment: " + ", ".join(missing))
    name = obj or os.getenv("COS_OBJECT") or "tko-agents-ui/threads.json"
    return CosBackend(os.environ["COS_API_KEY"], os.environ["COS_ENDPOINT"],
                      os.environ["COS_BUCKET"], name,
                      os.getenv("IAM_TOKEN_URL",
                                "https://iam.cloud.ibm.com/identity/token"))


def _age_days(row: dict, now: float) -> float | None:
    """Row age in days, or None when it carries no usable timestamp."""
    stamp = row.get("updated_at")
    if stamp is None:
        stamp = row.get("created_at")
    try:
        return (now - float(stamp)) / DAY_S
    except (TypeError, ValueError):
        return None


def summarize(rows: dict, now: float) -> dict:
    """Counts only - no titles, no thread ids, no owner values are reported."""
    buckets = {label: 0 for _, label in AGE_BUCKETS}
    buckets["undated"] = 0
    owners = set()
    for row in rows.values():
        if not isinstance(row, dict):
            buckets["undated"] += 1
            continue
        if row.get("owner"):
            owners.add(row["owner"])
        age = _age_days(row, now)
        if age is None:
            buckets["undated"] += 1
            continue
        for limit, label in AGE_BUCKETS:
            if age < limit:
                buckets[label] += 1
                break
    return {"rows": len(rows), "owners": len(owners),
            "bytes": len(json.dumps(rows, indent=1).encode()),
            "ages": buckets}


def filter_rows(rows: dict, now: float, older_than: float | None = None,
                owner_prefix: str | None = None) -> dict:
    """The rows to KEEP. A row is removed when it is older than `older_than`
    days or its owner starts with `owner_prefix`; an undated row is never
    removed by age (the same rule the store's retention uses - never delete on
    a guess). With neither filter set nothing is removed."""
    kept = {}
    for tid, row in rows.items():
        drop = False
        if isinstance(row, dict):
            if older_than is not None:
                age = _age_days(row, now)
                drop = age is not None and age > older_than
            if not drop and owner_prefix:
                owner = row.get("owner")
                drop = isinstance(owner, str) and owner.startswith(owner_prefix)
        if not drop:
            kept[tid] = row
    return kept


def _print_stats(label: str, rows: dict, now: float) -> None:
    s = summarize(rows, now)
    print(f"{label}: {s['rows']} rows, {s['bytes']} bytes, "
          f"{s['owners']} distinct owners")
    for name, count in s["ages"].items():
        if count:
            print(f"    {name:<12} {count}")


def apply_change(cos: CosBackend, transform, apply: bool,
                 now: float | None = None) -> int:
    """GET -> transform -> conditional PUT, retrying when the etag moves.
    Returns the number of rows removed (0 on a dry run). `transform` takes the
    freshly read rows and returns the rows to keep."""
    now = time.time() if now is None else now
    for attempt in range(1, WRITE_ATTEMPTS + 1):
        rows, etag = cos.load_with_etag()
        rows = rows or {}
        kept = transform(rows)
        removed = len(rows) - len(kept)
        _print_stats("before", rows, now)
        _print_stats("after ", kept, now)
        print(f"would remove {removed} rows" if not apply
              else f"removing {removed} rows")
        if not apply:
            return 0
        if removed == 0:
            print("nothing to write")
            return 0
        result = cos.save(kept, if_match=etag) if etag else cos.save(kept)
        if result == "ok":
            print(f"written: {len(kept)} rows remain")
            return removed
        if result == "raced":
            print(f"object moved under us (attempt {attempt}/{WRITE_ATTEMPTS}); "
                  "re-reading")
            time.sleep(0.2 * attempt)
            continue
        # "unsupported": the server refused the conditional header itself.
        print("conditional write unsupported here; retrying unconditionally")
        if cos.save(kept) == "ok":
            print(f"written: {len(kept)} rows remain")
            return removed
        break
    raise SystemExit("gave up without writing; the object is unchanged")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--object", help="COS object key (overrides COS_OBJECT)")
    p.add_argument("--apply", action="store_true",
                   help="actually write; without it the run is a dry run")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("stats", help="row counts, size, age buckets, owner count")
    pr = sub.add_parser("prune", help="remove rows by age and/or owner prefix")
    pr.add_argument("--older-than", type=float, metavar="N",
                    help="remove rows last touched more than N days ago")
    pr.add_argument("--owner-prefix", metavar="PREFIX",
                    help="remove rows whose owner starts with PREFIX")
    cl = sub.add_parser("clear", help="write an empty index")
    cl.add_argument("--yes", action="store_true",
                    help="required acknowledgement that every row goes")
    args = p.parse_args(argv)

    cos = backend_from_env(args.object)
    print(f"object: {cos.url}")
    now = time.time()

    if args.cmd == "stats":
        rows, _etag = cos.load_with_etag()
        _print_stats("index", rows or {}, now)
        return 0

    if args.cmd == "prune":
        if args.older_than is None and not args.owner_prefix:
            raise SystemExit("prune needs --older-than and/or --owner-prefix")
        apply_change(cos, lambda rows: filter_rows(
            rows, now, args.older_than, args.owner_prefix), args.apply, now)
        return 0

    if not args.yes:
        raise SystemExit("clear needs --yes")
    apply_change(cos, lambda rows: {}, args.apply, now)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
