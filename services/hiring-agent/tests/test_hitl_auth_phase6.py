import asyncio
import base64
import json
import time

import httpx
import pytest

from teamflow_hiring_agent.resume_review.hitl.auth import (
    AuthenticationUnavailableError,
    SupabaseUserAuthenticator,
    UnauthorizedUserError,
    decode_capability_secret,
)

VALID_USER_ID = "10000000-0000-0000-0000-000000000001"
VALID_SESSION_ID = "20000000-0000-0000-0000-000000000002"


def test_capability_secret_requires_canonical_unpadded_base64url() -> None:
    raw = bytes(range(32))
    encoded = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    assert decode_capability_secret(encoded) == raw


@pytest.mark.parametrize(
    "value",
    [
        "",
        "weak",
        " " + base64.urlsafe_b64encode(b"a" * 32).decode("ascii").rstrip("="),
        base64.urlsafe_b64encode(b"a" * 32).decode("ascii"),
        base64.urlsafe_b64encode(b"a" * 31).decode("ascii").rstrip("="),
        base64.urlsafe_b64encode(b"a" * 65).decode("ascii").rstrip("="),
        base64.urlsafe_b64encode(b"a" * 32).decode("ascii").rstrip("=") + "\n",
    ],
)
def test_capability_secret_rejects_weak_noncanonical_or_control_values(
    value: str,
) -> None:
    with pytest.raises(ValueError) as captured:
        decode_capability_secret(value)
    assert str(captured.value) == "hitl_capability_secret_invalid"
    if value:
        assert value not in str(captured.value)


def access_token(**changes: object) -> str:
    now = int(time.time())
    claims: dict[str, object] = {
        "iss": "https://project.example.test/auth/v1",
        "aud": "authenticated",
        "exp": now + 3600,
        "iat": now,
        "sub": VALID_USER_ID,
        "role": "authenticated",
        "aal": "aal2",
        "session_id": VALID_SESSION_ID,
        "is_anonymous": False,
        "amr": [
            {"method": "password", "timestamp": now - 5},
            {"method": "totp", "timestamp": now},
        ],
    }
    claims.update(changes)
    encoded = (
        base64.urlsafe_b64encode(json.dumps(claims, separators=(",", ":")).encode("utf-8"))
        .decode("ascii")
        .rstrip("=")
    )
    return f"eyJhbGciOiJSUzI1NiJ9.{encoded}.test-signature"


def run(coro):
    return asyncio.run(coro)


def authenticator(handler) -> SupabaseUserAuthenticator:
    return SupabaseUserAuthenticator(
        supabase_url="https://project.example.test",
        anon_key="publishable-test-key",
        transport=httpx.MockTransport(handler),
    )


@pytest.mark.parametrize(
    "authorization",
    [None, "", "Basic abc", "Bearer", "Bearer ", "Bearer one two", "Bearer \ud800"],
)
def test_authenticator_rejects_missing_or_malformed_bearer_without_network(
    authorization: str | None,
) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(500)

    with pytest.raises(UnauthorizedUserError):
        run(authenticator(handler).authenticate(authorization))
    assert calls == 0


def test_authenticator_uses_supabase_auth_user_endpoint_and_returns_verified_identity() -> None:
    token = access_token()

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert request.url == "https://project.example.test/auth/v1/user"
        assert request.headers["apikey"] == "publishable-test-key"
        assert request.headers["authorization"] == f"Bearer {token}"
        return httpx.Response(
            200,
            json={
                "id": VALID_USER_ID,
                "aud": "authenticated",
                "role": "authenticated",
                "is_anonymous": False,
                "user_metadata": {"merchant_id": "must-not-be-trusted"},
            },
        )

    identity = run(authenticator(handler).authenticate(f"Bearer {token}"))
    assert identity.user_id == VALID_USER_ID
    assert identity.session_id == VALID_SESSION_ID
    assert identity.assurance_level == "aal2"
    assert identity.authenticated_at is not None
    assert identity.authenticated is True
    assert not hasattr(identity, "merchant_id")


@pytest.mark.parametrize(
    "claim_changes",
    [
        {"iss": "https://attacker.example/auth/v1"},
        {"aud": "anon"},
        {"sub": "30000000-0000-0000-0000-000000000003"},
        {"session_id": "not-a-session"},
        {"aal": "aal3"},
        {"exp": 1},
        {"iat": int(time.time()) + 120},
        {"amr": [{"method": "totp", "timestamp": int(time.time()) + 120}]},
    ],
)
def test_authenticator_rejects_inconsistent_verified_token_claims(
    claim_changes: dict[str, object],
) -> None:
    token = access_token(**claim_changes)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": VALID_USER_ID,
                "aud": "authenticated",
                "role": "authenticated",
                "is_anonymous": False,
            },
        )

    with pytest.raises(UnauthorizedUserError):
        run(authenticator(handler).authenticate(f"Bearer {token}"))


