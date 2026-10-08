"""Config from environment only; nothing tenant-specific is baked in.

Credentials: the proxy reads WO_API_KEY / WO_INSTANCE from the process
environment, optionally back-filled from an env file named by TKO_ENV_FILE
(e.g. point it at tko-pilot/.env, or create a local server/.env). The key is
never copied into this repo, never logged, and never sent to the browser.
"""

import os
import re
from dataclasses import dataclass, field
from pathlib import Path


def _load_env_file(path: str) -> None:
    """Back-fill os.environ from a KEY=VALUE file. Process env always wins."""
    p = Path(path)
    if not p.is_file():
        return
    for line in p.read_text().splitlines():
        m = re.match(r"\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)", line)
        if m and m.group(1) not in os.environ:
            os.environ[m.group(1)] = m.group(2).strip().strip('"').strip("'")


if os.getenv("TKO_ENV_FILE"):
    _load_env_file(os.environ["TKO_ENV_FILE"])
elif Path(__file__).resolve().parent.parent.joinpath(".env").is_file():
    # Priority: server/.env (Hawaii WXO proxy local env)
    _load_env_file(str(Path(__file__).resolve().parent.parent / ".env"))
else:
    # Fallback: dhrd-classification-main/.env (only when enough parents exist)
    try:
        p = Path(__file__).resolve().parents[4] / ".env"
        if p.is_file():
            _load_env_file(str(p))
    except IndexError:
        pass

_SERVER_DIR = Path(__file__).resolve().parent.parent


def _env(*names: str, default: str = "") -> str:
    for n in names:
        v = os.getenv(n)
        if v:
            return v
    return default


@dataclass(frozen=True)
class Settings:
    # wxO instance URL (the ADK's WO_INSTANCE) and API key. Never log the key.
    # Also accepts WATSON_ORCHESTRATE_URL / IBM_CLOUD_API_KEY from dhrd-classification-main/.env
    wxo_base_url: str = field(default_factory=lambda: _env(
        "WO_INSTANCE", "WATSON_ORCHESTRATE_URL", "WXO_BASE_URL"))
    wxo_api_key: str = field(default_factory=lambda: _env(
        "WO_API_KEY", "WATSON_ORCHESTRATE_API_KEY", "WXO_API_KEY", "IBM_CLOUD_API_KEY"))
    iam_token_url: str = field(default_factory=lambda: _env(
        "IAM_TOKEN_URL", default="https://iam.cloud.ibm.com/identity/token"))
    get_env: object = field(default_factory=lambda: _env)
    registry_path: str = field(default_factory=lambda: _env(
        "REGISTRY_PATH", default=str(_SERVER_DIR / "app" / "registry.json")))
    allowed_origin: str = field(default_factory=lambda: _env(
        "ALLOWED_ORIGIN", default="http://localhost:5174"))
    data_dir: str = field(default_factory=lambda: _env(
        "DATA_DIR", default=str(_SERVER_DIR / ".data")))
    # Rate limiting. Two buckets, because the two kinds of /api traffic are
    # nothing alike:
    #
    #   RATE_LIMIT_PER_MIN (120)          everything except /api/options*.
    #       Chat turns, thread reads, uploads - each one costs an upstream
    #       call, so the ceiling stays where it was.
    #   OPTIONS_RATE_LIMIT_PER_MIN (900)  /api/options and /api/options/refresh,
    #       which read an in-process cache and never touch upstream on the hot
    #       path. One open form declares up to ~6 option sources and the browser
    #       polls each every ~3s until it is warm, so a single user can put 120
    #       req/min through this path on its own - it needs its own headroom or
    #       one form starves the whole session. 900/min leaves room for several
    #       tabs of the same identity.
    #
    # Both windows are sliding-minute and keyed per client identity; see the
    # middleware in app/main.py for the key resolution.
    rate_limit_per_min: int = field(default_factory=lambda: int(
        _env("RATE_LIMIT_PER_MIN", default="120")))
    options_rate_limit_per_min: int = field(default_factory=lambda: int(
        _env("OPTIONS_RATE_LIMIT_PER_MIN", default="900")))
    # Seconds to keep polling a run after its stream dies before handing over
    # to the agent-driven submit check (creates average ~30s; beyond this the
    # client asks the review's checkTool what actually happened).
    #
    # RAISED 120 -> 180 (Phase H). This is a MITIGATION, and it is deliberately
    # paired with the round-time fix rather than offered instead of it. The
    # measured shape of the problem: the mega-form round sits near a cliff, and
    # the platform RE-EXECUTES a tool it judges slow - so an affected round
    # does not degrade, it DOUBLES. A round that would have landed at ~60s
    # comes back at ~120s and lands exactly on the old deadline, where the
    # reader is told "Workday is still processing this request" about work that
    # was about to succeed. 180s buys those rounds room to finish and turns a
    # false failure into a slow success. It does NOT hide a hang: the poll
    # still exits the moment the run settles or the thread shows this turn's
    # message, so a round that lands in 40s still returns in 40s and only
    # genuinely stuck rounds pay the extra wait.
    # Override with TKO_RUN_POLL_DEADLINE where a tenant is faster or slower.
    run_poll_deadline_s: float = field(default_factory=lambda: float(
        _env("TKO_RUN_POLL_DEADLINE", default="180")))
    # Built UI to serve from this process (single-container deploy). Unset for
    # local dev, where vite serves the app and proxies /api here.
    static_dir: str = field(default_factory=lambda: _env("STATIC_DIR"))
    # Space-separated origins allowed to frame the app (CSP frame-ancestors).
    # Unset means the app refuses framing entirely. Set it only for a known
    # embedding host, e.g. a Microsoft Teams tab:
    #   FRAME_ANCESTORS="https://teams.microsoft.com https://*.teams.microsoft.com"
    # API responses are never framable regardless of this value.
    frame_ancestors: str = field(default_factory=lambda: _env("FRAME_ANCESTORS"))
    # Optional IBM COS write-through for the thread-ownership store. All four
    # must be set for it to engage; otherwise the store stays file-only.
    cos_api_key: str = field(default_factory=lambda: _env("COS_API_KEY"))
    cos_endpoint: str = field(default_factory=lambda: _env("COS_ENDPOINT"))
    cos_bucket: str = field(default_factory=lambda: _env("COS_BUCKET"))
    cos_object: str = field(default_factory=lambda: _env(
        "COS_OBJECT", default="tko-agents-ui/threads.json"))
    # Thread-index retention. A row whose `updated_at` (or, failing that,
    # `created_at`) is older than this many days is dropped - on boot, on every
    # merge of the shared object, and from the map just before it is written
    # back. It needs no tombstone because it is a pure function of the row, so
    # every instance reaches the same verdict independently. 0 (or a negative
    # value) disables expiry entirely and the index grows without bound.
    thread_retention_days: float = field(default_factory=lambda: float(
        _env("THREAD_RETENTION_DAYS", default="30")))

    @property
    def configured(self) -> bool:
        return bool(self.wxo_base_url and self.wxo_api_key)

    @property
    def cos_configured(self) -> bool:
        return bool(self.cos_api_key and self.cos_endpoint and self.cos_bucket
                    and self.cos_object)

    @property
    def orchestrate_base(self) -> str:
        return self.wxo_base_url.rstrip("/") + "/v1/orchestrate"


settings = Settings()
