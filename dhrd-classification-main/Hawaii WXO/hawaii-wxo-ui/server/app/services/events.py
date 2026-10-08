"""Event/message sanitization for the browser.

Rules:
- Internal identifiers never reach the page: agent ids, tenant ids, service
  identity, run context. Registry keys are the only agent handle client-side.
- Thread history is slimmed: step_history (which repeats multi-hundred-KB tool
  payloads) is reduced to the tool names called plus the newest tool _meta
  (the form payload the renderer needs).
"""

import json
from typing import Any

CONTRACT_META_KEY = "tko/form-contract@v1"
RECEIPT_META_KEY = "tko/receipt@v1"

_DROP_KEYS = {
    "agent_id", "tenant_id", "wxo_tenant_id", "context",
    "created_by", "created_by_username", "assistant", "session_id",
}


def sanitize(obj: Any) -> Any:
    """Recursively drop internal-identifier keys from any event payload."""
    if isinstance(obj, dict):
        return {k: sanitize(v) for k, v in obj.items() if k not in _DROP_KEYS}
    if isinstance(obj, list):
        return [sanitize(v) for v in obj]
    return obj


def _meta_block(step_details: list, key: str) -> dict | None:
    """First tool_response _meta block in these details that carries `key`."""
    for detail in step_details:
        if detail.get("type") != "tool_response":
            continue
        content = detail.get("content")
        if not isinstance(content, str):
            continue
        try:
            parsed = json.loads(content)
        except ValueError:
            continue
        meta = parsed.get("_meta") if isinstance(parsed, dict) else None
        if isinstance(meta, dict) and key in meta:
            return meta
    return None


def extract_meta_key(step_details: list, key: str):
    """Value of _meta[key] from a tool_response, for side channels that ride
    the same extraction path as form contracts (options dump)."""
    meta = _meta_block(step_details, key)
    return meta.get(key) if meta else None


def slim_message(msg: dict) -> dict:
    """Reduce a thread message to what the renderer needs, sanitized."""
    content = msg.get("content")
    texts: list[str] = []
    if isinstance(content, str):
        texts = [content]
    elif isinstance(content, list):
        for item in content:
            if isinstance(item, dict) and item.get("response_type", "text") == "text":
                if item.get("text"):
                    texts.append(item["text"])

    meta = msg.get("_meta") if isinstance(msg.get("_meta"), dict) else None
    tools_called: list[str] = []
    step_meta = None
    for step in msg.get("step_history") or []:
        details = step.get("step_details") or []
        for d in details:
            if d.get("type") == "tool_calls":
                tools_called += [c.get("name") for c in d.get("tool_calls", [])
                                 if c.get("name")]
        # Contract metas AND receipt-only metas both matter to the renderer:
        # a submit turn's _meta carries only the receipt key, and dropping it
        # made reloaded threads lose their receipt cards (live 2026-08-04).
        found = (_meta_block(details, CONTRACT_META_KEY)
                 or _meta_block(details, RECEIPT_META_KEY))
        if found:
            step_meta = found  # keep the newest

    display = (msg.get("additional_properties") or {}).get("display_properties") or {}
    return sanitize({
        "id": msg.get("id"),
        "role": msg.get("role"),
        "created_on": msg.get("created_on"),
        "text": "\n\n".join(texts),
        "is_async": bool(display.get("is_async")),
        "tools_called": tools_called,
        "meta": meta or step_meta,
    })
