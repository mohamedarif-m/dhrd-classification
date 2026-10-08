"""Headless live driver for the custom UI path.

Talks to the RUNNING proxy exactly like the browser does - same /api/chat
SSE, same [[TKO_FORM_SUBMIT]] envelopes, same contract extraction - so the
full agent -> tools -> Workday -> proxy loop is exercised programmatically.
Chrome stays for visual checks only; this is the fast regression loop.

Usage (proxy must be up on :8080 in live mode):
    .venv/bin/python scripts/live_driver.py warn      # UK location + USD -> expect
                                                   # review WARNINGS; NO create
    .venv/bin/python scripts/live_driver.py create    # clean US data -> REAL create
                                                   # (dev tenant; title says
                                                   # "please rescind")

MONEY GUARD: only the explicit 'create' mode ever sends the create token, and
its requisition title always carries 'please rescind'.
"""

import json
import re
import sys
import time
import urllib.request
import uuid

BASE = "http://localhost:8080/api"
CLIENT = "livedriver" + uuid.uuid4().hex[:8]
CONTRACT_KEY = "tko/form-contract@v1"
VERDICT_KEY = "tko/verify-verdict@v1"
RECEIPT_KEY = "tko/receipt@v1"


def chat(content, thread_id=None, timeout=240):
    """POST /api/chat and consume the SSE stream; returns (thread_id, metas,
    texts) where metas is every _meta dict seen (newest last)."""
    body = {"agent_key": "jobreq", "content": content}
    if thread_id:
        body["thread_id"] = thread_id
    req = urllib.request.Request(
        f"{BASE}/chat", data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "X-TKO-Client": CLIENT})
    metas, texts, tid = [], [], thread_id
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        for raw in resp:
            if time.time() - t0 > timeout:
                break
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data: "):
                continue
            try:
                ev = json.loads(line[6:])
            except ValueError:
                continue
            data = ev.get("data") or {}
            tid = tid or data.get("thread_id")
            # metas ride tool_response content inside step deltas AND the
            # final message - scan both, exactly like the browser does.
            blobs = []
            delta = data.get("delta") or {}
            for d in delta.get("step_details") or []:
                if d.get("type") == "tool_response" and isinstance(d.get("content"), str):
                    blobs.append(d["content"])
            msg = data.get("message") or {}
            if isinstance(msg, dict):
                if isinstance(msg.get("_meta"), dict):
                    metas.append(msg["_meta"])
                for step in msg.get("step_history") or []:
                    for d in step.get("step_details") or []:
                        if d.get("type") == "tool_response" and isinstance(d.get("content"), str):
                            blobs.append(d["content"])
                content_list = msg.get("content")
                if isinstance(content_list, list):
                    for c in content_list:
                        if isinstance(c, dict) and c.get("text"):
                            texts.append(c["text"])
            for blob in blobs:
                try:
                    parsed = json.loads(blob)
                    if isinstance(parsed.get("_meta"), dict):
                        metas.append(parsed["_meta"])
                except ValueError:
                    pass
            if ev.get("event") in ("done", "run.failed"):
                if ev.get("event") == "run.failed":
                    raise SystemExit(f"RUN FAILED: {json.dumps(data)[:400]}")
                break
    return tid, metas, texts


def newest(metas, key):
    for meta in reversed(metas):
        if key in meta:
            return meta[key]
    return None


def field_map(contract):
    return {f["id"]: f for s in contract.get("sections", [])
            for f in s.get("fields", [])}


def pick_table(field, needle):
    for row in field.get("rows", []):
        if needle.lower() in row["key"].lower():
            return row["key"]
    raise SystemExit(f"no table row matching {needle!r} in {field['id']}")


def pick_leaf(field, needle):
    """Depth-first hierarchy search for a leaf whose key matches needle."""
    stack = list(field.get("tree", []))
    while stack:
        node = stack.pop()
        kids = node.get("children")
        if kids:
            stack.extend(kids)
        elif needle.lower() in node["key"].lower():
            return node["key"]
    raise SystemExit(f"no leaf matching {needle!r} in {field['id']}")


def pick_option(field, needle):
    for o in field.get("options", []):
        if needle.lower() in o["key"].lower():
            return o["key"]
    raise SystemExit(f"no option matching {needle!r} in {field['id']}")


