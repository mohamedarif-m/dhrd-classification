"""IBM Cloud IAM token mint + cache.

Refresh policy mirrors the ADK/SDK: treat the token stale at 80% of its TTL,
single-flight the refresh, and let callers force-invalidate on an upstream 401.
The API key and minted tokens never leave this process and are never logged.
"""

import asyncio
import time
from typing import Awaitable, Callable

import httpx


class TokenService:
    def __init__(
        self,
        api_key: str,
        iam_url: str = "https://iam.cloud.ibm.com/identity/token",
        mint: Callable[[], Awaitable[tuple[str, float]]] | None = None,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._api_key = api_key
        self._iam_url = iam_url
        self._mint = mint or self._mint_iam
        self._now = now
        self._lock = asyncio.Lock()
        self._token: str | None = None
        self._issued_at = 0.0
        self._ttl = 0.0
        self.mint_count = 0  # observability for tests; no token material

    async def _mint_iam(self) -> tuple[str, float]:
        # If the key is already a Bearer / ZenApiKey token or not a plain IAM API key
        if self._api_key.startswith("ZenApiKey ") or self._api_key.startswith("Bearer "):
            return self._api_key, 86400.0

        async with httpx.AsyncClient(timeout=30) as client:
            # Check if this is the SaaS platform IAM endpoint
            if "siusermgr" in self._iam_url:
                resp = await client.post(
                    self._iam_url,
                    json={"apikey": self._api_key},
                    headers={"Content-Type": "application/json"},
                )
                if resp.status_code != 200:
                    raise RuntimeError(f"WXO SaaS Token Error (HTTP {resp.status_code}): {resp.text}")
                body = resp.json()
                token = body.get("token") or body.get("access_token") or body.get("jwt")
                return token, float(body.get("expires_in", 3600))

            # Standard IBM Cloud IAM OAuth endpoint
            resp = await client.post(
                self._iam_url,
                data={
                    "grant_type": "urn:ibm:params:oauth:grant-type:apikey",
                    "apikey": self._api_key,
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            if resp.status_code == 400:
                # Fallback: attempt SaaS token exchange if IAM token exchange rejected the key
                try:
                    saas_resp = await client.post(
                        "https://iam.platform.saas.ibm.com/siusermgr/api/1.0/apikeys/token",
                        json={"apikey": self._api_key},
                        headers={"Content-Type": "application/json"},
                    )
                    if saas_resp.status_code == 200:
                        body = saas_resp.json()
                        token = body.get("token") or body.get("access_token") or body.get("jwt")
                        return token, float(body.get("expires_in", 3600))
                except Exception:
                    pass

                body = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
                err_code = body.get("errorCode", "")
                err_msg = body.get("errorMessage", resp.text)
                raise RuntimeError(
                    f"IBM IAM Token Error ({err_code}): {err_msg}. "
                    "Please ensure the API key provided is valid."
                )
            resp.raise_for_status()
            body = resp.json()
            return body["access_token"], float(body.get("expires_in", 3600))

    def _stale(self) -> bool:
        if self._token is None:
            return True
        return self._now() >= self._issued_at + 0.8 * self._ttl

    async def get(self) -> str:
        if not self._stale():
            return self._token  # type: ignore[return-value]
        async with self._lock:
            if self._stale():  # double-check inside the single-flight lock
                token, ttl = await self._mint()
                self._token = token
                self._ttl = ttl
                self._issued_at = self._now()
                self.mint_count += 1
            return self._token  # type: ignore[return-value]

    def invalidate(self) -> None:
        """Force the next get() to mint (used after an upstream 401)."""
        self._token = None
