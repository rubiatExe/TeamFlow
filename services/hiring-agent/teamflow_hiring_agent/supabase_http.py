"""Fail-closed HTTP boundary for credentialed Supabase Data API calls."""

from __future__ import annotations

import base64
import json
import math
import re
import time
from collections.abc import Collection
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

import httpx

DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
_DATABASE_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_RESERVED_EXTRA_HEADER_NAMES = frozenset(
    {
        "accept",
        "accept-encoding",
        "apikey",
        "authorization",
        "connection",
        "content-encoding",
        "content-length",
        "content-type",
        "cookie",
        "host",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "x-api-key",
    }
)


class SupabaseBoundaryError(RuntimeError):
    """A sanitized configuration, transport, or response-boundary failure."""


@dataclass(frozen=True, slots=True)
class SupabaseJSONResponse:
    status_code: int
    payload: Any


def _canonical_origin(value: str, *, production: bool) -> str:
    if not value or value != value.strip():
        raise ValueError("Supabase origin is required and must not contain whitespace")
    parsed = urlsplit(value)
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Supabase origin must not contain user information")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ValueError("Supabase origin must not contain a path, query, or fragment")
    if not parsed.hostname:
        raise ValueError("Supabase origin must contain a hostname")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Supabase origin contains an invalid port") from exc

    hostname = parsed.hostname.lower()
    is_loopback = hostname in {"127.0.0.1", "::1", "localhost"}
    if parsed.scheme != "https" and not (
        not production and parsed.scheme == "http" and is_loopback
    ):
        raise ValueError("Supabase origin must use HTTPS")
    if production and port not in {None, 443}:
        raise ValueError("Production Supabase origin must use the default HTTPS port")

    rendered_host = f"[{hostname}]" if ":" in hostname else hostname
    default_port = 443 if parsed.scheme == "https" else 80
    rendered_port = f":{port}" if port is not None and port != default_port else ""
    return f"{parsed.scheme}://{rendered_host}{rendered_port}"


def validate_supabase_origin(
    url: str,
    trusted_origin: str,
    *,
    production: bool,
) -> str:
    """Return a canonical origin only when runtime and deployment trust agree exactly."""

    origin = _canonical_origin(url, production=production)
    trusted = _canonical_origin(trusted_origin, production=production)
    if origin != trusted:
        raise ValueError("Supabase URL does not match the trusted origin")
    return origin


def scoped_merchant_id_from_jwt(token: str, *, expected_role: str) -> str:
    """Validate non-authoritative routing claims; Supabase still verifies the signature."""

    if (
        not token
        or len(token) > 8_192
        or token != token.strip()
        or any(character.isspace() for character in token)
    ):
        raise ValueError("Scoped Supabase token is invalid")
    parts = token.split(".")
    if len(parts) != 3 or not all(parts):
        raise ValueError("Scoped Supabase token is invalid")
    try:
        padded = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as exc:
        raise ValueError("Scoped Supabase token is invalid") from exc
    if not isinstance(payload, dict) or payload.get("role") != expected_role:
        raise ValueError("Scoped Supabase token role is invalid")
    merchant_id = payload.get("merchant_id")
    if not isinstance(merchant_id, str) or _DATABASE_ID_RE.fullmatch(merchant_id) is None:
        raise ValueError("Scoped Supabase token merchant claim is invalid")
    try:
        canonical_merchant = str(UUID(merchant_id))
    except ValueError as exc:
        raise ValueError("Scoped Supabase token merchant claim is invalid") from exc
    expires_at = payload.get("exp")
    if (
        not isinstance(expires_at, int)
        or isinstance(expires_at, bool)
        or expires_at <= int(time.time())
    ):
        raise ValueError("Scoped Supabase token is expired or has no expiry")
    return canonical_merchant


class SupabaseJSONClient:
    """Send bounded JSON requests without forwarding credentials across redirects."""

    def __init__(
        self,
        *,
        url: str,
        trusted_origin: str,
        api_key: str,
        access_token: str,
        production: bool,
        timeout_seconds: float,
        max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not api_key or not access_token:
            raise ValueError("Supabase API key and scoped access token are required")
        if not math.isfinite(timeout_seconds) or not 0 < timeout_seconds <= 60:
            raise ValueError("Supabase timeout is invalid")
        if not 1 <= max_response_bytes <= DEFAULT_MAX_RESPONSE_BYTES:
            raise ValueError("Supabase response limit is invalid")
        self._origin = validate_supabase_origin(
            url,
            trusted_origin,
            production=production,
        )
        self._api_key = api_key
        self._access_token = access_token
        self._timeout = timeout_seconds
        self._max_response_bytes = max_response_bytes
        self._transport = transport

    def _headers(self) -> dict[str, str]:
        return {
            "Accept": "application/json",
            "apikey": self._api_key,
            "Authorization": f"Bearer {self._access_token}",
            "Content-Type": "application/json",
        }

    async def request_json(
        self,
        method: str,
        path_and_query: str,
        *,
        json_body: Any | None = None,
        extra_headers: dict[str, str] | None = None,
        allowed_statuses: Collection[int] = (200,),
    ) -> SupabaseJSONResponse:
        if method not in {"GET", "POST"}:
            raise ValueError("Supabase HTTP method is not allowed")
        if not path_and_query.startswith("/rest/v1/") or "\\" in path_and_query:
            raise ValueError("Supabase Data API path is invalid")
        headers = self._headers()
        if extra_headers:
            if any(
                name.strip().casefold() in _RESERVED_EXTRA_HEADER_NAMES for name in extra_headers
            ):
                raise ValueError("Supabase extra headers cannot override reserved headers")
            headers.update(extra_headers)

        try:
            async with httpx.AsyncClient(
                timeout=self._timeout,
                transport=self._transport,
                follow_redirects=False,
                trust_env=False,
            ) as client:
                async with client.stream(
                    method,
                    f"{self._origin}{path_and_query}",
                    headers=headers,
                    json=json_body,
                ) as response:
                    if response.is_redirect:
                        raise SupabaseBoundaryError("Supabase redirect was refused")
                    content_type = response.headers.get("content-type", "")
                    media_type = content_type.split(";", 1)[0].strip().lower()
                    if media_type != "application/json" and not media_type.endswith("+json"):
                        raise SupabaseBoundaryError("Supabase response was not JSON")
                    content_length = response.headers.get("content-length")
                    if content_length is not None:
                        try:
                            if int(content_length) > self._max_response_bytes:
                                raise SupabaseBoundaryError("Supabase response was too large")
                        except ValueError as exc:
                            raise SupabaseBoundaryError(
                                "Supabase response had an invalid length"
                            ) from exc
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > self._max_response_bytes:
                            raise SupabaseBoundaryError("Supabase response was too large")
                    status_code = response.status_code
        except SupabaseBoundaryError:
            raise
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            raise SupabaseBoundaryError("Supabase request failed") from exc

        if status_code not in allowed_statuses:
            raise SupabaseBoundaryError("Supabase returned an unexpected status")
        try:
            payload = json.loads(bytes(body).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SupabaseBoundaryError("Supabase returned invalid JSON") from exc
        return SupabaseJSONResponse(status_code=status_code, payload=payload)
