"""POST /api/classify  — proxy-side HRO classification pipeline.

Instead of sending the full document text to the LLM orchestrator (which
refuses to make tool calls on large inputs), the proxy orchestrates the
pipeline directly:

  1. Call hro_pd_agent  with PD inline text  → get PD extraction JSON
  2. Call hro_class_spec_agent with CS inline text → get class spec extraction JSON
  3. Call hro_classifier_agent with both extractions → get Analysis prose
  4. Stream the final result back as SSE (same format as /api/chat)

Each sub-agent call is a fresh WXO run with a short, focused message.
The client sees the same SSE event stream as a normal chat turn.
"""

import asyncio
import json
import logging

import httpx
from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..deps import client_id, require_live
from ..routes.pending_files import pop_pending
from ..services.events import sanitize
from ..routes.chat import _clean_extracted

log = logging.getLogger("tko.proxy")
router = APIRouter()

# Registry key → WXO agent name (resolved on first call via live agents list)
_AGENT_NAMES = {
    "hro_pd_agent":          "hro_pd_agent",
    "hro_class_spec_agent":  "hro_class_spec_agent",
    "hro_classifier_agent":  "hro_classifier_agent",
}
_resolved_ids: dict[str, str] = {}

# Char limits per sub-agent call (~100K chars limit for 100K context window)
_PD_MAX_CHARS = 40_000
_CS_MAX_CHARS = 100_000

HEARTBEAT_S = 15
TERMINAL_EVENTS = {"done", "run.completed", "run.failed"}


class ClassifyBody(BaseModel):
    agent_key: str = Field(min_length=1, max_length=64)
    thread_id: str | None = Field(default=None, max_length=64)


async def _resolve_agent_id(wxo, name: str) -> str:
    """Resolve a WXO agent name to its live UUID (cached process-wide)."""
    if name in _resolved_ids:
        return _resolved_ids[name]
    try:
        agents = await wxo._get_json("/agents")
    except httpx.HTTPStatusError as e:
        log.error("Failed to fetch agents HTTP %s: %s", e.response.status_code, e.response.text)
        raise HTTPException(502, f"watsonx Orchestrate returned HTTP {e.response.status_code} when listing agents: {e.response.text}")
    except httpx.HTTPError as e:
        log.error("Failed to connect to watsonx Orchestrate: %s", e)
        raise HTTPException(502, f"Could not reach watsonx Orchestrate: {e}")

    if isinstance(agents, dict):
        agents = agents.get("data", [])
    by_name = {a.get("name"): a.get("id") for a in agents}
    for n in _AGENT_NAMES.values():
        if n in by_name:
            _resolved_ids[n] = by_name[n]
    if name not in _resolved_ids:
        available = ", ".join(by_name.keys())
        raise HTTPException(502, f"Agent '{name}' not found in WXO instance. Available agents: [{available}]")
    return _resolved_ids[name]


