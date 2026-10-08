"""POST /api/chat - the SSE relay of a live run, plus the run cancel button.

This is the subtle core of the proxy: it re-emits the upstream stream frame by
frame and, when that stream dies before a terminal event, falls into a recovery
ladder (poll the run, watch the thread for a fresh assistant message, and only
then decide completed / still-pending / failed). Read the comments inline
before changing anything here - each one records a live incident.
"""

import asyncio
import json
import logging
import re as _re


def _clean_extracted(text: str, max_chars: int) -> str:
    """Strip markdown noise and cap length to reduce token count.

    - Remove markdown table separator rows (|---|)
    - Strip bold/italic markers (**text** -> text)
    - Replace pipe chars with spaces
    - Collapse multiple spaces and blank lines
    - Truncate to max_chars at a word boundary
    """
    t = text.strip()
    t = _re.sub(r"^\|[-| :]+\|$", "", t, flags=_re.MULTILINE)
    t = _re.sub(r"\*{1,3}(.*?)\*{1,3}", r"\1", t)
    t = t.replace("|", " ")
    t = _re.sub(r"[ \t]{2,}", " ", t)
    t = _re.sub(r"\n{3,}", "\n\n", t)
    t = t.strip()
    if len(t) <= max_chars:
        return t
    cut = t.rfind(" ", 0, max_chars)
    return t[: cut if cut > max_chars // 2 else max_chars] + "\n[... truncated]"

import httpx
from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..config import settings
from ..deps import agent_id_for, client_id, own_or_404, require_live, store
from ..routes.pending_files import pop_pending
from ..services.events import sanitize
from ..services.threadstore import LANDED_TIMEOUT

log = logging.getLogger("tko.proxy")
router = APIRouter()

MAX_MESSAGE_CHARS = 100_000  # form-submit envelopes ride as user text
HEARTBEAT_S = 15
TERMINAL_EVENTS = {"done", "run.completed", "run.failed"}


class ChatBody(BaseModel):
    agent_key: str = Field(min_length=1, max_length=64)
    content: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)
    thread_id: str | None = Field(default=None, max_length=64)


