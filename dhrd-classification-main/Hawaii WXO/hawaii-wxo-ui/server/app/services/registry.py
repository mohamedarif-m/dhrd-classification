"""Registry loading. The browser only ever sees the sanitized view."""

import json
from pathlib import Path

# Server-side keys stripped before anything leaves the process.
_PRIVATE_KEYS = {"wxo_agent_id", "wxo_agent_name", "option_sources"}


def load_registry(path: str) -> dict:
    return json.loads(Path(path).read_text())


def client_view(registry: dict) -> dict:
    view = {
        "agents": [
            {k: v for k, v in agent.items() if k not in _PRIVATE_KEYS}
            for agent in registry.get("agents", [])
        ]
    }
    # Branding is host configuration, not a secret: the shell needs it to paint
    # the chrome, so it goes to the browser as-is when present.
    branding = registry.get("branding")
    if branding is not None:
        view["branding"] = branding
    return view


def resolve_agent(registry: dict, key: str) -> dict | None:
    """Allowlist lookup: unknown keys resolve to nothing and are rejected."""
    for agent in registry.get("agents", []):
        if agent.get("key") == key:
            return agent
    return None
