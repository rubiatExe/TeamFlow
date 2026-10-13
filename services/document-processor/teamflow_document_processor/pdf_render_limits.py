"""Shared hard limits for the pixel-only PDF boundary (no parser imports)."""

MAX_RENDERED_PDF_PAGES = 5
PDF_RENDER_SCALE = 2.0  # 144 DPI for standard 1/72-inch PDF canvas units.
MAX_PDF_PAGE_PIXELS = 8_000_000
MAX_PDF_PAGE_DIMENSION = 4_096
MAX_PDF_PAGE_PNG_BYTES = 8 * 1024 * 1024
MAX_PDF_TOTAL_PNG_BYTES = 16 * 1024 * 1024
MAX_PDF_RENDER_OUTPUT_BYTES = 24 * 1024 * 1024