def envelope(tool, args):
    return "[[TKO_FORM_SUBMIT]] " + json.dumps({"tool": tool, "args": args})


def main(mode):
    today = time.strftime("%Y-%m-%d")
    plus = lambda d: time.strftime("%Y-%m-%d", time.localtime(time.time() + d * 86400))

    print(f"[1] start -> entry form (mode={mode})")
    tid, metas, _ = chat("start")
    entry = newest(metas, CONTRACT_KEY)
    assert entry and entry["id"].startswith("jobreq"), "no entry contract"
    f = field_map(entry)
    assert f["sup_org"].get("optionsSource", {}).get("source") == "sup-orgs", \
        "sup_org optionsSource missing"
    assert [l["id"] for l in f["sub_department"]["levels"]] == \
        ["division", "department", "sub_department"], "division level missing"
    req = [i for i, fl in f.items() if (fl.get("validation") or {}).get("required")]
    for must in ("job_description", "justification", "company", "business_unit",
                 "primary_posting_location", "base_pay_plan_type"):
        assert must in req, f"{must} not marked required"
    print(f"    entry OK: {len(f)} fields, {len(req)} required, "
          f"today floor {entry.get('todayIso')}")

    location = "Orlando" if mode == "create" else "London"
    args = {
        "title": f"E2E {mode} test — please rescind (C1)",
        "job_description": "Headless driver verification run.",
        "justification": "Automated end-to-end check.",
        "openings": "1",
        "worker_type": pick_option(f["worker_type"], "Employee"),
        "employee_type": pick_option(f["employee_type"], "Regular"),
        "time_type": pick_option(f["time_type"], "Full"),
        "start_date": plus(7), "hire_date": plus(21),
        "sup_org": pick_table(f["sup_org"], "Test Sup Org 1 ("),
        "sub_department": pick_leaf(f["sub_department"], "SUBDEPT_SSaccounting"),
        "company": pick_option(f["company"], "World Wrestling Entertainment, LLC"),
        "business_unit": pick_option(f["business_unit"], "WWE (BU"),
        "job_profile": pick_table(f["job_profile"], "(JOB004-Acco)"),
        "location": pick_leaf(f["location"], location),
        "primary_posting_location": pick_leaf(f["primary_posting_location"], location),
        "base_pay_plan_type": "Salary",
        "base_pay_amount": "90000",
        "base_pay_currency": pick_option(f["base_pay_currency"], "USD"),
        "base_pay_frequency": pick_option(f["base_pay_frequency"], "Annual"),
    }

    print("[2] envelope -> jrc_validate")
    tid, metas, _ = chat(envelope("jrc_validate", args), tid)
    verdict = newest(metas, VERDICT_KEY)
    assert verdict, "no verdict meta"
    if not verdict.get("ok"):
        raise SystemExit("validate FAILED: "
                         + json.dumps(verdict.get("fixes"))[:400])
    review = newest(metas, CONTRACT_KEY)
    assert review and review.get("review"), "no review contract after validate"
    warns = (review["review"].get("warnings") or [])
    print(f"    verdict ok; review rendered; warnings={len(warns)}")
    for w in warns:
        print("      WARN:", w["message"][:110])

    if mode == "warn":
        assert warns, "expected a coherence warning for the UK+USD scenario"
        assert any("GBP" in w["message"] for w in warns), "GBP not named"
        print("[3] warn mode stops at the review - nothing created. PASS")
        return

    assert not warns, f"clean US data should have no warnings, got {warns}"
    print("[3] confirm -> jrc_submit (REAL create, dev tenant)")
    args2 = dict(args)
    args2["confirm_action"] = review["review"]["confirmTokens"]["submit"]
    tid, metas, texts = chat(envelope("jrc_submit", args2), tid, timeout=300)
    receipt = newest(metas, RECEIPT_KEY)
    assert receipt, "no receipt meta"
    if not receipt.get("created"):
        raise SystemExit("create did NOT happen: " + json.dumps(receipt)[:300])
    final = "\n".join(texts)[-500:]
    print("    CREATED. Receipt:", json.dumps(receipt)[:200])
    print("    Final text tail:", final.replace("\n", " | ")[:300])
    print("PASS")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "warn"
    assert mode in ("warn", "create"), "mode must be warn|create"
    main(mode)
