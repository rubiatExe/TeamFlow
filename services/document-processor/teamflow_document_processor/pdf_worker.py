"""Resource-isolated PDF text/visibility worker.

The API process launches this module in Python isolated mode. Untrusted PDF
decompression therefore has a killable deadline and, in the Linux deployment,
an address-space ceiling independent of the request-serving process.
"""

from __future__ import annotations

import json
import resource
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from teamflow_document_processor.extraction import (  # noqa: E402
    MAX_DOCUMENT_BYTES,
    DocumentStructureError,
    _read_pdf_pages,
)

MAX_ADDRESS_SPACE_BYTES = 256 * 1024 * 1024
MAX_CPU_SECONDS = 10


def _apply_resource_limits() -> None:
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
    if sys.platform.startswith("linux"):
        resource.setrlimit(
            resource.RLIMIT_AS,
            (MAX_ADDRESS_SPACE_BYTES, MAX_ADDRESS_SPACE_BYTES),
        )
        resource.setrlimit(
            resource.RLIMIT_CPU,
            (MAX_CPU_SECONDS, MAX_CPU_SECONDS),
        )


def _emit(payload: dict[str, object]) -> None:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("utf-8")
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def main() -> int:
    try:
        _apply_resource_limits()
        content = sys.stdin.buffer.read(MAX_DOCUMENT_BYTES + 1)
        if len(content) > MAX_DOCUMENT_BYTES:
            raise ValueError("pdf_input_too_large")
        pages, page_count, pages_requiring_ocr = _read_pdf_pages(content)
        _emit(
            {
                "version": 1,
                "status": "ok",
                "pages": pages,
                "page_count": page_count,
                "pages_requiring_ocr": pages_requiring_ocr,
            }
        )
        return 0
    except DocumentStructureError as exc:
        _emit(
            {
                "version": 1,
                "status": "error",
                "warning": exc.warning.value,
                "reason": exc.reason.value,
            }
        )
        return 0
    except (MemoryError, ValueError, OSError, RuntimeError):
        _emit(
            {
                "version": 1,
                "status": "error",
                "warning": "malformed_document",
                "reason": "malformed_document",
            }
        )
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
