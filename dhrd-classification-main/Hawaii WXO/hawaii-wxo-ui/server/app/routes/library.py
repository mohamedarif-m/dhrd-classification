"""GET /api/library — unified file library for HRO classification.

Endpoints
---------
GET /api/library/folders
    Returns all sub-directories of data/ that the user can choose from.

GET /api/library/files?folder=<name>&q=<query>
    Lists supported files inside a chosen folder, filtered by query.
    Supported extensions depend on the folder's intended role but we
    expose all .pdf / .docx / .doc / .md files regardless.

GET /api/library/read?folder=<name>&name=<filename>
    Returns extracted_text for a specific file.
"""

import io
import logging
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

log = logging.getLogger("tko.proxy")
router = APIRouter()

# dhrd-classification-main is at parents[5] of this file in local dev.
# In the container the path is shallower — fall back gracefully so routes
# return empty lists instead of crashing at import.
_HERE = Path(__file__).resolve()
try:
    _REPO_ROOT = _HERE.parents[5]
except IndexError:
    _REPO_ROOT = _HERE.parent   # container: no local data dir
_DATA_DIR = _REPO_ROOT / "data"

_SUPPORTED_EXT = {".pdf", ".docx", ".doc", ".md"}


def _safe_folder(folder: str) -> Path:
    """Resolve and validate a folder name — must be a direct child of _DATA_DIR."""
    if not folder or re.search(r"[/\\]", folder):
        raise HTTPException(400, "Invalid folder name")
    path = (_DATA_DIR / folder).resolve()
    if not path.is_relative_to(_DATA_DIR.resolve()):
        raise HTTPException(400, "Invalid folder name")
    if not path.is_dir():
        raise HTTPException(404, f"Folder not found: {folder}")
    return path


def _safe_file(folder_path: Path, name: str) -> Path:
    if not name or re.search(r"[/\\]", name):
        raise HTTPException(400, "Invalid file name")
    path = (folder_path / name).resolve()
    if not path.is_relative_to(folder_path.resolve()):
        raise HTTPException(400, "Invalid file name")
    if not path.is_file():
        raise HTTPException(404, f"File not found: {name}")
    if path.suffix.lower() not in _SUPPORTED_EXT:
        raise HTTPException(415, "Unsupported file type")
    return path


@router.get("/api/library/folders")
def list_folders() -> JSONResponse:
    """Return the list of choosable data sub-directories."""
    if not _DATA_DIR.is_dir():
        return JSONResponse({"folders": []})
    folders = sorted(
        d.name for d in _DATA_DIR.iterdir()
        if d.is_dir() and not d.name.startswith(".")
    )
    return JSONResponse({"folders": folders})


@router.get("/api/library/files")
def list_files(
    folder: str = Query(...),
    q: str = Query(default=""),
) -> JSONResponse:
    """Return filtered file list for the given folder."""
    folder_path = _safe_folder(folder)
    query = q.strip().lower()
    results = []
    for f in sorted(folder_path.iterdir()):
        if not f.is_file():
            continue
        if f.suffix.lower() not in _SUPPORTED_EXT:
            continue
        if query and query not in f.name.lower():
            continue
        results.append({
            "name": f.name,
            "ext": f.suffix.lstrip(".").lower(),
            "size_kb": round(f.stat().st_size / 1024, 1),
        })
    return JSONResponse({"files": results})


@router.get("/api/library/read")
def read_file(
    folder: str = Query(...),
    name: str = Query(...),
) -> JSONResponse:
    """Return extracted text for a specific library file."""
    folder_path = _safe_folder(folder)
    path = _safe_file(folder_path, name)
    data = path.read_bytes()

    if path.suffix.lower() == ".md":
        return JSONResponse({
            "name": name,
            "extracted_text": data.decode("utf-8", errors="replace").strip(),
        })

    # PDF / DOCX / DOC → markitdown
    try:
        from markitdown import MarkItDown
        result = MarkItDown().convert_stream(
            io.BytesIO(data), file_extension=path.suffix
        )
        text = (result.text_content or "").strip()
    except Exception as exc:  # noqa: BLE001
        log.warning("markitdown failed for %s/%s: %s", folder, name, exc)
        raise HTTPException(500, f"Could not extract text from {name}")

    return JSONResponse({"name": name, "extracted_text": text})
