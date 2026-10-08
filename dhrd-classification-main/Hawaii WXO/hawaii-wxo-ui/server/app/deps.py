"""Process-wide singletons and the guards every route shares.

Built once at import from `settings`: the registry, the thread-ownership store
and - only when the proxy is configured for live mode - the wxO client and the
options service. Route modules import from here rather than from `app.main`, so
`main` stays a thin app factory and there is no import cycle.
"""

import asyncio
import logging

import httpx
from fastapi import HTTPException

from .config import settings
from .services.optionsvc import OptionsService
from .services.registry import load_registry, resolve_agent
from .services.threadstore import ThreadStore, cos_backend_from_settings
from .services.token_service import TokenService
from .services.wxo import WxoClient

log = logging.getLogger("tko.proxy")

registry: dict = load_registry(settings.registry_path)
store = ThreadStore(settings.data_dir, cos=cos_backend_from_settings(settings),
                    retention_days=settings.thread_retention_days)
wxo: WxoClient | None = None
options: OptionsService | None = None
if settings.configured:
    wxo = WxoClient(settings.orchestrate_base,
                    TokenService(settings.wxo_api_key, settings.iam_token_url))
    options = OptionsService(wxo, registry, store)

# Background tasks need a strong reference or the loop may collect them.
_bg_tasks: set[asyncio.Task] = set()


def spawn(coro) -> None:
    task = asyncio.create_task(coro)
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)


def client_id(x_tko_client: str | None) -> str:
    if not x_tko_client or not (8 <= len(x_tko_client) <= 64) \
            or not x_tko_client.replace("-", "").isalnum():
        raise HTTPException(400, "Missing or malformed X-TKO-Client identity")
    return x_tko_client


def require_live() -> WxoClient:
    if wxo is None:
        raise HTTPException(503, "Proxy is not configured for live mode "
                                 "(WO_INSTANCE / WO_API_KEY not set)")
    return wxo


def require_options() -> OptionsService:
    if options is None:
        raise HTTPException(503, "Proxy is not configured for live mode "
                                 "(WO_INSTANCE / WO_API_KEY not set)")
    return options


async def agent_id_for(key: str) -> str:
    client = require_live()
    if resolve_agent(registry, key) is None:
        raise HTTPException(404, "Unknown agent")
    try:
        resolved = await client.resolve_agents(registry)
    except httpx.HTTPStatusError as e:
        log.error("agent resolution failed HTTP %s: %s", e.response.status_code, e.response.text)
        raise HTTPException(502, f"watsonx Orchestrate returned HTTP {e.response.status_code}: {e.response.text}")
    except httpx.HTTPError as e:
        log.error("agent resolution failed (%s): %s", type(e).__name__, e)
        raise HTTPException(502, f"Could not reach watsonx Orchestrate ({type(e).__name__}: {e})")
    except RuntimeError as e:
        log.error("Authentication error: %s", e)
        raise HTTPException(401, str(e))
    if key not in resolved:
        raise HTTPException(502, f"Registry entry '{key}' did not resolve to a live agent")
    return resolved[key]


async def own_or_404(thread_id: str, owner: str) -> None:
    # 404 (not 403) so foreign thread ids are indistinguishable from absent ones.
    # `store.owns` read-throughs to COS on a miss before it answers False, so a
    # thread created on another Code Engine instance is not a spurious 404. That
    # read is blocking, so it runs on a worker thread: a slow COS must not stall
    # the event loop for every other request in flight.
    if not await asyncio.to_thread(store.owns, thread_id, owner):
        raise HTTPException(404, "Unknown thread")
