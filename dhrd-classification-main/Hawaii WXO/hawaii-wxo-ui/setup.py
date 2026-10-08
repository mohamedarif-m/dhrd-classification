#!/usr/bin/env python3
"""
setup.py — Makes hawaii-wxo-ui fully self-contained.

Run once from the hawaii-wxo-ui directory:
    python3 setup.py

What it does:
  1. Removes the broken packages/ui symlink (points at missing tko-pilot)
  2. Copies tko-pilot/tko-agents-ui/packages/ui/src → packages/ui/src
  3. Writes a packages/ui/package.json (name=wxo-custom-ui, src-only exports)
  4. Writes a packages/ui/tsconfig.json extending hawaii-wxo-ui root tsconfig
  5. Patches server/.venv if it exists (no-op otherwise)
  6. Prints next steps
"""
import os
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent  # hawaii-wxo-ui/
REPO_ROOT = HERE.parent.parent.parent   # dhrd-classification-main/
TKO_UI_SRC = REPO_ROOT / "tko-pilot" / "tko-agents-ui" / "packages" / "ui" / "src"
DEST = HERE / "packages" / "ui"

# ── 1. Verify source exists ───────────────────────────────────────────────────

if not TKO_UI_SRC.is_dir():
    print(f"ERROR: Cannot find tko-pilot source at:\n  {TKO_UI_SRC}")
    print("\nMake sure the tko-pilot folder is at:")
    print(f"  {REPO_ROOT / 'tko-pilot'}")
    sys.exit(1)

print(f"Source:      {TKO_UI_SRC}")
print(f"Destination: {DEST}")

# ── 2. Remove the broken symlink ──────────────────────────────────────────────

if DEST.is_symlink():
    print("\n[1/4] Removing broken symlink packages/ui …")
    DEST.unlink()
elif DEST.exists() and not DEST.is_dir():
    print("\n[1/4] Removing non-directory packages/ui …")
    os.remove(DEST)
elif DEST.is_dir():
    print("\n[1/4] packages/ui already a directory — clearing src/ only …")
    src_dir = DEST / "src"
    if src_dir.exists():
        shutil.rmtree(src_dir)
else:
    print("\n[1/4] packages/ui does not exist — will create …")

# ── 3. Copy src/ ──────────────────────────────────────────────────────────────

print("[2/4] Copying packages/ui/src …")
shutil.copytree(TKO_UI_SRC, DEST / "src")
print(f"      Copied {sum(1 for _ in (DEST / 'src').rglob('*') if _.is_file())} files")

# ── 4. Write package.json ─────────────────────────────────────────────────────

print("[3/4] Writing packages/ui/package.json …")
(DEST / "package.json").write_text("""\
{
  "name": "wxo-custom-ui",
  "version": "1.22.2",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./styles.css": "./src/styles.css",
    "./form-engine": "./src/form-engine/index.ts",
    "./app-shell": "./src/app-shell/index.ts"
  }
}
""")

# ── 5. Write tsconfig.json ────────────────────────────────────────────────────

print("[4/4] Writing packages/ui/tsconfig.json …")
(DEST / "tsconfig.json").write_text("""\
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
""")

# ── Done ──────────────────────────────────────────────────────────────────────

print("\n✓ packages/ui is now self-contained.")
print("\nNext steps — run in two separate terminals:\n")
print("  Terminal 1 (proxy server on port 8081):")
print("    cd server")
print("    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt")
print("    TKO_ENV_FILE=../../../.env .venv/bin/uvicorn app.main:app --port 8081")
print()
print("  Terminal 2 (Vite dev server on port 5174):")
print("    npm install")
print("    VITE_HAWAII_API_BASE=/api npm run dev --workspace=apps/hawaii-shell")
print()
print("  Then open: http://localhost:5174")
