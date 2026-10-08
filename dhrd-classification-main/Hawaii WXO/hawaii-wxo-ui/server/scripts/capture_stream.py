"""One-shot live stream capture against a deployed wxO agent (read-only turn).

Pins the exact run.step.* event payload shapes on this SaaS env (the dossier
flags them UNVERIFIED). Reads WO_API_KEY / WO_INSTANCE from an env file given
via TKO_ENV_FILE (never printed, never logged) and writes the raw NDJSON to
the path given as argv[2].

Usage:
    TKO_ENV_FILE=/path/to/.env python capture_stream.py JobReq_C /tmp/cap.ndjson \
        "I want to create a job requisition" [seconds]
"""

import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

IAM_URL = "https://iam.cloud.ibm.com/identity/token"


def load_env_file(path: str) -> dict:
    out = {}
    with open(path) as f:
        for line in f:
            m = re.match(r"\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)", line)
            if m:
                out[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return out


def mint_token(api_key: str) -> str:
    body = urllib.parse.urlencode(
        {"grant_type": "urn:ibm:params:oauth:grant-type:apikey", "apikey": api_key}
    ).encode()
    req = urllib.request.Request(
        IAM_URL, data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["access_token"]


def api(base: str, token: str, path: str):
    req = urllib.request.Request(
        base + path, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def main() -> None:
    agent_name = sys.argv[1]
    out_path = sys.argv[2]
    text = sys.argv[3]
    budget = float(sys.argv[4]) if len(sys.argv) > 4 else 60.0

    env = load_env_file(os.environ["TKO_ENV_FILE"])
    base = env["WO_INSTANCE"].rstrip("/") + "/v1/orchestrate"
    token = mint_token(env["WO_API_KEY"])

    agents = api(base, token, "/agents")
    if isinstance(agents, dict):
        agents = agents.get("data", agents.get("agents", []))
    match = [a for a in agents if a.get("name") == agent_name]
    if not match:
        print(f"agent {agent_name!r} not found; available names:")
        print(sorted(a.get("name") for a in agents))
        sys.exit(2)
    agent_id = match[0]["id"]
    print(f"agent {agent_name} id={agent_id}")

    body = {
        "message": {"role": "user", "content": text},
        "agent_id": agent_id,
    }
    if os.environ.get("THREAD_ID"):
        body["thread_id"] = os.environ["THREAD_ID"]
    payload = json.dumps(body).encode()
    url = base + "/runs?stream=true&multiple_content=true"
    req = urllib.request.Request(url, data=payload, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    })
    start = time.time()
    n = 0
    with urllib.request.urlopen(req, timeout=budget + 30) as resp, \
            open(out_path, "wb") as out:
        print("http", resp.status, dict(resp.headers).get("Content-Type"))
        while time.time() - start < budget:
            line = resp.readline()
            if not line:
                break
            out.write(line)
            n += 1
            s = line.decode("utf-8", "replace").strip()
            if s:
                try:
                    ev = json.loads(s[6:] if s.startswith("data: ") else s)
                    print(f"[{time.time()-start:6.1f}s] {ev.get('event')} "
                          f"({len(s)} bytes)")
                except Exception:
                    print(f"[{time.time()-start:6.1f}s] unparseable "
                          f"({len(s)} bytes): {s[:80]}")
    print(f"captured {n} lines in {time.time()-start:.1f}s -> {out_path}")


if __name__ == "__main__":
    main()
