"""Rasterize untrusted PDFs in a killable, resource-bounded child process.

Only PNG pixels cross this boundary. PDF text objects, metadata, attachments,
and hidden text are never returned to the application or an OCR provider.
"""

from __future__ import annotations

import base64
import io
import json
import math
import resource
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from teamflow_document_processor.pdf_render_limits import (  # noqa: E402
    MAX_PDF_PAGE_DIMENSION,
    MAX_PDF_PAGE_PIXELS,
    MAX_PDF_PAGE_PNG_BYTES,
    MAX_PDF_RENDER_OUTPUT_BYTES,
    MAX_PDF_TOTAL_PNG_BYTES,
    MAX_RENDERED_PDF_PAGES,
    PDF_RENDER_SCALE,
)

MAX_INPUT_BYTES = 10 * 1024 * 1024
MAX_ADDRESS_SPACE_BYTES = 256 * 1024 * 1024
MAX_CPU_SECONDS = 10


class RenderRejected(ValueError):
    pass


class BoundedPngBuffer(io.BytesIO):
    def write(self, data: bytes) -> int:
        if self.tell() + len(data) > MAX_PDF_PAGE_PNG_BYTES:
            raise RenderRejected("malformed_document")
        return super().write(data)


def _apply_resource_limits() -> None:
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
    resource.setrlimit(resource.RLIMIT_CPU, (MAX_CPU_SECONDS, MAX_CPU_SECONDS))
    # macOS does not reliably implement RLIMIT_AS; deployed Linux does.
    if sys.platform.startswith("linux"):
        resource.setrlimit(resource.RLIMIT_AS, (MAX_ADDRESS_SPACE_BYTES, MAX_ADDRESS_SPACE_BYTES))


def _render(content: bytes) -> list[str]:
    # Import native/parser dependencies only after installing resource limits.
    import pypdfium2 as pdfium
    from pypdf import PdfReader

    # Strict structural validation prevents PDFium's repair behavior from
    # silently accepting truncated files. Never call extract_text here.
    reader = PdfReader(io.BytesIO(content), strict=True)
    if reader.is_encrypted:
        raise RenderRejected("encrypted_document")
    page_count = len(reader.pages)
    if page_count == 0:
        raise RenderRejected("malformed_document")
    if page_count > MAX_RENDERED_PDF_PAGES:
        raise RenderRejected("page_limit_exceeded")

    pages: list[str] = []
    total_bytes = 0
    with pdfium.PdfDocument(content) as document:
        # Initialize before querying pages, as required by PDFium's forms API.
        # Render visible widget appearances as well as normal page annotations.
        document.init_forms()
        if len(document) != page_count:
            raise RenderRejected("malformed_document")
        for index in range(page_count):
            page = document[index]
            try:
                width, height = page.get_size()
                if not all(math.isfinite(value) and value > 0 for value in (width, height)):
                    raise RenderRejected("malformed_document")
                pixel_width = math.ceil(width * PDF_RENDER_SCALE)
                pixel_height = math.ceil(height * PDF_RENDER_SCALE)
                if (
                    max(pixel_width, pixel_height) > MAX_PDF_PAGE_DIMENSION
                    or pixel_width * pixel_height > MAX_PDF_PAGE_PIXELS
                ):
                    raise RenderRejected("malformed_document")
                bitmap = page.render(
                    scale=PDF_RENDER_SCALE,
                    draw_annots=True,
                    fill_color=(255, 255, 255, 255),
                )
                try:
                    with bitmap.to_pil() as image, BoundedPngBuffer() as buffer:
                        image.save(buffer, format="PNG")
                        png = buffer.getvalue()
                finally:
                    bitmap.close()
                total_bytes += len(png)
                if total_bytes > MAX_PDF_TOTAL_PNG_BYTES:
                    raise RenderRejected("malformed_document")
                pages.append(base64.b64encode(png).decode("ascii"))
            finally:
                page.close()
    return pages


def main() -> int:
    try:
        _apply_resource_limits()
        content = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if not content.startswith(b"%PDF-") or len(content) > MAX_INPUT_BYTES:
            raise RenderRejected("malformed_document")
        pages = _render(content)
        payload = {"version": 1, "status": "ok", "pages": pages, "page_count": len(pages)}
    except RenderRejected as exc:
        payload = {"version": 1, "status": "error", "warning": str(exc)}
    except Exception:
        # Never leak PDF contents, parser messages, or host paths.
        payload = {"version": 1, "status": "error", "warning": "malformed_document"}
    encoded = json.dumps(payload, separators=(",", ":")).encode("ascii")
    if len(encoded) > MAX_PDF_RENDER_OUTPUT_BYTES:
        return 1
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