async def _run_to_text(wxo, agent_id: str, message: str, label: str) -> str:
    """Run a single WXO agent synchronously and return its text response.

    Streams the run to completion, collecting the assistant message text.
    Returns the text on success, raises HTTPException on failure.
    """
    payload = {
        "message": {"role": "user", "content": message},
        "agent_id": agent_id,
    }
    text_parts: list[str] = []
    delta_parts: list[str] = []  # accumulate streaming delta tokens
    run_id: str | None = None
    saw_terminal = False

    try:
        async for raw in wxo.stream_run(payload):
            line = (raw or "").strip()
            if not line:
                continue
            if line.startswith("data: "):
                line = line[6:]
            try:
                event = json.loads(line)
            except ValueError:
                continue
            etype = event.get("event") or "unknown"
            data = event.get("data") or {}
            if etype == "run.started":
                run_id = data.get("run_id") or run_id
            elif etype == "message.delta":
                # Streaming token-by-token response (most WXO agents use this)
                delta = data.get("delta", {})
                content = delta.get("content", "")
                if isinstance(content, list):
                    for blk in content:
                        if isinstance(blk, dict) and blk.get("text"):
                            delta_parts.append(blk["text"])
                elif isinstance(content, str) and content:
                    delta_parts.append(content)
            elif etype == "message.created":
                # Non-streaming full-response fallback
                msg = data.get("message", {})
                content = msg.get("content", "")
                if isinstance(content, list):
                    for blk in content:
                        if isinstance(blk, dict) and blk.get("text"):
                            text_parts.append(blk["text"])
                elif isinstance(content, str) and content:
                    text_parts.append(content)
            elif etype in TERMINAL_EVENTS:
                saw_terminal = True
    except (httpx.HTTPError, httpx.StreamError) as e:
        log.warning("%s: stream error: %s", label, type(e).__name__)

    # Prefer assembled delta stream; fall back to message.created
    if delta_parts:
        text_parts = ["".join(delta_parts)]

    if not saw_terminal and run_id:
        # Poll for completion if stream died early
        loop = asyncio.get_event_loop()
        deadline = loop.time() + 300
        delay = 3.0
        while loop.time() < deadline:
            try:
                status = await wxo.run_status(run_id)
            except httpx.HTTPError:
                status = {}
            st = status.get("status")
            if st == "completed":
                msg = ((status.get("result") or {}).get("data") or {}).get("message", {})
                content = msg.get("content", "")
                if isinstance(content, list):
                    for blk in content:
                        if isinstance(blk, dict) and blk.get("text"):
                            text_parts.append(blk["text"])
                elif isinstance(content, str) and content:
                    text_parts.append(content)
                break
            elif st in ("failed", "cancelled"):
                break
            await asyncio.sleep(delay)
            delay = min(delay * 1.5, 15.0)

    result = "\n".join(text_parts).strip()
    log.info("%s: got %d chars", label, len(result))
    return result


