"""Options side channel: full reference lists too big to ride in a form.

The (agent, source) pair is an allowlist read from the registry, never a free
parameter the browser can steer - an unknown one is a 404.
"""

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from ..deps import client_id, registry, require_options, spawn
from ..services.events import sanitize
from ..services.registry import resolve_agent

router = APIRouter()


class OptionsRefreshBody(BaseModel):
    agent_key: str = Field(min_length=1, max_length=64)


def _options_allowlist(agent_key: str) -> dict:
    # Unknown agent and unknown source are both 404: the source name is an
    # allowlist, never a free parameter the browser can steer.
    entry = resolve_agent(registry, agent_key)
    if entry is None:
        raise HTTPException(404, "Unknown agent")
    sources = entry.get("option_sources")
    return sources if isinstance(sources, dict) else {}


@router.get("/api/options")
async def get_options(agent_key: str, source: str, refresh: bool = False,
                      x_tko_client: str | None = Header(default=None)) -> dict:
    client_id(x_tko_client)
    if source not in _options_allowlist(agent_key):
        raise HTTPException(404, "Unknown options source")
    service = require_options()
    # `refresh=1` is the form engine saying it REFUSED the rows it was served
    # because they did not match the columns its contract declares (stale rows
    # from an older tool build). The service drops that payload and refetches,
    # under its ordinary retry throttle - see OptionsService.get.
    # Reference data (names and ids), sanitized like every other payload.
    return sanitize(await service.get(agent_key, source, refresh=refresh))


@router.post("/api/options/refresh")
async def refresh_options(body: OptionsRefreshBody,
                          x_tko_client: str | None = Header(default=None)) -> dict:
    client_id(x_tko_client)
    _options_allowlist(body.agent_key)
    service = require_options()
    spawn(service.refresh(body.agent_key))
    return {"status": "refreshing"}
