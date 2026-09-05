"""Verified Supabase user identity for the durable human-review boundary.

Merchant ownership is deliberately absent here.  The database resolves the actor's
current active membership on every lifecycle operation instead of trusting token
metadata or a caller-provided tenant identifier.
"""

from __future__ import annotations

import json
import math
import re
import time
from base64 import urlsafe_b64decode, urlsafe_b64encode
from binascii import Error as Base64Error
from dataclasses import dataclass
from typing import Literal

import httpx

from ...supabase_http import validate_supabase_origin

_BEARER_RE = re.compile(r"^Bearer ([A-Za-z0-9._~+/=-]{1,8192})$")
_DATABASE_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_MAX_USER_RESPONSE_BYTES = 65_536
_MAX_CLOCK_SKEW_SECONDS = 60
_NON_AUTHENTICATING_AMR_METHODS = frozenset(
    {"token_refresh", "recovery", "invite", "email/signup", "email_change", "anonymous"}
)
_CAPABILITY_SECRET_RE = re.compile(r"^[A-Za-z0-9_-]{43,86}$")
_CANONICAL_CONTENT_LENGTH_RE = re.compile(r"^(?:0|[1-9][0-9]*)$")


class UnauthorizedUserError(RuntimeError):
    """The request did not carry a currently verified non-anonymous user."""


class AuthenticationUnavailableError(RuntimeError):
    """The identity provider could not be reached or returned an invalid service result."""


def decode_capability_secret(value: str) -> bytes:
    """Decode a canonical, unpadded base64url capability key without logging it."""

    if (
        not isinstance(value, str)
        or _CAPABILITY_SECRET_RE.fullmatch(value) is None
        or value != value.strip()
        or any(character.isspace() or ord(character) < 33 for character in value)
    ):
        raise ValueError("hitl_capability_secret_invalid")
    invalid = False
    try:
        decoded = urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, Base64Error):
        invalid = True
        decoded = b""
    if invalid:
        raise ValueError("hitl_capability_secret_invalid")
    if not 32 <= len(decoded) <= 64:
        raise ValueError("hitl_capability_secret_invalid")
    if urlsafe_b64encode(decoded).decode("ascii").rstrip("=") != value:
        raise ValueError("hitl_capability_secret_invalid")
    return decoded


@dataclass(frozen=True, slots=True)
class AuthenticatedUser:
    user_id: str
    session_id: str | None = None
    assurance_level: Literal["aal1", "aal2"] | None = None
    authenticated_at: int | None = None
    token_expires_at: int | None = None
    authenticated: bool = True


def _jwt_claims(token: str) -> dict[str, object]:
    """Decode claims only after `/user` accepted this exact token.

    This function does not validate a signature. The network call above is the trust
    decision; decoding here extracts the session/AAL claims from the already verified
    token and every security-relevant field is cross-checked below.
    """

    parts = token.split(".")
    if len(parts) != 3 or not parts[1] or len(parts[1]) > 16_384:
        raise UnauthorizedUserError("Authentication required")
    invalid = False
    try:
        raw = urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4))
        claims = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError, Base64Error):
        invalid = True
        claims = None
    if invalid:
        raise UnauthorizedUserError("Authentication required")
    if not isinstance(claims, dict):
        raise UnauthorizedUserError("Authentication required")
    return claims


def _integer_claim(claims: dict[str, object], name: str) -> int:
    value = claims.get(name)
    if isinstance(value, bool) or not isinstance(value, int):
        raise UnauthorizedUserError("Authentication required")
    return value


def _authenticated_at(claims: dict[str, object], *, issued_at: int) -> int:
    amr = claims.get("amr")
    if not isinstance(amr, list) or not amr:
        # Older tokens may omit AMR. They remain usable for read/start operations but
        # can never satisfy the recent-auth decision gate.
        return 0
    timestamps: list[int] = []
    for entry in amr:
        if not isinstance(entry, dict):
            raise UnauthorizedUserError("Authentication required")
        method = entry.get("method")
        timestamp = entry.get("timestamp")
        if (
            not isinstance(method, str)
            or not method
            or isinstance(timestamp, bool)
            or not isinstance(timestamp, int)
            or timestamp < 0
            or timestamp > issued_at + _MAX_CLOCK_SKEW_SECONDS
        ):
            raise UnauthorizedUserError("Authentication required")
        if method not in _NON_AUTHENTICATING_AMR_METHODS:
            timestamps.append(timestamp)
    return max(timestamps, default=0)