async def run_classify_pipeline(wxo, pending: list[dict]):
    """Async generator yielding SSE lines for the full classification pipeline.

    Called directly by /api/chat when pending files are present, bypassing the
    LLM orchestrator which fails on large input messages.
    """
    # The frontend always sends exactly two files in order: [PD, CS].
    # Use positional assignment — never guess by extension — so that two .md
    # files (both PD and CS from the library) are always correctly separated.
    _PD_EXT = {".docx", ".doc", ".md"}
    _CS_EXT = {".pdf", ".md"}

    if len(pending) < 2:
        yield _sse("message.created", {
            "message": {"role": "assistant",
                        "content": [{"response_type": "text",
                                     "text": "Please upload both a Position Description and a Class Specification before classifying."}]}
        })
        yield _sse("run.completed", {})
        yield _sse("done", {})
        return

    pd_file = pending[0]   # always PD (sent first by HROWorkspace)
    cs_file = pending[1]   # always CS (sent second)

    # Validate extensions so a user can't accidentally swap files
    pd_ext = "." + (pd_file.get("name") or "").rsplit(".", 1)[-1].lower()
    cs_ext = "." + (cs_file.get("name") or "").rsplit(".", 1)[-1].lower()

    if pd_ext not in _PD_EXT:
        yield _sse("message.created", {
            "message": {"role": "assistant",
                        "content": [{"response_type": "text",
                                     "text": f"Position Description must be .docx, .doc, or .md (got {pd_ext}). Please re-upload."}]}
        })
        yield _sse("run.completed", {})
        yield _sse("done", {})
        return

    if cs_ext not in _CS_EXT:
        yield _sse("message.created", {
            "message": {"role": "assistant",
                        "content": [{"response_type": "text",
                                     "text": f"Class Specification must be .pdf or .md (got {cs_ext}). Please re-upload."}]}
        })
        yield _sse("run.completed", {})
        yield _sse("done", {})
        return

    pd_name = pd_file.get("name") or "position_description.docx"
    pd_text = _clean_extracted(pd_file.get("extracted_text") or "", _PD_MAX_CHARS)
    cs_name = cs_file.get("name") or "class_specification.pdf"
    cs_text = _clean_extracted(cs_file.get("extracted_text") or "", _CS_MAX_CHARS)

    log.info("classify: pd=%s (%d chars), cs=%s (%d chars)",
             pd_name, len(pd_text), cs_name, len(cs_text))

    async def pipeline():
        # --- Resolve agent IDs ---
        try:
            pd_id = await _resolve_agent_id(wxo, "hro_pd_agent")
            cs_id = await _resolve_agent_id(wxo, "hro_class_spec_agent")
            clf_id = await _resolve_agent_id(wxo, "hro_classifier_agent")
        except HTTPException as e:
            yield _sse("run.failed", {"error": str(e.detail)})
            yield _sse("done", {})
            return

        # --- Step 1: PD extraction ---
        yield _sse("run.step.intermediate", {
            "message": {"content": [{"text": "Extracting Position Description…"}]}
        })
        pd_msg = (
            f"Extract the duties and responsibilities from the following Position "
            f"Description. The full document text is provided inline below. "
            f"Use ONLY this text — do not look for uploaded files.\n\n"
            f"=== POSITION DESCRIPTION FILE: {pd_name} ===\n"
            f"{pd_text}\n"
            f"=== END OF {pd_name} ==="
        )
        yield ": hb\n\n"
        pd_extraction = await _run_to_text(wxo, pd_id, pd_msg, "hro_pd_agent")
        if not pd_extraction or '"error"' in pd_extraction[:100]:
            yield _sse("message.created", {
                "message": {
                    "role": "assistant",
                    "content": [{"response_type": "text",
                                 "text": f'The Position Description could not be processed. '
                                         f'Error: {pd_extraction[:200] or "empty response"}. '
                                         f'Please re-upload and try again.'}]
                }
            })
            yield _sse("run.completed", {})
            yield _sse("done", {})
            return

        # --- Step 2: Class Spec extraction ---
        yield _sse("run.step.intermediate", {
            "message": {"content": [{"text": "Extracting Class Specification…"}]}
        })
        cs_msg = (
            f"Extract all class levels, series metadata, and distinguishing "
            f"characteristics from the following Class Specification. "
            f"The full document text is provided inline below. "
            f"Use ONLY this text — do not look for uploaded files.\n\n"
            f"=== CLASS SPECIFICATION FILE: {cs_name} ===\n"
            f"{cs_text}\n"
            f"=== END OF {cs_name} ==="
        )
        yield ": hb\n\n"
        cs_extraction = await _run_to_text(wxo, cs_id, cs_msg, "hro_class_spec_agent")
        if not cs_extraction or '"error"' in cs_extraction[:100]:
            yield _sse("message.created", {
                "message": {
                    "role": "assistant",
                    "content": [{"response_type": "text",
                                 "text": f'The Class Specification could not be processed. '
                                         f'Please re-upload and try again.'}]
                }
            })
            yield _sse("run.completed", {})
            yield _sse("done", {})
            return

        # --- Step 3: Classification ---
        yield _sse("run.step.intermediate", {
            "message": {"content": [{"text": "Generating classification analysis…"}]}
        })
        clf_msg = (
            f"pd_data:\n{pd_extraction}\n\n"
            f"class_spec_data:\n{cs_extraction}"
        )
        yield ": hb\n\n"
        analysis = await _run_to_text(wxo, clf_id, clf_msg, "hro_classifier_agent")

        if not analysis:
            # Retry once
            log.warning("classifier returned empty — retrying")
            yield ": hb\n\n"
            analysis = await _run_to_text(wxo, clf_id, clf_msg, "hro_classifier_agent retry")

        if not analysis:
            yield _sse("message.created", {
                "message": {
                    "role": "assistant",
                    "content": [{"response_type": "text",
                                 "text": "The classifier did not produce a complete Analysis "
                                         "section. Please enter 'Classify PD' to retry."}]
                }
            })
        else:
            yield _sse("message.created", {
                "message": sanitize({
                    "role": "assistant",
                    "content": [{"response_type": "text", "text": analysis}]
                })
            })

        yield _sse("run.completed", {})
        yield _sse("done", {})

    async for chunk in pipeline():
        yield chunk


@router.post("/api/classify")
async def classify(body: ClassifyBody,
                   x_tko_client: str | None = Header(default=None)):
    """Proxy-orchestrated HRO classification pipeline (direct SSE endpoint)."""
    owner = client_id(x_tko_client)
    wxo = require_live()
    pending = pop_pending(owner)
    if not pending:
        raise HTTPException(400, "No files registered — call /api/pending-files first")
    return StreamingResponse(
        run_classify_pipeline(wxo, pending),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps({'event': event, 'data': data})}\n\n"
