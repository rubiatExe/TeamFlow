"""Regenerate the synthetic Phase 3 PDFs with pinned authoring dependencies."""

from __future__ import annotations

import hashlib
import json
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

FIXTURE_DIR = Path(__file__).resolve().parent
DIGITAL_PATH = FIXTURE_DIR / "digital-resume.pdf"
SCANNED_PATH = FIXTURE_DIR / "scanned-resume.pdf"
CORRUPT_PATH = FIXTURE_DIR / "corrupt-truncated.pdf"

DIGITAL_CRITICAL_TEXT = [
    "Jordan Rivera",
    "Northstar Cafe",
    "2022-2025",
    "jordan.rivera@example.test",
    "+1 202-555-0147",
]
SCANNED_CRITICAL_TEXT = [
    "Morgan Lee",
    "Harbor Cafe",
    "2021-2024",
    "morgan.lee@example.test",
    "202-555-0188",
]


def _metadata(pdf: canvas.Canvas, title: str) -> None:
    pdf.setTitle(title)
    pdf.setAuthor("TeamFlow synthetic test fixture")
    pdf.setSubject("Privacy-safe document extraction regression fixture")
    pdf.setCreator("TeamFlow Phase 3 fixture generator")


def generate_digital_resume() -> bytes:
    output = BytesIO()
    pdf = canvas.Canvas(
        output,
        pagesize=letter,
        pageCompression=1,
        invariant=True,
    )
    _metadata(pdf, "Synthetic Digital Resume")
    width, height = letter
    left = 54
    y = height - 58

    pdf.setFillColorRGB(0.12, 0.18, 0.16)
    pdf.setFont("Helvetica-Bold", 22)
    pdf.drawString(left, y, "Jordan Rivera")
    y -= 24
    pdf.setFillColorRGB(0.25, 0.31, 0.29)
    pdf.setFont("Helvetica", 10)
    pdf.drawString(
        left,
        y,
        "jordan.rivera@example.test | +1 202-555-0147 | Portland, OR",
    )

    y -= 40
    pdf.setFillColorRGB(0.10, 0.42, 0.30)
    pdf.setFont("Helvetica-Bold", 13)
    pdf.drawString(left, y, "EXPERIENCE")
    pdf.setStrokeColorRGB(0.75, 0.82, 0.78)
    pdf.line(left, y - 5, width - left, y - 5)

    y -= 28
    pdf.setFillColorRGB(0.12, 0.18, 0.16)
    pdf.setFont("Helvetica-Bold", 11)
    pdf.drawString(left, y, "Shift Lead - Northstar Cafe")
    pdf.setFont("Helvetica", 10)
    pdf.drawRightString(width - left, y, "2022-2025")
    y -= 19
    pdf.drawString(left + 12, y, "Managed daily opening, inventory, and guest service operations.")
    y -= 17
    pdf.drawString(left + 12, y, "Trained six baristas and maintained espresso quality standards.")

    y -= 35
    pdf.setFillColorRGB(0.10, 0.42, 0.30)
    pdf.setFont("Helvetica-Bold", 13)
    pdf.drawString(left, y, "SKILLS")
    pdf.line(left, y - 5, width - left, y - 5)
    y -= 27
    pdf.setFillColorRGB(0.12, 0.18, 0.16)
    pdf.setFont("Helvetica", 10)
    pdf.drawString(
        left,
        y,
        "Espresso preparation, customer service, inventory, staff training",
    )

    pdf.setFillColorRGB(0.45, 0.49, 0.47)
    pdf.setFont("Helvetica-Oblique", 8)
    pdf.drawString(left, 34, "Synthetic fixture - no real person or contact details")
    pdf.showPage()
    pdf.save()
    return output.getvalue()


def _font(size: int, *, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    # Pillow's bundled default avoids host-font drift. Weight is intentionally
    # represented by size/layout rather than an operating-system font lookup.
    del bold
    return ImageFont.load_default(size=size)


def generate_scanned_resume() -> bytes:
    image = Image.new("RGB", (1275, 1650), "white")
    draw = ImageDraw.Draw(image)
    heading = _font(44, bold=True)
    section = _font(26, bold=True)
    body = _font(22)
    muted = (70, 78, 75)
    accent = (24, 106, 76)

    draw.text((95, 90), "Morgan Lee", font=heading, fill=(25, 35, 32))
    draw.text(
        (95, 155),
        "morgan.lee@example.test | 202-555-0188 | Baltimore, MD",
        font=body,
        fill=muted,
    )
    draw.text((95, 255), "EXPERIENCE", font=section, fill=accent)
    draw.line((95, 298, 1180, 298), fill=(185, 204, 196), width=3)
    draw.text((95, 335), "Barista - Harbor Cafe", font=section, fill=(25, 35, 32))
    draw.text((950, 340), "2021-2024", font=body, fill=(25, 35, 32))
    draw.text(
        (120, 400),
        "Prepared espresso drinks and supported high-volume guest service.",
        font=body,
        fill=(25, 35, 32),
    )
    draw.text(
        (120, 445),
        "Completed cash reconciliation and weekly inventory counts.",
        font=body,
        fill=(25, 35, 32),
    )
    draw.text((95, 550), "SKILLS", font=section, fill=accent)
    draw.line((95, 593, 1180, 593), fill=(185, 204, 196), width=3)
    draw.text(
        (95, 635),
        "Espresso, POS, customer service, inventory",
        font=body,
        fill=(25, 35, 32),
    )
    draw.text(
        (95, 1530),
        "Synthetic image-only fixture - no real person or contact details",
        font=_font(17),
        fill=(115, 120, 118),
    )

    image_bytes = BytesIO()
    image.save(image_bytes, format="PNG", optimize=False)
    image_bytes.seek(0)

    output = BytesIO()
    pdf = canvas.Canvas(
        output,
        pagesize=letter,
        pageCompression=1,
        invariant=True,
    )
    _metadata(pdf, "Synthetic Scanned Resume")
    pdf.drawImage(
        ImageReader(image_bytes),
        0,
        0,
        width=letter[0],
        height=letter[1],
        preserveAspectRatio=True,
        anchor="c",
        mask="auto",
    )
    pdf.showPage()
    pdf.save()
    return output.getvalue()


def main() -> None:
    digital = generate_digital_resume()
    scanned = generate_scanned_resume()
    corrupt = digital[: max(256, len(digital) // 3)]
    DIGITAL_PATH.write_bytes(digital)
    SCANNED_PATH.write_bytes(scanned)
    CORRUPT_PATH.write_bytes(corrupt)

    files = {
        "digital-resume.pdf": {
            "sha256": hashlib.sha256(digital).hexdigest(),
            "critical_text": DIGITAL_CRITICAL_TEXT,
            "kind": "digital_text_layer",
        },
        "scanned-resume.pdf": {
            "sha256": hashlib.sha256(scanned).hexdigest(),
            "critical_text": SCANNED_CRITICAL_TEXT,
            "kind": "image_only_scanned",
        },
        "corrupt-truncated.pdf": {
            "sha256": hashlib.sha256(corrupt).hexdigest(),
            "critical_text": [],
            "kind": "intentionally_truncated",
        },
    }
    manifest = {
        "schema_version": "1.0",
        "synthetic_only": True,
        "files": files,
    }
    (FIXTURE_DIR / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
