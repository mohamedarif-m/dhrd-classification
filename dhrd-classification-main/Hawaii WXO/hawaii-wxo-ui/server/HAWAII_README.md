# server — Hawaii DHRD HRO proxy

FastAPI proxy for the Hawaii DHRD HRO classification UI.
A copy of the TKO Agents UI server with the registry re-wired for the
HRO pipeline agents and branding set to Hawaii DHRD.

## Quick start

```bash
cd server
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# Point at the project credentials file (never copied here):
TKO_ENV_FILE=../../../.env .venv/bin/uvicorn app.main:app --port 8081
```

Port **8081** (TKO base uses 8080 — both can run at the same time).

## Environment variables

Copy `server/.env.example` to `server/.env` and fill in the two required values,
or export them directly / point `TKO_ENV_FILE` at `dhrd-classification-main/.env`.

| Variable | Required | Notes |
|---|---|---|
| `WO_INSTANCE` | ✓ | Watson Orchestrate instance URL |
| `WO_API_KEY` | ✓ | IBM Cloud API key. Never logged or sent to the browser. |
| `ALLOWED_ORIGIN` | – | CORS origin (default `http://localhost:5174`) |
| `TKO_ENV_FILE` | – | Path to an env file to back-fill vars (e.g. `../../../.env`) |

All other variables are inherited from the base server — see
[`server/README.md`](README.md) for the full list.
