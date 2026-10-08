"""POST /api/uploads - multipart passthrough to the wxO upload-to-s3 endpoint.

Extension allowlist plus a hard size cap; the file itself is never written to
disk on this side.

For HRO classification files (.docx / .pdf / .md) the text content is also
extracted server-side via markitdown (or direct read for .md) and returned in
`extracted_text` so the chat route can embed it directly in the WXO message.
"""

import io
import logging
from pathlib import Path

import httpx
from fastapi import APIRouter, Header, HTTPException, UploadFile

from ..deps import client_id, require_live
from ..services.events import sanitize

log = logging.getLogger("tko.proxy")
router = APIRouter()

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
ALLOWED_UPLOAD_EXT = {"csv", "doc", "docx", "jpeg", "jpg", "md", "pdf", "png",
                      "txt", "wav", "xls", "xlsx", "xlsm", "ppt", "pptx"}

# Extensions for which we attempt server-side text extraction
_EXTRACT_EXT = {"pdf", "docx", "doc", "md"}


def _extract_text(filename: str, data: bytes) -> str | None:
    """Return plain-text content for PDF/DOCX/MD files.

    .md files are returned as-is (already plain text).
    PDF/DOCX go through markitdown.
    Returns None on any failure so the upload itself always succeeds.
    """
    ext = Path(filename).suffix.lstrip(".").lower()
    if ext == "md":
        try:
            return data.decode("utf-8", errors="replace").strip() or None
        except Exception as exc:  # noqa: BLE001
            log.warning("md decode failed for %s: %s", filename, exc)
            return None
    try:
        from markitdown import MarkItDown  # lazy import — optional dependency
    except ImportError:
        log.warning("markitdown not installed; skipping text extraction for %s", filename)
        return None
    try:
        result = MarkItDown().convert_stream(io.BytesIO(data), file_extension=Path(filename).suffix)
        return (result.text_content or "").strip() or None
    except Exception as exc:  # noqa: BLE001
        log.warning("markitdown extraction failed for %s: %s", filename, exc)
        return None


@router.post("/api/uploads")
async def upload(file: UploadFile,
                 x_tko_client: str | None = Header(default=None)) -> dict:
    client_id(x_tko_client)
    wxo = require_live()
    fname = file.filename or "upload"
    ext = Path(fname).suffix.lstrip(".").lower()
    if ext not in ALLOWED_UPLOAD_EXT:
        raise HTTPException(415, "File type not allowed")
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "File too large")

    # .md files are plain text — skip the WXO S3 upload entirely.
    # The classify pipeline reads only extracted_text, never the S3 url,
    # so there is nothing to store upstream.
    if ext == "md":
        text = _extract_text(fname, data)
        if not text:
            raise HTTPException(422, "Could not read markdown file")
        log.info("md shortcut: %d chars from %s (no S3 upload)", len(text), fname)
        return {
            "files": [{"url": "", "fileName": fname}],
            "extracted_text": text,
        }

    try:
        result = await wxo.upload(fname, data)
    except httpx.HTTPError:
        raise HTTPException(502, "Upstream upload failed")

    response: dict = {"files": sanitize(result)}

    # Attempt text extraction for document types the HRO agents need to read
    if ext in _EXTRACT_EXT:
        text = _extract_text(fname, data)
        if text:
            response["extracted_text"] = text
            log.info("extracted %d chars from %s", len(text), fname)

    return response