@router.post("/api/chat")
async def chat(body: ChatBody, x_tko_client: str | None = Header(default=None)):
    owner = client_id(x_tko_client)
    wxo = require_live()
    agent_id = await agent_id_for(body.agent_key)
    if body.thread_id:
        await own_or_404(body.thread_id, owner)

    # When files are pending, delegate to the proxy-orchestrated classify pipeline.
    # The LLM orchestrator refuses tool calls on large inputs, so we orchestrate
    # the sub-agents directly here instead.
    pending = pop_pending(owner)
    log.info("chat turn: client=%s pending_files=%d content_preview=%.80r",
             owner, len(pending), body.content)
    if pending:
        from ..routes.classify import run_classify_pipeline  # avoid circular at module level
        return StreamingResponse(
            run_classify_pipeline(wxo, pending),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )
    content = body.content
    message: dict = {"role": "user", "content": content}
    payload: dict = {"message": message, "agent_id": agent_id}
    if body.thread_id:
        payload["thread_id"] = body.thread_id
    title_seed = body.content.strip().splitlines()[0][:80]
    is_new_thread = body.thread_id is None

    async def relay():
        run_id: str | None = None
        poll_tid: str | None = body.thread_id
        saw_terminal = False
        agen = wxo.stream_run(payload).__aiter__()
        try:
            while True:
                try:
                    line = await asyncio.wait_for(agen.__anext__(), timeout=HEARTBEAT_S)
                except asyncio.TimeoutError:
                    yield ": hb\n\n"
                    continue
                except StopAsyncIteration:
                    break
                line = line.strip()
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
                if etype == "run.started":
                    run_id = data.get("run_id")
                    tid = data.get("thread_id")
                    poll_tid = tid or poll_tid
                    if tid:
                        store.record(tid, owner, body.agent_key,
                                     title_seed if is_new_thread else "")
                        if is_new_thread:
                            # LANDED BARRIER (live incident 2026-09-11, two
                            # staging instances). The browser answers this very
                            # frame by calling GET /api/threads, and that GET
                            # can be served by the OTHER instance, whose
                            # read-through reads COS before this instance's PUT
                            # has landed: the new chat is missing from the
                            # sidebar and nothing ever asks again. So hold the
                            # frame until the row is actually shared. Costs one
                            # COS round trip (~100-300ms, up to 700ms under
                            # contention) on the FIRST turn of a new
                            # conversation only - follow-up turns never reach
                            # this branch. A single-instance deployment pays it
                            # too; there is no signal that would let the
                            # process know it is alone.
                            landed = await asyncio.to_thread(
                                store.wait_landed, tid, LANDED_TIMEOUT)
                            if not landed:
                                # Never block the reply on a sick COS: yield
                                # anyway and let the client-side retry cover it.
                                log.warning("thread %s did not land within %.1fs; "
                                            "yielding run.started anyway",
                                            tid, LANDED_TIMEOUT)
                if etype in TERMINAL_EVENTS:
                    saw_terminal = True
                out = json.dumps({"id": event.get("id"), "event": etype,
                                  "data": sanitize(data)})
                yield f"event: {etype}\ndata: {out}\n\n"
        except (httpx.HTTPError, httpx.StreamError) as e:
            # Do NOT synthesize failure here - fall through to the poll path.
            log.error("upstream stream error: %s", type(e).__name__)
        if not saw_terminal:
            # Stream died before a terminal event. The RUN usually continues
            # server-side (live incident 2026-07-31: streams broke at 20-60s
            # while creates completed at ~30-90s; a single too-early status
            # poll synthesized failure for runs that SUCCEEDED - requisitions
            # R0008328/R0008329 were created behind "run failed" screens).
            # Poll until the run genuinely settles, then deliver the REAL
            # result including the final message.
            status: dict = {}
            final_msg: dict | None = None
            if run_id:
                loop = asyncio.get_event_loop()
                deadline = loop.time() + settings.run_poll_deadline_s
                # Two clocks: the THREAD is checked every fast tick (cheap GET,
                # and it is the truth source), while run-status calls back off
                # on their own schedule (they are heavier and can lie).
                tick = 2.0
                status_delay = 3.0
                status_due = loop.time()
                baseline_ids: set | None = None
                while loop.time() < deadline:
                    if loop.time() >= status_due:
                        try:
                            status = await wxo.run_status(run_id)
                        except httpx.HTTPError:
                            status = {}
                        status_due = loop.time() + status_delay
                        status_delay = min(status_delay * 1.5, 15.0)
                    if status.get("status") in ("completed", "failed", "cancelled"):
                        break
                    # ZOMBIE-RUN ESCAPE (live incident 2026-08-04): a run can
                    # stay status=running FOREVER after its work and final
                    # message completed (the OTP submit wrote its receipt and
                    # "pending approval" text while the run never went
                    # terminal). The run status lies; the THREAD is the truth
                    # source. Any assistant message that appears after polling
                    # began is this turn's real result - deliver it and stop.
                    if poll_tid:
                        try:
                            msgs = await wxo.thread_messages(poll_tid)
                        except httpx.HTTPError:
                            msgs = []
                        ids = {str(m.get("id")) for m in msgs}
                        if baseline_ids is None:
                            baseline_ids = ids
                        else:
                            fresh = [m for m in msgs
                                     if str(m.get("id")) not in baseline_ids
                                     and m.get("role") == "assistant"]
                            if fresh:
                                final_msg = fresh[-1]
                                break
                    yield ": hb\n\n"
                    await asyncio.sleep(tick)
            if final_msg is not None:
                out = json.dumps({"event": "message.created",
                                  "data": sanitize({"message": final_msg})})
                yield f"event: message.created\ndata: {out}\n\n"
                yield ("event: run.completed\ndata: "
                       + json.dumps({"event": "run.completed",
                                     "data": sanitize({"run_id": run_id})}) + "\n\n")
            elif status.get("status") == "completed":
                msg = ((status.get("result") or {}).get("data") or {}).get("message")
                if msg:
                    out = json.dumps({"event": "message.created",
                                      "data": sanitize({"message": msg})})
                    yield f"event: message.created\ndata: {out}\n\n"
                yield ("event: run.completed\ndata: "
                       + json.dumps({"event": "run.completed",
                                     "data": sanitize({"run_id": run_id})}) + "\n\n")
            elif status.get("status") in ("running", "queued"):
                # Machine-readable hand-off FIRST: the client reacts to
                # run.pending by enveloping the review's checkTool (the
                # agent-driven submit check); the text note below stays as
                # the human-readable fallback.
                yield ("event: run.pending\ndata: "
                       + json.dumps({"event": "run.pending",
                                     "data": sanitize({"run_id": run_id})}) + "\n\n")
                # STILL RUNNING at the poll deadline is NOT a failure (live
                # incident 2026-08-04: a create run took >10 min; the failure
                # screen invited a resubmit and a near-duplicate). Say so
                # honestly and end the stream - the thread shows the real
                # outcome on reload, and the tool-side duplicate guard
                # backstops a resubmit.
                note = {"role": "assistant", "content": [{
                    "response_type": "text",
                    "text": "Workday is still processing this request - it is "
                            "taking longer than usual. Reopen this chat in a "
                            "minute or two to see the result. Do not submit "
                            "again."}]}
                yield ("event: message.created\ndata: "
                       + json.dumps({"event": "message.created",
                                     "data": sanitize({"message": note})}) + "\n\n")
            else:
                yield ("event: run.failed\ndata: "
                       + json.dumps({"event": "run.failed",
                                     "data": sanitize(status or {"error": "stream lost"})}) + "\n\n")
            yield 'event: done\ndata: {"event": "done", "data": {}}\n\n'

    return StreamingResponse(relay(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


@router.post("/api/runs/{run_id}/cancel")
async def cancel_run(run_id: str,
                     x_tko_client: str | None = Header(default=None)) -> dict:
    client_id(x_tko_client)
    wxo = require_live()
    try:
        result = await wxo.cancel_run(run_id)
    except httpx.HTTPError:
        raise HTTPException(502, "Upstream cancel failed")
    return sanitize(result)
