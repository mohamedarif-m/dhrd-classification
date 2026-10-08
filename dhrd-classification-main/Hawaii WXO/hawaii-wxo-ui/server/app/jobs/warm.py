"""Cache warmer - run as a scheduled Code Engine job, never as part of the app.

Each agent's first conversation after its 12h Workday-data cache expires pays a
~40s cold fetch. This job volunteers to be that conversation: it sends one
"start" to every agent in the registry so the cache is always warm when a
human arrives. Schedule it at half the cache TTL (every 6 hours).

It talks to the wxO Runs API directly, NOT through the proxy, so the
conversations it creates never enter the proxy's thread store and can never
appear in any user's sidebar. On the wxO side they accumulate under the
service identity, labeled by WARM_TEXT below; harmless and invisible to users.

Env (same secret the app uses): WO_API_KEY, WO_INSTANCE. Optional:
WARM_AGENT_KEYS (comma-separated registry keys; default = all in registry).

Run: python3 -m app.warm (the shim in app/warm.py; app.jobs.warm also works).
"""

import json
import os
import sys
import time
from pathlib import Path

import httpx

WARM_TEXT = "start"  # one ordinary opening turn; the tools it calls fill the cache
NOTE = "[cache-warmer]"  # printed on every log line so job logs are greppable
RUN_TIMEOUT_S = 150  # a cold fetch takes ~40-90s; beyond this move on


def main() -> int:
    base = os.environ["WO_INSTANCE"].rstrip("/") + "/v1/orchestrate"
    tok = httpx.post("https://iam.cloud.ibm.com/identity/token",
                     data={"grant_type": "urn:ibm:params:oauth:grant-type:apikey",
                           "apikey": os.environ["WO_API_KEY"]},
                     timeout=30).json()["access_token"]
    h = {"Authorization": f"Bearer {tok}"}

    # registry.json lives with the app package (app/registry.json), one level up.
    registry = json.loads(
        (Path(__file__).resolve().parent.parent / "registry.json").read_text())
    wanted = os.getenv("WARM_AGENT_KEYS", "")
    keys = [k.strip() for k in wanted.split(",") if k.strip()] or \
           [a["key"] for a in registry["agents"]]
    names = {a["key"]: a["wxo_agent_name"] for a in registry["agents"]}
    ids = {a.get("name"): a["id"]
           for a in httpx.get(f"{base}/agents", headers=h, timeout=30).json()}

    failures = 0
    for key in keys:
        name = names.get(key)
        agent_id = ids.get(name)
        if not agent_id:
            print(f"{NOTE} {key}: agent {name!r} not found, skipping")
            failures += 1
            continue
        t0 = time.time()
        r = httpx.post(f"{base}/runs", headers=h, timeout=60,
                       json={"message": {"role": "user", "content": WARM_TEXT},
                             "agent_id": agent_id}).json()
        run_id = r.get("run_id") or r.get("id")
        status = ""
        while time.time() - t0 < RUN_TIMEOUT_S:
            time.sleep(5)
            status = httpx.get(f"{base}/runs/{run_id}", headers=h,
                               timeout=30).json().get("status", "")
            if status in ("completed", "failed", "cancelled"):
                break
        took = time.time() - t0
        # A run stuck at "running" past the timeout still executed its tool
        # (the cache write happens inside the tool call), so count it warm.
        ok = status == "completed" or took >= RUN_TIMEOUT_S
        print(f"{NOTE} {key}: status={status or 'timeout'} in {took:.0f}s "
              f"({'warm' if ok else 'FAILED'})")
        failures += 0 if ok else 1
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
