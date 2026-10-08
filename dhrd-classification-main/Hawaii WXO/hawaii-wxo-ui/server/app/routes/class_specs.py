"""GET /api/class-specs — list and serve local class-spec files.

Lists .md and .pdf files from the data/class specs/ folder (resolved relative
to the repo root), optionally filtered by a search query.

GET /api/class-specs?q=accountant   → filtered list
GET /api/class-specs/read?name=ACCOUNTANT.md → returns extracted_text for a file
"""

import logging
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

log = logging.getLogger("tko.proxy")
router = APIRouter()

# Resolve the class specs folder: walk up from this file to the repo root.
# In local dev: class_specs.py -> routes -> app -> server -> hawaii-wxo-ui
#               -> "Hawaii WXO" -> dhrd-classification-main  (parents[5])
# In production (container): shallower path — gracefully fall back to a
# non-existent dir so the route returns [] without crashing at import.
_HERE = Path(__file__).resolve()
try:
    _REPO_ROOT = _HERE.parents[5]  # dhrd-classification-main (local dev)
except IndexError:
    _REPO_ROOT = _HERE.parent      # container: no local data dir
_CLASS_SPECS_DIR = _REPO_ROOT / "data" / "class specs"

_SUPPORTED_EXT = {".md", ".pdf"}


def _list_files(query: str = "") -> list[dict]:
    """Return a sorted list of {name, ext, size_kb} dicts."""
    if not _CLASS_SPECS_DIR.is_dir():
        log.warning("class specs dir not found: %s", _CLASS_SPECS_DIR)
        return []

    q = query.strip().lower()
    results = []
    for f in sorted(_CLASS_SPECS_DIR.iterdir()):
        if not f.is_file():
            continue
        if f.suffix.lower() not in _SUPPORTED_EXT:
            continue
        if q and q not in f.name.lower():
            continue
        results.append({
            "name": f.name,
            "ext": f.suffix.lstrip(".").lower(),
            "size_kb": round(f.stat().st_size / 1024, 1),
        })
    return results


@router.get("/api/class-specs")
def list_class_specs(q: str = Query(default="")) -> JSONResponse:
    """Return a filtered list of class-spec files."""
    return JSONResponse({"files": _list_files(q)})


@router.get("/api/class-specs/read")
def read_class_spec(name: str = Query(...)) -> JSONResponse:
    """Return the text content of a named class-spec file.

    For .md files: raw UTF-8 text.
    For .pdf files: markitdown extraction.
    """
    # Sanitise: no path separators allowed
    if re.search(r"[/\\]", name):
        raise HTTPException(400, "Invalid file name")

    path = _CLASS_SPECS_DIR / name
    try:
        path = path.resolve()
    except Exception:
        raise HTTPException(400, "Invalid file name")

    if not path.is_relative_to(_CLASS_SPECS_DIR.resolve()):
        raise HTTPException(400, "Invalid file name")
    if not path.is_file():
        raise HTTPException(404, f"File not found: {name}")
    if path.suffix.lower() not in _SUPPORTED_EXT:
        raise HTTPException(415, "Unsupported file type")

    data = path.read_bytes()

    if path.suffix.lower() == ".md":
        text = data.decode("utf-8", errors="replace").strip()
        return JSONResponse({"name": name, "extracted_text": text})

    # PDF → markitdown
    import io
    try:
        from markitdown import MarkItDown
        result = MarkItDown().convert_stream(io.BytesIO(data), file_extension=path.suffix)
        text = (result.text_content or "").strip()
    except Exception as exc:  # noqa: BLE001
        log.warning("markitdown failed for %s: %s", name, exc)
        raise HTTPException(500, f"Could not extract text from {name}")

    return JSONResponse({"name": name, "extracted_text": text})
