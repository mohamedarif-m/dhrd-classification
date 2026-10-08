"""GET /api/pd-files — list and serve local Position Description files.

Lists .docx / .doc / .md files from data/IBM Classification Report Project/
that look like PDs (name contains "PD" or ends with a PD pattern), optionally
filtered by a search query.

GET /api/pd-files?q=accountant    → filtered list
GET /api/pd-files/read?name=...   → returns extracted_text for a file
"""

import io
import logging
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

log = logging.getLogger("tko.proxy")
router = APIRouter()

# Resolve folder: parents[5] = dhrd-classification-main in local dev.
# In the container the path is shallower — fall back gracefully.
_HERE = Path(__file__).resolve()
try:
    _REPO_ROOT = _HERE.parents[5]      # dhrd-classification-main (local dev)
except IndexError:
    _REPO_ROOT = _HERE.parent          # container: no local data dir
_PD_DIR = _REPO_ROOT / "data" / "IBM Classification Report Project"

_SUPPORTED_EXT = {".docx", ".doc", ".md"}

# Only expose files whose stem contains "PD" (case-insensitive) or ends with " PD"
# This keeps Reports out of the picker.
_PD_PATTERN = re.compile(r"\bPD\b", re.IGNORECASE)


def _is_pd_file(path: Path) -> bool:
    return _PD_PATTERN.search(path.stem) is not None


def _list_files(query: str = "") -> list[dict]:
    if not _PD_DIR.is_dir():
        log.warning("PD dir not found: %s", _PD_DIR)
        return []
    q = query.strip().lower()
    results = []
    for f in sorted(_PD_DIR.iterdir()):
        if not f.is_file():
            continue
        if f.suffix.lower() not in _SUPPORTED_EXT:
            continue
        if not _is_pd_file(f):
            continue
        if q and q not in f.name.lower():
            continue
        results.append({
            "name": f.name,
            "ext": f.suffix.lstrip(".").lower(),
            "size_kb": round(f.stat().st_size / 1024, 1),
        })
    return results


@router.get("/api/pd-files")
def list_pd_files(q: str = Query(default="")) -> JSONResponse:
    return JSONResponse({"files": _list_files(q)})


@router.get("/api/pd-files/read")
def read_pd_file(name: str = Query(...)) -> JSONResponse:
    if re.search(r"[/\\]", name):
        raise HTTPException(400, "Invalid file name")
    path = (_PD_DIR / name).resolve()
    if not path.is_relative_to(_PD_DIR.resolve()):
        raise HTTPException(400, "Invalid file name")
    if not path.is_file():
        raise HTTPException(404, f"File not found: {name}")
    if path.suffix.lower() not in _SUPPORTED_EXT:
        raise HTTPException(415, "Unsupported file type")

    data = path.read_bytes()

    if path.suffix.lower() == ".md":
        return JSONResponse({"name": name,
                             "extracted_text": data.decode("utf-8", errors="replace").strip()})

    # .docx / .doc → markitdown
    try:
        from markitdown import MarkItDown
        result = MarkItDown().convert_stream(io.BytesIO(data), file_extension=path.suffix)
        text = (result.text_content or "").strip()
    except Exception as exc:  # noqa: BLE001
        log.warning("markitdown failed for %s: %s", name, exc)
        raise HTTPException(500, f"Could not extract text from {name}")

    return JSONResponse({"name": name, "extracted_text": text})
