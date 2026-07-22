"""
TeamFlow — Agent 1: OCR Extraction Layer
-----------------------------------------
Accepts a PDF/image resume and returns clean markdown text.
When MOCK_MODE=True (default), returns static mock LaTeX for fast local dev.
When MOCK_MODE=False, calls Gemini Vision to extract text from the document.

This service is intentionally narrow: it ONLY does text extraction.
All semantic evaluation and scoring is handled downstream by Agent 2 (Next.js /api/parser).
"""

import base64
import os

import google.generativeai as genai
from fastapi import FastAPI, File, UploadFile
from opentelemetry import metrics, trace

from telemetry import setup_telemetry

# ── Telemetry ──────────────────────────────────────────────────────────────────
setup_telemetry(service_name="teamflow-ocr-agent")
tracer = trace.get_tracer("teamflow.ocr_agent", "1.0.0")
meter = metrics.get_meter("teamflow.ocr_agent", "1.0.0")

input_token_counter = meter.create_counter(
    name="gen_ai.client.token.usage",
    unit="{token}",
    description="Number of tokens used in Gemini Vision OCR calls",
)

# ── Config ─────────────────────────────────────────────────────────────────────
MOCK_MODE = os.getenv("MOCK_MODE", "True").lower() == "true"
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "")

MODEL_CANDIDATES = ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-pro"]
vision_model = None




if not MOCK_MODE and GOOGLE_API_KEY:

    genai.configure(api_key=GOOGLE_API_KEY)
    for model_name in MODEL_CANDIDATES:
        try:
            m = genai.GenerativeModel(model_name)
            vision_model = m
            print(f"[OCR] Initialized Gemini Vision model: {model_name}")
            break
        except Exception as err:
            print(f"[OCR] Could not initialize model {model_name}: {err}")



# ── FastAPI App ────────────────────────────────────────────────────────────────
app = FastAPI(title="TeamFlow OCR Agent", version="1.0.0")

MOCK_RESUME_MARKDOWN = """
# Alice Barista
123 Coffee Lane, Jersey City, NJ | (555) 012-3456 | alice@example.com

## Experience
- **Barista**, Joe's Coffee (2021–Present)
  Managed espresso bar during morning rush (300+ tickets/day).
  Trained 5 new staff members on La Marzocco machines.

- **Cashier**, The Bagel Shop (2019–2021)
  Handled POS transactions and closing duties.

## Skills
Coffee & Espresso, Latte Art, Pour Over, Square POS, Inventory Management
"""


@app.get("/")
def health_check():
    return {"status": "ok", "service": "teamflow-ocr-agent", "mock_mode": MOCK_MODE}


@app.post("/extract")
async def extract_resume_text(file: UploadFile = File(...)):
    """
    Agent 1 — OCR Extraction Layer.

    Accepts a PDF or image file.
    Returns: {"markdown": "<clean text extracted from resume>"}

    Does NOT score, evaluate, or analyse the candidate.
    Scoring is handled by Agent 2 (Gemini 1.5 Pro via /api/parser).
    """
    with tracer.start_as_current_span("ocr_extraction") as span:
        span.set_attribute("gen_ai.system", "google_gemini")
        span.set_attribute("gen_ai.operation.name", "ocr_extract")
        span.set_attribute("file.name", file.filename or "unknown")
        span.set_attribute("file.content_type", file.content_type or "unknown")

        # ── MOCK MODE: instant return for local dev ────────────────────────────
        if MOCK_MODE or not vision_model:
            span.set_attribute("teamflow.mock_mode", True)
            return {"markdown": MOCK_RESUME_MARKDOWN.strip(), "mock": True}

        # ── REAL MODE: Gemini Vision extraction ────────────────────────────────
        span.set_attribute("teamflow.mock_mode", False)

        file_bytes = await file.read()
        b64_data = base64.b64encode(file_bytes).decode("utf-8")

        mime_type = file.content_type or "application/pdf"
        if file.filename and (file.filename.endswith(".txt") or file.filename.endswith(".md")):
            mime_type = "text/plain"

        ocr_prompt = (
            "You are a document parser. Extract all text from this resume exactly as it appears. "
            "Return clean, readable markdown — preserve section headings, bullet points, and contact info. "
            "Do NOT summarise, evaluate, or add any commentary. Return ONLY the extracted text."
        )

        result = None
        last_err = None
        for m_name in MODEL_CANDIDATES:
            try:
                m = genai.GenerativeModel(m_name)
                if mime_type.startswith("text/"):
                    text_content = file_bytes.decode("utf-8", errors="ignore")
                    parts = [{"text": f"{ocr_prompt}\n\nDocument Content:\n{text_content}"}]
                else:
                    parts = [
                        {"text": ocr_prompt},
                        {"inline_data": {"mime_type": mime_type, "data": b64_data}},
                    ]

                result = m.generate_content(contents=[{"role": "user", "parts": parts}])
                print(f"[OCR] Successfully generated content using model: {m_name}")
                break
            except Exception as err:
                print(f"[OCR] Model {m_name} failed: {err}")
                last_err = err


        if not result:
            print("[OCR] All Gemini models rate-limited or unavailable — using extracted text fallback")
            if mime_type.startswith("text/"):
                extracted_text = file_bytes.decode("utf-8", errors="ignore")
            else:
                extracted_text = MOCK_RESUME_MARKDOWN.strip()
            return {"markdown": extracted_text, "mock": True}



        # ── Record GenAI Semantic Convention metrics ───────────────────────────
        usage = result.usage_metadata
        if usage:
            prompt_tokens = usage.prompt_token_count or 0
            output_tokens = usage.candidates_token_count or 0

            span.set_attribute("gen_ai.usage.input_tokens", prompt_tokens)
            span.set_attribute("gen_ai.usage.output_tokens", output_tokens)

            input_token_counter.add(
                prompt_tokens,
                {
                    "gen_ai.system": "google_gemini",
                    "gen_ai.token.type": "input",
                    "gen_ai.operation.name": "ocr_extract",
                },
            )
            input_token_counter.add(
                output_tokens,
                {
                    "gen_ai.system": "google_gemini",
                    "gen_ai.token.type": "output",
                    "gen_ai.operation.name": "ocr_extract",
                },
            )

        extracted_text = result.text or ""
        span.set_attribute("teamflow.extracted_chars", len(extracted_text))

        return {"markdown": extracted_text, "mock": False}