class SupabaseUserAuthenticator:
    """Resolve a bearer token through Supabase Auth's trusted `/user` endpoint."""

    def __init__(
        self,
        *,
        supabase_url: str,
        anon_key: str,
        production: bool = False,
        timeout_seconds: float = 5.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not supabase_url or not anon_key:
            raise ValueError("Supabase URL and publishable/anonymous key are required")
        if not math.isfinite(timeout_seconds) or not 0 < timeout_seconds <= 15:
            raise ValueError("authentication timeout must be between 0 and 15 seconds")
        self._url = validate_supabase_origin(
            supabase_url,
            supabase_url,
            production=production,
        )
        self._anon_key = anon_key
        self._timeout = timeout_seconds
        self._transport = transport

    @staticmethod
    def _token(authorization: str | None) -> str:
        if not isinstance(authorization, str):
            raise UnauthorizedUserError("Authentication required")
        try:
            match = _BEARER_RE.fullmatch(authorization)
        except (TypeError, UnicodeError):
            match = None
        if match is None:
            raise UnauthorizedUserError("Authentication required")
        return match.group(1)

    async def authenticate(self, authorization: str | None) -> AuthenticatedUser:
        token = self._token(authorization)
        transport_failed = False
        try:
            async with httpx.AsyncClient(
                timeout=self._timeout,
                transport=self._transport,
                follow_redirects=False,
                trust_env=False,
            ) as client:
                async with client.stream(
                    "GET",
                    f"{self._url}/auth/v1/user",
                    headers={
                        "apikey": self._anon_key,
                        "Authorization": f"Bearer {token}",
                        "Accept": "application/json",
                    },
                ) as response:
                    if response.is_redirect:
                        raise AuthenticationUnavailableError("Identity provider is unavailable")
                    if response.status_code in {401, 403}:
                        raise UnauthorizedUserError("Authentication required")
                    if not response.is_success:
                        raise AuthenticationUnavailableError("Identity provider is unavailable")
                    media_type = (
                        response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                    )
                    if media_type != "application/json" and not media_type.endswith("+json"):
                        raise AuthenticationUnavailableError("Identity provider is unavailable")
                    content_lengths = response.headers.get_list("content-length")
                    if len(content_lengths) > 1:
                        raise AuthenticationUnavailableError("Identity provider is unavailable")
                    if content_lengths:
                        content_length = content_lengths[0]
                        if (
                            _CANONICAL_CONTENT_LENGTH_RE.fullmatch(content_length) is None
                            or int(content_length) > _MAX_USER_RESPONSE_BYTES
                        ):
                            raise AuthenticationUnavailableError("Identity provider is unavailable")
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > _MAX_USER_RESPONSE_BYTES:
                            raise AuthenticationUnavailableError("Identity provider is unavailable")
        except (httpx.TimeoutException, httpx.TransportError):
            transport_failed = True
        if transport_failed:
            raise AuthenticationUnavailableError("Identity provider is unavailable")

        invalid_payload = False
        try:
            payload = json.loads(bytes(body).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            invalid_payload = True
            payload = None
        if invalid_payload:
            raise AuthenticationUnavailableError("Identity provider is unavailable")
        if not isinstance(payload, dict):
            raise UnauthorizedUserError("Authentication required")

        user_id = payload.get("id")
        role = payload.get("role")
        audience = payload.get("aud")
        is_anonymous = payload.get("is_anonymous", False)
        if (
            not isinstance(user_id, str)
            or _DATABASE_ID_RE.fullmatch(user_id) is None
            or role != "authenticated"
            or audience not in {None, "authenticated"}
            or is_anonymous is not False
        ):
            raise UnauthorizedUserError("Authentication required")

        claims = _jwt_claims(token)
        now = int(time.time())
        issued_at = _integer_claim(claims, "iat")
        expires_at = _integer_claim(claims, "exp")
        session_id = claims.get("session_id")
        assurance_level = claims.get("aal")
        audience_claim = claims.get("aud")
        audiences = {audience_claim} if isinstance(audience_claim, str) else audience_claim
        expected_issuer = f"{self._url}/auth/v1"
        if (
            claims.get("sub") != user_id
            or claims.get("role") != "authenticated"
            or not isinstance(audiences, list | set)
            or "authenticated" not in audiences
            or claims.get("is_anonymous") is not False
            or claims.get("iss") != expected_issuer
            or not isinstance(session_id, str)
            or _DATABASE_ID_RE.fullmatch(session_id) is None
            or assurance_level not in {"aal1", "aal2"}
            or issued_at > now + _MAX_CLOCK_SKEW_SECONDS
            or expires_at <= now
            or expires_at <= issued_at
        ):
            raise UnauthorizedUserError("Authentication required")
        return AuthenticatedUser(
            user_id=user_id,
            session_id=session_id,
            assurance_level=assurance_level,
            authenticated_at=_authenticated_at(claims, issued_at=issued_at),
            token_expires_at=expires_at,
        )


__all__ = [
    "AuthenticatedUser",
    "AuthenticationUnavailableError",
    "SupabaseUserAuthenticator",
    "UnauthorizedUserError",
    "decode_capability_secret",
]
