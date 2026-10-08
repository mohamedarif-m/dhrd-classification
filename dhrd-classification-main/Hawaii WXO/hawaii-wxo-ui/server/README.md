# server - tko-agents-ui proxy

[Back to the UI workspace](../README.md) | [Back to repo overview](../../../README.md)

Allowlist FastAPI proxy in front of the wxO Runs API. The browser talks only to
`/api/*`; the wxO API key, the minted IAM tokens, and the real agent ids never
leave this process. It runs two ways: locally for development, with Vite serving
the app and proxying `/api` here, and as the single container image in IBM Code
Engine (production and staging), where it also serves the built UI from the same
origin via `STATIC_DIR`. The deployment runbook is `../deploy/README.md`.

## Run

```bash
cd server
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
TKO_ENV_FILE=/path/to/tko-pilot/.env .venv/bin/uvicorn app.main:app --port 8080
```

Dependencies are `requirements.txt` (fastapi, uvicorn, httpx, python-multipart,
pytest). Port 8080 is what the shell's dev proxy expects; if you move it, update
`apps/tko-shell/vite.config.ts` too.

## Layout

```
app/main.py            app factory ONLY: middleware, security headers and CSP,
                       router includes, options warm-up, built-UI mount.
                       The uvicorn entrypoint stays app.main:app.
app/config.py          every environment variable, read once into `settings`
app/deps.py            the process-wide singletons (registry, thread store, wxO
                       client, options service) and the guards routes share
                       (identity, live-mode, ownership)
app/registry.json      the agent allowlist and branding (config data, not code)
app/routes/            the /api surface, one module per slice
  chat.py              POST /api/chat SSE relay + stream-loss recovery ladder,
                       and run cancel. The subtle core; read its comments first.
  threads.py           list / history / rename, all ownership-scoped
  options.py           the big-list side channel (/api/options)
  uploads.py           multipart passthrough
  meta.py              /api/health and /api/registry
app/services/          no FastAPI here, just the work
  wxo.py               upstream Runs API client (stream, status, threads, upload)
  token_service.py     IAM token mint and cache
  threadstore.py       thread-ownership store + COS write-through
  optionsvc.py         options fetch and TTL cache
  registry.py          registry load, agent resolution, client view
  events.py            sanitize / slim_message
app/jobs/warm.py       scheduled cache warmer (see below)
app/warm.py            shim keeping `python3 -m app.warm` working
scripts/               manual live probes; see scripts/README.md
tests/                 pytest suite
```

## Cache warmer

`app/jobs/warm.py` sends one "start" turn to every registered agent so the 12h
Workday-data cache is warm before a human arrives. It runs as a scheduled Code
Engine job, never inside the web process. The job command is
`python3 -m app.warm`, which `app/warm.py` keeps valid by re-exporting the job's
`main()`; change the job before removing that shim.

## Environment

Credentials are NEVER copied into this repo. Point the proxy at an env file that
holds them, or export the vars directly. Every var below is read in
`app/config.py`; process environment always wins over the file.

```
TKO_ENV_FILE          path to an env file to back-fill vars (e.g. tko-pilot/.env).
                      If unset, server/.env is used when present.
WO_INSTANCE           wxO instance URL (WXO_BASE_URL also accepted)
WO_API_KEY            wxO API key (WXO_API_KEY also accepted). Never logged,
                      never sent to the browser.
IAM_TOKEN_URL         IAM token endpoint
                      (default https://iam.cloud.ibm.com/identity/token)
REGISTRY_PATH         registry json (default app/registry.json)
ALLOWED_ORIGIN        CORS origin (default http://localhost:5173)
DATA_DIR              thread-ownership store dir (default server/.data, gitignored)
RATE_LIMIT_PER_MIN    per-identity request budget for /api/* except options
                      (default 120)
OPTIONS_RATE_LIMIT_PER_MIN
                      per-identity budget for /api/options* , a cached read a
                      form polls once per source (default 900)
TKO_RUN_POLL_DEADLINE seconds to keep polling a run after its stream dies
                      (default 180). Raised from 120: a slow round the
                      platform re-executes takes about twice its normal
                      time, which landed on the old deadline and told the
                      reader the request was still processing when it was
                      about to succeed. The poll still returns as soon as
                      the run settles, so fast rounds are unaffected.
STATIC_DIR            directory of the built UI to serve from this process.
                      Unset for local dev (vite serves the app and proxies
                      /api here). The container image sets /app/static.
COS_API_KEY           IBM COS api key. Set all four COS_* vars to make thread
COS_ENDPOINT          ownership survive a container restart; leave any unset
COS_BUCKET            and the store is the local file only.
COS_OBJECT            object key (default tko-agents-ui/threads.json)
```

