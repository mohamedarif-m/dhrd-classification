# Hawaii DHRD HRO — Custom UI

A custom chat UI for the Hawaii Department of Human Resources Development (DHRD)
HRO Position Classification pipeline, built on the
[Watson Orchestrate custom UI kit](../../../tko-pilot/tko-agents-ui/packages/ui).

This workspace runs independently from the base TKO Pilot UI — different ports,
different branding, different agent registry. Both can run simultaneously.

| | TKO Pilot (base) | Hawaii DHRD HRO (this) |
|---|---|---|
| UI port | `:5173` | `:5174` |
| Proxy port | `:8080` | `:8081` |
| Agents | TKO Workday agents | HRO Classification pipeline |

---

## Prerequisites

- **Node 18+** (run `node --version`)
- **Python 3.11+** (run `python3 --version`)
- Credentials in `dhrd-classification-main/.env`:
  - `WATSON_ORCHESTRATE_URL` — WXO instance URL
  - `IBM_CLOUD_API_KEY` — IBM Cloud API key

---

## First-time setup (run once)

This makes `hawaii-wxo-ui` fully self-contained by copying the shared UI
package source from `tko-pilot` into `packages/ui/`:

```bash
cd "Hawaii WXO/hawaii-wxo-ui"
python3 setup.py
```

You should see `✓ packages/ui is now self-contained.`

---

## Quick start (two terminals)

### Terminal 1 — FastAPI proxy

```bash
cd "Hawaii WXO/hawaii-wxo-ui/server"
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# Point at the credentials file (never copies secrets into this repo):
TKO_ENV_FILE=../../../.env .venv/bin/uvicorn app.main:app --port 8081
```

You should see:
```
INFO:     Uvicorn running on http://127.0.0.1:8081
```

Test the proxy is up:
```bash
curl http://localhost:8081/api/health
# → {"mode":"live"}  (or "unconfigured" if credentials are not found)
```

### Terminal 2 — Vite dev server

```bash
cd "Hawaii WXO/hawaii-wxo-ui"
npm install           # first time only

# Start the Hawaii shell on :5174
VITE_HAWAII_API_BASE=/api npm run dev --workspace=apps/hawaii-shell
```

Open **http://localhost:5174** in your browser.

> **Note**: `VITE_HAWAII_API_BASE=/api` tells the Vite dev server which path
> to proxy. Vite then forwards `/api/*` to the proxy on `:8081`.
> You can also put this in `apps/hawaii-shell/.env.local`:
> ```
> VITE_HAWAII_API_BASE=/api
> ```

---

## What you'll see

1. **Top bar** — "Hawaii DHRD HRO" wordmark on a deep-ocean blue background.
2. **Upload zone** — on a fresh thread, a drag-and-drop card appears above the
   chat input with two slots:
   - **Position Description** (.docx)
   - **Class Specification** (.pdf)
3. **Chat input** — type `Classify PD` once both files are attached, or attach
   files via the paperclip if you dismiss the upload zone.
4. **Thinking messages** — each pipeline step shows a readable status:
   - "Reading the class specification PDF…"
   - "Extracting duties from the position description…"
   - "Generating the classification analysis…"
5. **Classification report** — the full report appears as the final assistant
   message in the thread.

---

## Project layout

```
hawaii-wxo-ui/
├── apps/
│   └── hawaii-shell/          React shell app (port :5174)
│       └── src/
│           ├── App.tsx         Entry — LiveRoot + NotConfigured screens
│           ├── brand.ts        Wordmark: "Hawaii DHRD HRO"
│           ├── config.ts       Reads VITE_HAWAII_API_BASE
│           ├── theme.hawaii.ts Blue/ocean form-engine token overrides
│           ├── HROWorkspace.tsx Workspace wrapper with upload zone wiring
│           ├── HROUploadZone.tsx Drag-and-drop file upload component
│           └── hro.css         HRO-specific styles (prefixed hro-)
├── packages/
│   └── ui/                     wxo-custom-ui source (copied from tko-pilot by setup.py)
│       └── src/                (read-only — HRO overrides go in apps/hawaii-shell)
├── server/                     FastAPI proxy (port :8081)
│   ├── app/
│   │   ├── registry.json       HRO agents + Hawaii branding
│   │   ├── config.py           Reads WO_INSTANCE + WO_API_KEY
│   │   └── …                   (rest is identical to TKO server)
│   └── .env.example            ← copy → .env, fill in credentials
└── README.md                   ← this file
```

---

## Credentials

Credentials are **never** committed to this repo. The proxy reads them from:

1. `TKO_ENV_FILE` — path to an env file (e.g. `../../../.env`)
2. `server/.env` — if `TKO_ENV_FILE` is not set and the file exists
3. Process environment — variables exported directly always win

To use a local env file instead of the project-level one:

```bash
cp server/.env.example server/.env
# edit server/.env — fill in WO_INSTANCE and WO_API_KEY
uvicorn app.main:app --port 8081
```

---

## Difference from TKO Pilot base

| | TKO Pilot | Hawaii DHRD HRO |
|---|---|---|
| Shell | `apps/tko-shell` | `apps/hawaii-shell` |
| Branding | TKO gold (`#c89b2a`) | Hawaii blue (`#0066cc`) |
| Proxy port | `8080` | `8081` |
| UI port | `5173` | `5174` |
| Agents | Workday (JobChange, etc.) | HRO pipeline (hro-classifier, ask) |
| Upload UX | Standard composer only | Upload zone on fresh thread |

The `packages/ui` source is copied from `tko-pilot` by `setup.py` and lives
locally in `hawaii-wxo-ui/packages/ui/src`. Any changes should go into
`apps/hawaii-shell` so HRO customizations stay isolated.

---

## What is NOT in scope

- Authentication or login
- Deployment to Code Engine or any cloud environment
- Changes to live Watson Orchestrate agents
- Changes to the TKO Pilot agents or registry

---

## When HRO agents are deployed to ca-tor

Update the five agent IDs in:
- `dhrd-classification-main/Hawaii WXO/watsonx_orchestrate_client.py` — `HROAgent` class
- `dhrd-classification-main/Hawaii WXO/agents/__init__.py` — `AGENT_IDS` dict

The server resolves `wxo_agent_name` → agent ID at runtime via
`GET /v1/orchestrate/agents`, so the registry.json does not need to change.
