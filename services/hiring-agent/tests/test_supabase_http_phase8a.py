import asyncio
import base64
import json

import httpx
import pytest

from teamflow_hiring_agent.supabase_http import (
    SupabaseBoundaryError,
    SupabaseJSONClient,
    scoped_merchant_id_from_jwt,
    validate_supabase_origin,
)


def _client(
    handler,
    *,
    max_response_bytes: int = 1024,
) -> SupabaseJSONClient:
    return SupabaseJSONClient(
        url="https://project.supabase.test",
        trusted_origin="https://project.supabase.test",
        api_key="publishable-key",
        access_token="scoped-reader-token",
        production=False,
        timeout_seconds=1.0,
        max_response_bytes=max_response_bytes,
        transport=httpx.MockTransport(handler),
    )


def test_scoped_credentials_are_sent_only_to_the_exact_trusted_origin() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://project.supabase.test/rest/v1/jobs?select=id"
        assert request.headers["apikey"] == "publishable-key"
        assert request.headers["authorization"] == "Bearer scoped-reader-token"
        return httpx.Response(200, json=[{"id": "role-1"}])

    response = asyncio.run(_client(handler).request_json("GET", "/rest/v1/jobs?select=id"))

    assert response.status_code == 200
    assert response.payload == [{"id": "role-1"}]


@pytest.mark.parametrize(
    ("url", "trusted"),
    [
        ("https://project.supabase.co", "https://other.supabase.co"),
        ("http://project.supabase.co", "http://project.supabase.co"),
        ("https://user@project.supabase.co", "https://project.supabase.co"),
        ("https://project.supabase.co/rest/v1", "https://project.supabase.co"),
        ("https://project.supabase.co?redirect=evil", "https://project.supabase.co"),
        ("https://project.supabase.co:8443", "https://project.supabase.co:8443"),
    ],
)
def test_production_origin_validation_fails_closed(url: str, trusted: str) -> None:
    with pytest.raises(ValueError):
        validate_supabase_origin(url, trusted, production=True)


def test_redirect_is_refused_without_forwarding_credentials() -> None:
    requested_origins: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested_origins.append(f"{request.url.scheme}://{request.url.host}")
        return httpx.Response(
            307,
            headers={"location": "https://attacker.test/collect"},
            json={"redirect": True},
        )

    with pytest.raises(SupabaseBoundaryError, match="redirect"):
        asyncio.run(_client(handler).request_json("GET", "/rest/v1/jobs?select=id"))

    assert requested_origins == ["https://project.supabase.test"]


@pytest.mark.parametrize(
    "header_name",
    [
        "Authorization",
        "APIKey",
        "HOST",
        "Content-Type",
        "Content-Length",
        "Transfer-Encoding",
        "Proxy-Authorization",
    ],
)
def test_extra_headers_cannot_override_credentials_or_transport_headers(
    header_name: str,
) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("reserved headers must be rejected before transport")

    with pytest.raises(ValueError, match="cannot override reserved headers"):
        asyncio.run(
            _client(handler).request_json(
                "GET",
                "/rest/v1/jobs?select=id",
                extra_headers={header_name: "attacker-controlled"},
            )
        )


def test_non_reserved_extra_header_preserves_scoped_credentials() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer scoped-reader-token"
        assert request.headers["apikey"] == "publishable-key"
        assert request.headers["prefer"] == "return=representation"
        return httpx.Response(200, json=[])

    response = asyncio.run(
        _client(handler).request_json(
            "POST",
            "/rest/v1/candidate_reviews",
            json_body={"candidate_id": "candidate-1"},
            extra_headers={"Prefer": "return=representation"},
        )
    )

    assert response.status_code == 200
    assert response.payload == []


class _ChunkedBody(httpx.AsyncByteStream):
    async def __aiter__(self):
        yield b"[1234"
        yield b"567890]"


def test_streamed_response_cap_does_not_trust_content_length() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "application/json", "content-length": "1"},
            stream=_ChunkedBody(),
        )

    with pytest.raises(SupabaseBoundaryError, match="too large"):
        asyncio.run(
            _client(handler, max_response_bytes=8).request_json(
                "GET",
                "/rest/v1/jobs?select=id",
            )
        )


def test_non_json_and_malformed_json_responses_are_rejected() -> None:
    responses = iter(
        (
            httpx.Response(200, text="<html>no</html>", headers={"content-type": "text/html"}),
            httpx.Response(
                200,
                content=b"{not-json}",
                headers={"content-type": "application/json"},
            ),
        )
    )

    def handler(_request: httpx.Request) -> httpx.Response:
        return next(responses)

    client = _client(handler)
    with pytest.raises(SupabaseBoundaryError, match="not JSON"):
        asyncio.run(client.request_json("GET", "/rest/v1/jobs?select=id"))
    with pytest.raises(SupabaseBoundaryError, match="invalid JSON"):
        asyncio.run(client.request_json("GET", "/rest/v1/jobs?select=id"))


def test_scoped_jwt_requires_role_expiry_and_canonical_merchant_claim() -> None:
    merchant_id = "00000000-0000-0000-0000-000000000001"
    payload = (
        base64.urlsafe_b64encode(
            json.dumps(
                {
                    "role": "teamflow_hiring_reader",
                    "merchant_id": merchant_id,
                    "exp": 4_102_444_800,
                },
                separators=(",", ":"),
            ).encode()
        )
        .decode()
        .rstrip("=")
    )
    token = f"header.{payload}.signature"

    assert (
        scoped_merchant_id_from_jwt(
            token,
            expected_role="teamflow_hiring_reader",
        )
        == merchant_id
    )
    with pytest.raises(ValueError):
        scoped_merchant_id_from_jwt(
            token,
            expected_role="teamflow_review_writer",
        )
