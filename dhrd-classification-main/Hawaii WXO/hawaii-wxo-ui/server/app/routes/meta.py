"""Unauthenticated metadata: health and the sanitized client view of the
registry (agent keys, display data, branding, tool display names).
"""

from fastapi import APIRouter

from ..config import settings
from ..deps import registry, wxo
from ..services.registry import client_view

router = APIRouter()


@router.get("/api/health")
def health() -> dict:
    key = settings.wxo_api_key
    url = settings.wxo_base_url
    masked_key = f"{key[:4]}...{key[-4:]} (len: {len(key)})" if key and len(key) >= 8 else ("(empty)" if not key else f"len: {len(key)}")
    
    # Format validations
    url_checks = []
    if not url:
        url_checks.append("URL is missing")
    else:
        if not url.startswith("https://"):
            url_checks.append("URL should start with https://")
        if url.endswith("/v1/orchestrate") or url.endswith("/v1/orchestrate/"):
            url_checks.append("Do NOT append '/v1/orchestrate' at the end — proxy appends this automatically")
        if "/instances/" not in url:
            url_checks.append("URL typically contains '/instances/<instance_id>'")

    key_checks = []
    key_type = "IBM Cloud IAM API Key"
    if not key:
        key_checks.append("API key is missing")
    elif key.startswith("ZenApiKey "):
        key_type = "ZenApiKey"
    elif key.startswith("Bearer "):
        key_type = "Bearer Token"
    else:
        # Standard IAM API key checks
        if " " in key:
            key_checks.append("Contains whitespace")
        if len(key) < 30 or len(key) > 60:
            key_checks.append(f"Unexpected length for IAM key: {len(key)} (IAM keys are usually ~44 chars)")

    env_vars_found = {
        "WO_INSTANCE": bool(settings.get_env("WO_INSTANCE")),
        "WATSON_ORCHESTRATE_URL": bool(settings.get_env("WATSON_ORCHESTRATE_URL")),
        "WO_API_KEY": bool(settings.get_env("WO_API_KEY")),
        "WATSON_ORCHESTRATE_API_KEY": bool(settings.get_env("WATSON_ORCHESTRATE_API_KEY")),
        "IBM_CLOUD_API_KEY": bool(settings.get_env("IBM_CLOUD_API_KEY")),
    }

    return {
        "mode": "live" if settings.configured else "unconfigured",
        "configured": settings.configured,
        "wxo_base_url": url or "(not set)",
        "url_validation": url_checks if url_checks else "VALID",
        "has_api_key": bool(key),
        "api_key_type": key_type,
        "api_key_preview": masked_key,
        "key_validation": key_checks if key_checks else "VALID",
        "detected_env_variables": env_vars_found,
    }


@router.get("/api/validate-key")
async def validate_key() -> dict:
    """Test the configured API key against IBM Cloud IAM and watsonx Orchestrate."""
    import httpx
    if not settings.wxo_api_key:
        return {"ok": False, "step": "config", "error": "No API key configured in .env"}

    key = settings.wxo_api_key
    bearer_token = None

    # Step 1: Exchange IAM API key if it's not already ZenApiKey / Bearer
    if key.startswith("ZenApiKey ") or key.startswith("Bearer "):
        bearer_token = key
        iam_result = {"status": "skipped", "details": f"Using direct auth header ({key.split()[0]})"}
    else:
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(
                    settings.iam_token_url,
                    data={
                        "grant_type": "urn:ibm:params:oauth:grant-type:apikey",
                        "apikey": key,
                    },
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
                if resp.status_code != 200:
                    body = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
                    return {
                        "ok": False,
                        "step": "iam_token_exchange",
                        "http_status": resp.status_code,
                        "error_code": body.get("errorCode", "UNKNOWN"),
                        "error_message": body.get("errorMessage", resp.text),
                        "hint": "Check if the key was created at https://cloud.ibm.com/iam/apikeys and belongs to this account."
                    }
                data = resp.json()
                bearer_token = data.get("access_token")
                iam_result = {"status": "success", "expires_in": data.get("expires_in")}
        except Exception as e:
            return {"ok": False, "step": "iam_token_exchange", "error": str(e)}

    # Step 2: Test Orchestrate instance with the token
    auth_header = bearer_token if bearer_token.startswith("ZenApiKey ") or bearer_token.startswith("Bearer ") else f"Bearer {bearer_token}"
    wxo_url = f"{settings.orchestrate_base}/agents"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(wxo_url, headers={"Authorization": auth_header})
            if resp.status_code != 200:
                return {
                    "ok": False,
                    "step": "wxo_instance_access",
                    "iam_exchange": iam_result,
                    "wxo_http_status": resp.status_code,
                    "wxo_response": resp.text,
                    "hint": f"Could not reach {wxo_url}. Check if the instance URL in .env is correct."
                }
            agents_data = resp.json().get("data", []) if isinstance(resp.json(), dict) else []
            agent_names = [a.get("name") for a in agents_data if isinstance(a, dict)]
            return {
                "ok": True,
                "step": "complete",
                "iam_exchange": iam_result,
                "wxo_connection": "success",
                "agents_found_in_instance": agent_names
            }
    except Exception as e:
        return {
            "ok": False,
            "step": "wxo_instance_access",
            "iam_exchange": iam_result,
            "error": str(e)
        }


@router.get("/api/registry")
async def get_registry() -> dict:
    view = client_view(registry)
    view["mode"] = "live" if settings.configured else "unconfigured"
    if wxo is not None:
        # Tool display names feed thinking-copy tier 2; names only, no ids.
        try:
            tools = await wxo.tool_display()
            view["tools"] = {n: {"display_name": t.get("display_name")}
                             for n, t in tools.items()}
        except Exception:
            view["tools"] = {}
    return view