def test_aal1_identity_is_valid_for_reads_but_retains_assurance_provenance() -> None:
    token = access_token(
        aal="aal1",
        amr=[{"method": "password", "timestamp": int(time.time())}],
    )

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": VALID_USER_ID,
                "aud": "authenticated",
                "role": "authenticated",
                "is_anonymous": False,
            },
        )

    identity = run(authenticator(handler).authenticate(f"Bearer {token}"))
    assert identity.assurance_level == "aal1"
    assert identity.authenticated_at is not None


@pytest.mark.parametrize(
    "status,payload",
    [
        (401, {"message": "invalid token"}),
        (200, {"id": "not-a-uuid", "role": "authenticated"}),
        (200, {"id": VALID_USER_ID, "role": "anon", "is_anonymous": False}),
        (200, {"id": VALID_USER_ID, "role": "authenticated", "is_anonymous": True}),
    ],
)
def test_authenticator_fails_closed_for_unverified_or_anonymous_users(
    status: int,
    payload: dict[str, object],
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=payload)

    with pytest.raises(UnauthorizedUserError):
        run(authenticator(handler).authenticate("Bearer untrusted-token"))


def test_authenticator_classifies_provider_outage_without_leaking_provider_body() -> None:
    private_canary = "private-upstream-canary"

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(private_canary, request=request)

    with pytest.raises(AuthenticationUnavailableError) as caught:
        run(authenticator(handler).authenticate("Bearer token"))
    assert str(caught.value) == "Identity provider is unavailable"
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None
    assert private_canary not in repr(caught.value)


def test_authenticator_rejects_oversized_token_before_network() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(500)

    with pytest.raises(UnauthorizedUserError):
        run(authenticator(handler).authenticate(f"Bearer {'x' * 8193}"))
    assert calls == 0


class _OversizedUserBody(httpx.AsyncByteStream):
    async def __aiter__(self):
        yield b'{"id":"' + (b"a" * 32_768)
        yield b"b" * 32_769 + b'"}'


def test_authenticator_stream_caps_chunked_body_without_trusting_length() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "application/json", "content-length": "1"},
            stream=_OversizedUserBody(),
        )

    with pytest.raises(AuthenticationUnavailableError):
        run(authenticator(handler).authenticate("Bearer verified-user-token"))


def test_authenticator_rejects_non_json_success() -> None:
    private_canary = "private-json-canary"

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            text=f'{{"id":"{private_canary}"',
            headers={"content-type": "application/json"},
        )

    with pytest.raises(AuthenticationUnavailableError) as caught:
        run(authenticator(handler).authenticate("Bearer verified-user-token"))
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None
    assert private_canary not in repr(caught.value)


def test_authenticator_rejects_noncanonical_content_length_without_exception_chain() -> None:
    private_canary = "private-content-length-canary"

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b"{}",
            headers={
                "content-type": "application/json",
                "content-length": private_canary,
            },
        )

    with pytest.raises(AuthenticationUnavailableError) as caught:
        run(authenticator(handler).authenticate("Bearer verified-user-token"))
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None
    assert private_canary not in repr(caught.value)


def test_authenticator_rejects_malformed_verified_claims_without_exception_chain() -> None:
    private_canary = "private-claim-canary"
    encoded = base64.urlsafe_b64encode(private_canary.encode()).decode().rstrip("=")
    token = f"header.{encoded}.signature"

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": VALID_USER_ID,
                "aud": "authenticated",
                "role": "authenticated",
                "is_anonymous": False,
            },
        )

    with pytest.raises(UnauthorizedUserError) as caught:
        run(authenticator(handler).authenticate(f"Bearer {token}"))
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None
    assert private_canary not in repr(caught.value)


def test_authenticator_refuses_redirect_without_forwarding_credentials() -> None:
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        return httpx.Response(
            307,
            headers={"location": "https://attacker.test/collect"},
            json={"redirect": True},
        )

    with pytest.raises(AuthenticationUnavailableError):
        run(authenticator(handler).authenticate("Bearer verified-user-token"))
    assert requests == ["https://project.example.test/auth/v1/user"]


@pytest.mark.parametrize("timeout", [float("nan"), float("inf"), 0.0, 15.1])
def test_authenticator_rejects_invalid_timeouts(timeout: float) -> None:
    with pytest.raises(ValueError):
        SupabaseUserAuthenticator(
            supabase_url="https://project.example.test",
            anon_key="publishable-test-key",
            timeout_seconds=timeout,
        )
