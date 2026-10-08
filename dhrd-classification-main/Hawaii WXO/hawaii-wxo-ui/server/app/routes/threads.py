"""Thread routes: list this browser's threads, read slimmed history, rename.

Every route here is ownership-scoped - a thread that belongs to another
identity returns 404, never 403.
"""

import asyncio

import httpx
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from ..deps import client_id, own_or_404, require_live, store
from ..services.events import slim_message

router = APIRouter()


class RenameBody(BaseModel):
    title: str = Field(min_length=1, max_length=80)


@router.get("/api/threads")
async def list_threads(agent_key: str | None = None,
                       x_tko_client: str | None = Header(default=None)) -> dict:
    owner = client_id(x_tko_client)
    # `list_for` read-throughs to COS (throttled per owner) so the sidebar
    # shows threads created on another Code Engine instance. That read is
    # blocking, so it runs on a worker thread - same reasoning as own_or_404.
    threads = await asyncio.to_thread(store.list_for, owner, agent_key)
    return {"threads": threads}


@router.get("/api/threads/{thread_id}/messages")
async def thread_messages(thread_id: str,
                          x_tko_client: str | None = Header(default=None)) -> dict:
    owner = client_id(x_tko_client)
    await own_or_404(thread_id, owner)
    wxo = require_live()
    try:
        messages = await wxo.thread_messages(thread_id)
    except httpx.HTTPStatusError as e:
        raise HTTPException(e.response.status_code, "Upstream error")
    return {"messages": [slim_message(m) for m in messages]}


@router.patch("/api/threads/{thread_id}")
async def rename_thread(thread_id: str, body: RenameBody,
                        x_tko_client: str | None = Header(default=None)) -> dict:
    owner = client_id(x_tko_client)
    await own_or_404(thread_id, owner)
    wxo = require_live()
    try:
        await wxo.patch_thread(thread_id, body.title)
    except httpx.HTTPError:
        raise HTTPException(502, "Upstream rename failed")
    store.rename(thread_id, body.title)
    return {"thread_id": thread_id, "title": body.title}
