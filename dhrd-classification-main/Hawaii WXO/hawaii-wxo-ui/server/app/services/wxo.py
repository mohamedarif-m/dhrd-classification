"""Allowlist upstream client for the wxO Runs API. The proxy exposes exactly
the operations the UI needs; agent ids resolve server-side from the registry
and never reach the browser."""

import asyncio
import json
import logging
import uuid
from typing import AsyncIterator

import httpx

from .token_service import TokenService

log = logging.getLogger("tko.wxo")


class WxoClient:
    def __init__(self, orchestrate_base: str, tokens: TokenService) -> None:
        self.base = orchestrate_base
        self._tokens = tokens
        self._http = httpx.AsyncClient(timeout=httpx.Timeout(15, read=600))
        # Resolved lazily on first use.
        self._agent_ids: dict[str, str] | None = None      # registry key -> agent uuid
        self._tool_names: dict[str, dict] | None = None    # tool name -> display data

    async def _headers(self) -> dict:
        token = await self._tokens.get()
        if token.startswith("ZenApiKey "):
            # For SaaS watsonx Orchestrate instances, pass the ZenApiKey in the Authorization header
            return {"Authorization": token}
        elif token.startswith("Bearer "):
            return {"Authorization": token}
        return {"Authorization": f"Bearer {token}"}

    async def _request(self, method: str, path: str, **kw) -> httpx.Response:
        """One forced-refresh retry on 401 (stale token), per the dossier."""
        resp = await self._http.request(method, self.base + path,
                                        headers=await self._headers(), **kw)
        if resp.status_code == 401:
            self._tokens.invalidate()
            resp = await self._http.request(method, self.base + path,
                                            headers=await self._headers(), **kw)
        resp.raise_for_status()
        return resp

    async def _get_json(self, path: str):
        return (await self._request("GET", path)).json()

    async def resolve_agents(self, registry: dict) -> dict[str, str]:
        """Map registry keys to live agent uuids by name (or pinned id)."""
        if self._agent_ids is not None:
            return self._agent_ids
        agents = await self._get_json("/agents")
        if isinstance(agents, dict):
            agents = agents.get("data", [])
        by_name = {a.get("name"): a.get("id") for a in agents}
        resolved: dict[str, str] = {}
        for entry in registry.get("agents", []):
            if entry.get("wxo_agent_id"):
                resolved[entry["key"]] = entry["wxo_agent_id"]
            elif entry.get("wxo_agent_name") in by_name:
                resolved[entry["key"]] = by_name[entry["wxo_agent_name"]]
        self._agent_ids = resolved
        return resolved

    async def tool_display(self) -> dict[str, dict]:
        """{tool name -> {display_name, description}} for thinking-copy tiers."""
        if self._tool_names is not None:
            return self._tool_names
        try:
            tools = await self._get_json("/tools")
            if isinstance(tools, dict):
                tools = tools.get("data", [])
            self._tool_names = {
                t["name"]: {"display_name": t.get("display_name"),
                            "description": t.get("description")}
                for t in tools if t.get("name")
            }
        except Exception:  # tool metadata is a nice-to-have, never fatal
            log.warning("tools fetch failed; falling back to prettified names")
            self._tool_names = {}
        return self._tool_names

    async def stream_run(self, payload: dict) -> AsyncIterator[str]:
        """POST /runs?stream=true and yield raw upstream lines (bare NDJSON,
        verified live 2026-07-30 - no data: prefix on this SaaS env).

        One forced-refresh retry on 401, same policy as _request: an idle
        proxy outlives the ~60min IAM token, and the FIRST call after idling
        is often a stream (live incident 2026-07-30: 401 -> user-visible
        'upstream stream error' with no retry)."""
        for attempt in (1, 2):
            headers = await self._headers()
            headers["Content-Type"] = "application/json"
            async with self._http.stream(
                # stream_timeout: the platform default is 60000ms, which KILLS
                # the run mid-tool on long turns (live incident 2026-07-31:
                # every submit/create turn ~60-120s died as run.failed while
                # short verify turns passed). 300s covers create + readback.
                "POST", f"{self.base}/runs?stream=true&multiple_content=true&stream_timeout=600000",
                headers=headers, json=payload,
            ) as resp:
                if resp.status_code == 401 and attempt == 1:
                    self._tokens.invalidate()
                    continue
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    yield line
                return

    async def run_to_completion(self, payload: dict, timeout_s: float = 180) -> dict:
        """Start a run and return only once it settles, server-side (no SSE
        relay): {"run_id", "thread_id", "status"}.

        Parses the stream exactly like main.relay, then falls back to status
        polling. The poll is REQUIRED, not defensive: live streams routinely
        break at 20-60s while the run keeps running server-side (incident
        2026-07-31), so stream death is never treated as failure here.
        """
        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout_s
        run_id: str | None = None
        thread_id: str | None = None
        status: str | None = None
        try:
            async for raw in self.stream_run(payload):
                line = (raw or "").strip()
                if not line:
                    continue
                if line.startswith("data: "):  # defensive; live env sends bare NDJSON
                    line = line[6:]
                try:
                    event = json.loads(line)
                except ValueError:
                    continue  # unparseable keepalive
                etype = event.get("event") or "unknown"
                data = event.get("data") or {}
                run_id = run_id or data.get("run_id")
                thread_id = thread_id or data.get("thread_id")
                if etype == "run.completed":
                    status = "completed"
                elif etype == "run.failed":
                    status = "failed"
        except (httpx.HTTPError, httpx.StreamError) as e:
            log.warning("run stream ended early: %s", type(e).__name__)

        # No explicit terminal event (stream died, or only a bare `done`):
        # the run itself is the truth source.
        delay = 3.0
        while status is None and run_id and loop.time() < deadline:
            try:
                body = await self.run_status(run_id)
            except httpx.HTTPError:
                body = {}
            if body.get("status") in ("completed", "failed", "cancelled"):
                status = body["status"]
                thread_id = thread_id or body.get("thread_id")
                break
            await asyncio.sleep(delay)
            delay = min(delay * 2, 15.0)

        if status is None:
            status = "timeout" if run_id else "unknown"
        return {"run_id": run_id, "thread_id": thread_id, "status": status}

    async def run_status(self, run_id: str) -> dict:
        return await self._get_json(f"/runs/{run_id}")

    async def cancel_run(self, run_id: str) -> dict:
        return (await self._request("POST", f"/runs/cancel/{run_id}")).json()

    async def thread_messages(self, thread_id: str) -> list[dict]:
        body = await self._get_json(f"/threads/{thread_id}/messages")
        return body.get("data", []) if isinstance(body, dict) else body

    async def patch_thread(self, thread_id: str, title: str) -> None:
        await self._request("PATCH", f"/threads/{thread_id}",
                            json={"title": title})

    async def upload(self, filename: str, data: bytes, text: str = "") -> list[dict]:
        """Multipart to upload-to-s3 (NO trailing slash on SaaS)."""
        meta = [{"fileName": filename, "invalid": False, "id": str(uuid.uuid4()),
                 "statusCode": 200, "uploadStatus": "uploading", "url": ""}]
        resp = await self._http.post(
            f"{self.base}/upload-to-s3",
            headers=await self._headers(),
            files={"files": (filename, data, "application/octet-stream")},
            data={"text": text, "fileMetaData": json.dumps(meta)},
        )
        resp.raise_for_status()
        return resp.json()

    async def aclose(self) -> None:
        await self._http.aclose()
