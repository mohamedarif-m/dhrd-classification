"""POST /api/pending-files  – register file attachments for the next chat turn.

The HRO upload zone uploads files to WXO S3 (/api/uploads) BEFORE the user
clicks "Classify PD". The proxy then needs to attach those files to the
runs API payload as WXO file content blocks (response_type: file).

This endpoint stores {client_id -> [files]} in process memory. The chat
route reads and clears the store on the next POST /api/chat for that client.

Storage is intentionally ephemeral — a server restart loses pending files,
but that is fine: the upload zone is shown again on a fresh thread.
"""

import logging

from fastapi import APIRouter, Header
from pydantic import BaseModel

from ..deps import client_id as validate_client_id

log = logging.getLogger("tko.proxy")

router = APIRouter()

# In-process store: client_id -> list of {url, name}
_pending: dict[str, list[dict]] = {}


class PendingFile(BaseModel):
    url: str = ""           # empty string is valid for library-sourced files
    name: str = ""
    extracted_text: str = ""  # server-extracted text from markitdown (may be empty)


class PendingFilesBody(BaseModel):
    files: list[PendingFile]


@router.post("/api/pending-files", status_code=204)
async def set_pending_files(
    body: PendingFilesBody,
    x_tko_client: str | None = Header(default=None),
):
    cid = validate_client_id(x_tko_client)
    _pending[cid] = [
        {"url": f.url, "name": f.name, "extracted_text": f.extracted_text}
        for f in body.files
    ]
    log.info("pending-files set: client=%s files=%s",
             cid, [f.name for f in body.files])


def pop_pending(client_id: str) -> list[dict]:
    """Return and clear any pending files for this client. Called by chat route."""
    return _pending.pop(client_id, [])