## Serving the built UI

When `STATIC_DIR` points at a directory containing `index.html`, the proxy also
serves the app on the same origin: `/assets/*` from the build output, any other
real file at the static root, and `index.html` for every remaining non-`/api`
GET so client-side routes deep-link correctly. Non-`/api` responses then carry a
same-origin CSP instead of the API-only `default-src 'none'`. With `STATIC_DIR`
unset nothing is mounted and the proxy behaves exactly as before.

Caching is the standard SPA split, and it is what makes a deploy visible on a
NORMAL refresh:

| What | `Cache-Control` | Why |
|---|---|---|
| `index.html`, deep links, root files (favicon, logos) | `no-cache` | unhashed, and `index.html` names the current bundle, so it must be revalidated every load. A matching `If-None-Match` gets a 304, so the check costs one small request. |
| `/assets/*` | `public, max-age=31536000, immutable` | the filename carries a content hash, so those bytes can never change at that URL. Faster than revalidating AND safer, since a new build produces new names. |

Live defect 2026-08-12: with no `Cache-Control` at all, browsers heuristic-cached
`index.html` and a plain refresh after a deploy kept booting the previous bundle
- only a hard refresh picked up the new one. The 304 handling on the unhashed
path is explicit because Starlette implements conditional requests in
`StaticFiles` but not in a bare `FileResponse`; without it `no-cache` would mean
re-downloading the document on every page load.

## Thread-store durability

The ownership store is a small JSON file under `DATA_DIR`. In a container that
disk is ephemeral, so the COS vars above add a write-through mirror: the object
is read first at startup (falling back to the local file, then empty) and every
write is pushed back best-effort on a background thread. COS is never on the
critical path - a failed read or write is logged and ignored. Plain REST over
httpx with an IAM bearer token; no SDK, no extra dependency.

The base the proxy actually calls is `WO_INSTANCE` plus `/v1/orchestrate`.

Without `WO_INSTANCE` and `WO_API_KEY` the proxy starts in `unconfigured` mode:
health and registry work, and everything that needs the upstream returns 503.

## Endpoints

Defined under `app/routes/` (see Layout above).

```
GET   /api/health                       {"mode": "live" | "unconfigured"}
GET   /api/registry                     sanitized registry + tool display names
POST  /api/chat                         run turn -> SSE relay of the live stream
GET   /api/threads?agent_key=           this browser's threads (ownership store)
GET   /api/threads/{tid}/messages       slimmed history (text, tools, form meta)
PATCH /api/threads/{tid}                rename ({"title": "..."})
POST  /api/uploads                      multipart passthrough to upload-to-s3
POST  /api/runs/{run_id}/cancel         stop button
GET   /api/options?agent_key=&source=   full option rows from the side-channel
                                        cache ({"status": "ready"|"loading"})
POST  /api/options/refresh              force refetch ({"agent_key": "..."})
```

`POST /api/chat` body: `{"agent_key": "...", "content": "...", "thread_id": null}`.
`agent_key` is at most 64 chars, `content` at most 100000 chars (form-submit
envelopes ride as user text). The response is `text/event-stream`.

What the relay does: mints and caches the IAM token, POSTs the run with
`stream=true&multiple_content=true`, re-emits each upstream NDJSON line as an
SSE frame (`event:` plus `data:`), heartbeats every 15 s, synthesizes a terminal
event from `GET /runs/{id}` if the upstream socket dies silently, and strips
internal identifiers (agent ids, tenant ids, service identity) from every
payload before it reaches the browser.

## Security model

State the limit plainly: there is NO end-user authentication. Nobody signs in,
and the proxy cannot tell one person from another. What stands in for access
control is the anonymous per-browser `X-TKO-Client` ownership key, which scopes
threads to the browser that created them, plus the agent, upload and CORS
allowlists and the rate limits below. That is enough for a pilot whose URL is
shared with a known group, and it is what the design assumes. It is NOT enough
for a multi-tenant or openly exposed deployment: anyone who can reach the URL
can start a run against the configured wxO instance. Such a deployment needs
real authentication in front of this process.

Credentials. The wxO API key is read from the environment into
`app/config.py` and handed to `TokenService` (`app/services/token_service.py`). It is
never logged, never returned by an endpoint, and never reaches the browser.
Minted IAM tokens stay in process memory only.

