import base64
import json

import httpx
import pytest
from teamflow_document_processor.contracts import ExtractionMethod
from teamflow_document_processor.vision import (
    VISION_ENDPOINT,
    VISION_MODEL_ID,
    GoogleVisionOcrClient,
    VisionOcrError,
)

IMAGE = b"\x89PNG\r\n\x1a\nsynthetic image provider fixture"
TEXT = "Alex Example\nBarista at Harbor Cafe\nCustomer service and espresso preparation."


class Credentials:
    def before_request(self, request, method, url, headers):
        assert method == "POST"
        assert url == VISION_ENDPOINT
        headers["authorization"] = "Bearer private-test-token"
        headers["x-goog-user-project"] = "test-project"


def response_payload():
    return {"responses": [{"fullTextAnnotation": {"text": TEXT, "pages": [{}]}}]}


def test_vision_uses_fixed_endpoint_adc_and_document_text_detection():
    def handler(request):
        assert str(request.url) == VISION_ENDPOINT
        assert request.headers["authorization"] == "Bearer private-test-token"
        assert request.headers["x-goog-user-project"] == "test-project"
        payload = json.loads(request.content)
        assert payload == {
            "requests": [
                {
                    "image": {"content": base64.b64encode(IMAGE).decode()},
                    "features": [{"type": "DOCUMENT_TEXT_DETECTION", "model": "builtin/stable"}],
                }
            ]
        }
        return httpx.Response(200, json=response_payload())

    result = GoogleVisionOcrClient(
        Credentials(), transport=httpx.MockTransport(handler)
    ).extract_text(IMAGE, "image/png")
    assert result.text == TEXT
    assert result.model_id == VISION_MODEL_ID
    assert result.extraction_method is ExtractionMethod.GOOGLE_CLOUD_VISION
    assert result.finish_reason == "STOP"


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"responses": []},
        {"responses": [{}, {}]},
        {"error": {"message": "PRIVATE_PROVIDER_DETAIL"}},
        {"responses": [{"error": {"message": "PRIVATE_PROVIDER_DETAIL"}}]},
        {"responses": [{"fullTextAnnotation": {"text": "", "pages": [{}]}}]},
        {"responses": [{"fullTextAnnotation": {"text": TEXT, "pages": []}}]},
        {"responses": [{"fullTextAnnotation": {"text": TEXT, "pages": [{}, {}]}}]},
        {"responses": [{"fullTextAnnotation": {"text": "a" * 100_001, "pages": [{}]}}]},
    ],
)
def test_invalid_partial_and_empty_responses_fail_closed(payload):
    client = GoogleVisionOcrClient(
        Credentials(),
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=payload)),
    )
    with pytest.raises(VisionOcrError, match="^vision_ocr_failed$"):
        client.extract_text(IMAGE, "image/png")


@pytest.mark.parametrize("status", [301, 401, 403, 429, 500, 503])
def test_provider_http_errors_are_sanitized_without_retries(status):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(
            status, headers={"location": "https://untrusted.invalid"}, text="PRIVATE"
        )

    client = GoogleVisionOcrClient(Credentials(), transport=httpx.MockTransport(handler))
    with pytest.raises(VisionOcrError, match="^vision_ocr_failed$"):
        client.extract_text(IMAGE, "image/png")
    assert len(calls) == 1


def test_pdfs_never_reach_vision_directly():
    def handler(request):
        raise AssertionError("PDF sent to provider")

    client = GoogleVisionOcrClient(Credentials(), transport=httpx.MockTransport(handler))
    with pytest.raises(VisionOcrError):
        client.extract_text(b"%PDF-1.7", "application/pdf")


def test_successfully_scanned_blank_page_is_distinct_from_provider_failure():
    result = GoogleVisionOcrClient._parse_response({"responses": [{}]})
    assert result.text == ""
    assert result.finish_reason == "STOP"
    assert result.extraction_method is ExtractionMethod.GOOGLE_CLOUD_VISION


def test_auth_transport_refuses_requests_after_shared_deadline():
    import requests
    from teamflow_document_processor.vision import _BoundedAuthRequest

    with requests.Session() as session:
        request = _BoundedAuthRequest(session=session, deadline=0)
        with pytest.raises(TimeoutError, match="vision_auth_timeout"):
            request("https://oauth2.googleapis.com/token")


def test_credentials_errors_are_sanitized():
    class BrokenCredentials:
        def before_request(self, *args):
            raise RuntimeError("PRIVATE_REFRESH_TOKEN")

    with pytest.raises(VisionOcrError, match="^vision_ocr_failed$"):
        GoogleVisionOcrClient(BrokenCredentials()).extract_text(IMAGE, "image/png")


def test_vision_timeout_is_not_reported_as_success():
    def handler(request):
        raise httpx.ReadTimeout("PRIVATE_PROVIDER_DETAIL")

    client = GoogleVisionOcrClient(Credentials(), transport=httpx.MockTransport(handler))
    with pytest.raises(TimeoutError, match="^vision_ocr_timeout$"):
        client.extract_text(IMAGE, "image/png")


def test_response_size_is_bounded(monkeypatch):
    import teamflow_document_processor.vision as vision

    monkeypatch.setattr(vision, "MAX_VISION_RESPONSE_BYTES", 10)
    client = GoogleVisionOcrClient(
        Credentials(),
        transport=httpx.MockTransport(lambda request: httpx.Response(200, text="a" * 11)),
    )
    with pytest.raises(VisionOcrError):
        client.extract_text(IMAGE, "image/png")


def test_adc_uses_vision_scope_and_explicit_quota_project(monkeypatch):
    import teamflow_document_processor.vision as vision

    def default(**kwargs):
        assert kwargs == {
            "scopes": ("https://www.googleapis.com/auth/cloud-vision",),
            "quota_project_id": "test-project",
        }
        return Credentials(), "test-project"

    monkeypatch.setattr(vision.google.auth, "default", default)
    assert GoogleVisionOcrClient.from_environment(
        quota_project_id="test-project", timeout_seconds=25
    )
