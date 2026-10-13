"""Bounded Google Cloud Vision OCR using keyless Application Default Credentials.

Only image bytes are accepted. PDFs must first be rasterized by the isolated
document worker; neither PDF text objects nor document instructions reach OCR.
"""

from __future__ import annotations

import base64
import json
import math
import threading
import time
from typing import Any

import google.auth
import httpx
import requests
from google.auth.transport.requests import Request

from .contracts import MAX_EXTRACTED_CHARACTERS, ExtractionMethod
from .extraction import OcrProviderOutput, validate_document_upload

VISION_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate"
VISION_MODEL_ID = "google-cloud-vision-v1/builtin-stable"
MAX_VISION_RESPONSE_BYTES = 16 * 1024 * 1024
_SCOPES = ("https://www.googleapis.com/auth/cloud-vision",)


class VisionOcrError(RuntimeError):
    """Never propagate provider bodies, image bytes, or credential errors."""

    def __init__(self) -> None:
        super().__init__("vision_ocr_failed")


class _BoundedAuthRequest(Request):
    def __init__(self, *, session: requests.Session, deadline: float) -> None:
        super().__init__(session=session)
        self._deadline = deadline

    def __call__(self, *args: Any, timeout: float | None = None, **kwargs: Any) -> Any:
        remaining = self._deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("vision_auth_timeout")
        return super().__call__(*args, timeout=min(timeout or 5.0, 5.0, remaining), **kwargs)


class GoogleVisionOcrClient:
    def __init__(
        self,
        credentials: Any,
        *,
        timeout_seconds: float = 25.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        if not math.isfinite(timeout_seconds) or not 1 <= timeout_seconds <= 30:
            raise ValueError("vision_timeout_invalid")
        self._credentials = credentials
        self._timeout_seconds = timeout_seconds
        self._transport = transport
        self._auth_lock = threading.Lock()

    @classmethod
    def from_environment(
        cls, *, quota_project_id: str | None, timeout_seconds: float
    ) -> GoogleVisionOcrClient:
        try:
            credentials, _ = google.auth.default(
                scopes=_SCOPES,
                quota_project_id=quota_project_id,
            )
            return cls(credentials, timeout_seconds=timeout_seconds)
        except Exception:
            raise VisionOcrError() from None

    def extract_text(self, content: bytes, mime_type: str) -> OcrProviderOutput:
        if mime_type not in {"image/png", "image/jpeg"}:
            raise VisionOcrError()
        validate_document_upload(content, mime_type)
        started = time.monotonic()
        headers = {"Content-Type": "application/json"}
        try:
            # ADC refresh is serialized and happens only when required. Cloud Run
            # uses its runtime identity; local development uses developer ADC.
            if not self._auth_lock.acquire(timeout=self._timeout_seconds):
                raise TimeoutError()
            try:
                with requests.Session() as auth_session:
                    auth_session.trust_env = False
                    self._credentials.before_request(
                        _BoundedAuthRequest(
                            session=auth_session, deadline=started + self._timeout_seconds
                        ),
                        "POST",
                        VISION_ENDPOINT,
                        headers,
                    )
            finally:
                self._auth_lock.release()
            remaining = self._timeout_seconds - (time.monotonic() - started)
            if remaining <= 0:
                raise TimeoutError()
            with httpx.Client(
                timeout=httpx.Timeout(remaining, connect=min(5.0, remaining)),
                follow_redirects=False,
                trust_env=False,
                transport=self._transport,
            ) as client:
                with client.stream(
                    "POST",
                    VISION_ENDPOINT,
                    headers=headers,
                    json={
                        "requests": [
                            {
                                "image": {"content": base64.b64encode(content).decode("ascii")},
                                "features": [
                                    {"type": "DOCUMENT_TEXT_DETECTION", "model": "builtin/stable"}
                                ],
                            }
                        ]
                    },
                ) as response:
                    if response.status_code != 200:
                        raise VisionOcrError()
                    payload = bytearray()
                    for chunk in response.iter_bytes():
                        if time.monotonic() - started > self._timeout_seconds:
                            raise TimeoutError()
                        if len(payload) + len(chunk) > MAX_VISION_RESPONSE_BYTES:
                            raise VisionOcrError()
                        payload.extend(chunk)
            return self._parse_response(json.loads(payload))
        except (TimeoutError, httpx.TimeoutException):
            raise TimeoutError("vision_ocr_timeout") from None
        except Exception:
            raise VisionOcrError() from None

    @staticmethod
    def _parse_response(payload: object) -> OcrProviderOutput:
        if not isinstance(payload, dict) or payload.get("error"):
            raise VisionOcrError()
        responses = payload.get("responses")
        if not isinstance(responses, list) or len(responses) != 1:
            raise VisionOcrError()
        result = responses[0]
        if not isinstance(result, dict) or result.get("error"):
            raise VisionOcrError()
        # Vision represents a successful image with no detected text as {}.
        # Preserve an explicit blank page; the aggregate quality gate rejects
        # an entirely blank document, but can retain valid page numbering.
        if result == {}:
            return OcrProviderOutput(
                text="",
                model_id=VISION_MODEL_ID,
                finish_reason="STOP",
                extraction_method=ExtractionMethod.GOOGLE_CLOUD_VISION,
            )
        annotation = result.get("fullTextAnnotation")
        if not isinstance(annotation, dict):
            raise VisionOcrError()
        text = annotation.get("text")
        pages = annotation.get("pages")
        if (
            not isinstance(text, str)
            or not text.strip()
            or len(text) > MAX_EXTRACTED_CHARACTERS
            or not isinstance(pages, list)
            or len(pages) != 1
            or not isinstance(pages[0], dict)
        ):
            raise VisionOcrError()
        return OcrProviderOutput(
            text=text,
            model_id=VISION_MODEL_ID,
            finish_reason="STOP",
            extraction_method=ExtractionMethod.GOOGLE_CLOUD_VISION,
        )