Token handling (`app/services/token_service.py`). The token is treated as stale at 80
percent of its TTL. Refreshes are single-flight behind an asyncio lock with a
double-check inside, so a burst of concurrent requests mints once, not N times.
`invalidate()` forces the next `get()` to mint, which is how an upstream 401
gets exactly one forced retry. The only counter exposed is `mint_count`, for
tests; no token material is ever surfaced.

Caller identity and thread scoping. Every `/api/*` call except health and
registry requires an `X-TKO-Client` header: an anonymous per-browser id the UI
generates into localStorage, validated as 8 to 64 alphanumeric-or-dash
characters. It is an ownership key, NOT authentication. Threads are recorded
against it in `app/services/threadstore.py`, and every thread-scoped route checks
ownership first. A thread that belongs to another identity returns 404, not 403,
so a foreign thread id is indistinguishable from one that does not exist. The
guarantees are pinned by `tests/test_scoping.py`: listing is scoped to the
owner, an optional `agent_key` filter narrows further, `owns()` is false for
another identity and for absent ids, a follow-up turn on an existing thread does
not reassign the owner or clobber the title, and ownership survives a restart
(the store is on disk under `DATA_DIR`).

Allowlists. Agents are an allowlist: `app/registry.json` maps public keys to
live agents, and an unknown key is a 404. Uploads are an allowlist: extension
must be one of csv, doc, docx, jpeg, jpg, pdf, png, wav, xls, xlsx, xlsm, ppt,
pptx, and the body at most 10 MB. CORS allows exactly one origin
(`ALLOWED_ORIGIN`), methods GET, POST, PATCH, and headers Content-Type and
X-TKO-Client.

Rate limiting and headers. Two sliding one-minute windows cap `/api/*` and
return 429 with a `Retry-After` over budget: `/api/options*` gets
`OPTIONS_RATE_LIMIT_PER_MIN` (default 900), everything else
`RATE_LIMIT_PER_MIN` (default 120). Options traffic is a cached read that one
open form polls once per source every few seconds, so it needs its own
headroom. Both windows are keyed on the caller's `X-TKO-Client` identity,
falling back to the peer address - behind Code Engine every request arrives
from the router's address, so an IP key would be one bucket for the whole
tenant. Every response
carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, and `Content-Security-Policy: default-src 'none'`.

Response sanitization. Both the SSE relay and the history endpoint pass payloads
through `app/services/events.py` (`sanitize`, `slim_message`), which strips internal
identifiers and trims message bodies to what the UI actually renders.

## Registry

`app/registry.json` maps public agent keys to live agents by NAME
(`wxo_agent_name`, resolved to an id server-side at first use) plus display data
and per-tool thinking copy. `wxo_agent_name`, `wxo_agent_id`, and
`option_sources` are stripped from the client view. Unknown keys are rejected.

The `thinking` map is keyed by the tool name AS THE PLATFORM EMITS IT on
`tool_calls[].name`, and the lookup is an exact key match (`thinkingCopyFor`).
Measured live on 2026-08-11 against JobChange_C: what arrives is the SNAKE_CASE
form of the tool's `display_name` (`job_change_start`, `pasted_details_intake`),
never the raw tool id and never the Title-Case display name. Every agent
therefore carries all three spellings - the raw `jcc_start` id, the literal
"Job Change Start" and the snake_case `job_change_start` - so a change of
platform behaviour cannot silently drop an agent back onto the fallback copy.

Per-agent `option_sources` allowlists the big-list side channel: only listed
(agent, source) pairs are ever fetchable via `/api/options`; each source may
set `ttl_s` (default 43200). The top-level `branding` block (appTitle, logoUrl,
colors) IS passed to the client and drives the shell's look; see the root
README's configuration reference.

## Tests

```bash
.venv/bin/python -m pytest tests -q      # or: npm run test:server from the root
```

Covers token cache, refresh and single-flight (`tests/test_token.py`), thread
ownership scoping, store and endpoints (`tests/test_scoping.py`,
`tests/test_api.py`), registry sanitization (`tests/test_registry.py`), and
event sanitization and slimming against live-captured message shapes
(`tests/test_events.py`).

## Scripts

`scripts/capture_stream.py` is a one-shot live stream capture (reads the env
file itself, prints event names and sizes only, never secrets).
`scripts/live_driver.py` drives a full agent conversation against the live
tenant from the shell (`warn` / `create` modes); `create` writes for real.
