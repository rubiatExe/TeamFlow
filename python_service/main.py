"""
TeamFlow — Agent 1: OCR Extraction Layer
-----------------------------------------
Accepts a PDF/image resume and returns clean markdown text + a 768-dim
text embedding (text-embedding-004) for semantic candidate search.

When MOCK_MODE=True (default), returns static mock LaTeX for fast local dev.
When MOCK_MODE=False, calls Gemini Vision to extract text from the document,
then calls text-embedding-004 to generate a vector embedding of the text.

This service is intentionally narrow: it ONLY does text extraction + embedding.
All semantic evaluation and scoring is handled downstream by Agent 2 (Next.js /api/parser).

Pipeline:
  [Agent 1: OCR + Embedding]  →  /extract  →  { markdown, embedding, mock }
  [Agent 2: Scorer]           →  /api/parser →  ParserOutput (score, skills, flags)
"""

import base64
import os

import google.genai as genai
from google.genai.types import EmbedContentConfig
from fastapi import FastAPI, File, UploadFile
from opentelemetry import metrics, trace

from telemetry import setup_telemetry

# ── Telemetry ──────────────────────────────────────────────────────────────────
setup_telemetry(service_name="teamflow-ocr-agent")
tracer = trace.get_tracer("teamflow.ocr_agent", "1.0.0")
meter = metrics.get_meter("teamflow.ocr_agent", "1.0.0")

# GenAI Semantic Convention counters (https://opentelemetry.io/docs/specs/semconv/gen-ai/)
token_counter = meter.create_counter(
    name="gen_ai.client.token.usage",
    unit="{token}",
    description="Number of tokens used in Gemini OCR and embedding calls",
)

ocr_duration = meter.create_histogram(
    name="gen_ai.client.operation.duration",
    unit="s",
    description="Duration of Gemini OCR and embedding operations",
)

# ── Config ─────────────────────────────────────────────────────────────────────
MOCK_MODE = os.getenv("MOCK_MODE", "True").lower() == "true"
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "")

# Model candidates for OCR (vision) — tried in order until one succeeds
OCR_MODEL_CANDIDATES = [
    "gemini-3.1-pro-preview",
]

# Embedding model — text-embedding-004 produces 768-dimensional vectors
EMBEDDING_MODEL = "models/text-embedding-004"

# google-genai client (replaces deprecated google-generativeai)
genai_client: genai.Client | None = None

if not MOCK_MODE and GOOGLE_API_KEY:
    genai_client = genai.Client(api_key=GOOGLE_API_KEY)
    print(f"[OCR] Initialized Gemini client (primary model: {OCR_MODEL_CANDIDATES[0]})")


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

MOCK_EMBEDDING = [0.0] * 768  # 768-dim zero vector for mock mode


def generate_embedding(text: str) -> list[float] | None:
    """
    Generate a 768-dimensional text embedding using Google's text-embedding-004 model.
    Uses RETRIEVAL_DOCUMENT task type — optimised for document indexing.
    Returns None if the API call fails.
    """
    if not genai_client or not text.strip():
        return None
    try:
        result = genai_client.models.embed_content(
            model=EMBEDDING_MODEL,
            contents=text[:8000],  # Truncate to avoid token limits
            config=EmbedContentConfig(task_type="RETRIEVAL_DOCUMENT"),
        )
        embedding = result.embeddings[0].values if result.embeddings else []
        return list(embedding) if len(embedding) == 768 else None
    except Exception as err:
        print(f"[OCR] Embedding generation failed: {err}")
        return None


@app.get("/")
def health_check():
    return {
        "status": "ok",
        "service": "teamflow-ocr-agent",
        "mock_mode": MOCK_MODE,
        "client_ready": genai_client is not None,
        "ocr_model": OCR_MODEL_CANDIDATES[0],
        "embedding_model": EMBEDDING_MODEL,
    }


@app.post("/extract")
async def extract_resume_text(file: UploadFile = File(...)):
    """
    Agent 1 — OCR Extraction Layer.

    Accepts a PDF or image file.
    Returns: {
      "markdown": "<clean text extracted from resume>",
      "embedding": [0.123, ...],  # 768-dim vector (text-embedding-004)
      "mock": false
    }

    Does NOT score, evaluate, or analyse the candidate.
    Scoring is handled by Agent 2 (Gemini via /api/parser).
    Embedding is stored by Agent 2 in the candidates table (pgvector column).
    """
    import time

    with tracer.start_as_current_span("ocr_extraction") as span:
        span.set_attribute("gen_ai.system", "google_gemini")
        span.set_attribute("gen_ai.operation.name", "ocr_extract")
        span.set_attribute("file.name", file.filename or "unknown")
        span.set_attribute("file.content_type", file.content_type or "unknown")

        # ── MOCK MODE: instant return for local dev ────────────────────────────
        if MOCK_MODE or not genai_client:
            span.set_attribute("teamflow.mock_mode", True)
            return {
                "markdown": MOCK_RESUME_MARKDOWN.strip(),
                "embedding": MOCK_EMBEDDING,
                "mock": True,
            }

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
        used_model = None
        t_start = time.perf_counter()

        for m_name in OCR_MODEL_CANDIDATES:
            try:
                if mime_type.startswith("text/"):
                    text_content = file_bytes.decode("utf-8", errors="ignore")
                    contents = f"{ocr_prompt}\n\nDocument Content:\n{text_content}"
                else:
                    contents = [
                        {"text": ocr_prompt},
                        {"inline_data": {"mime_type": mime_type, "data": b64_data}},
                    ]

                result = genai_client.models.generate_content(
                    model=m_name,
                    contents=contents,  # type: ignore[arg-type]
                )
                used_model = m_name
                print(f"[OCR] Successfully extracted text using model: {m_name}")
                break
            except Exception as err:
                print(f"[OCR] Model {m_name} failed: {err}")

        ocr_elapsed = time.perf_counter() - t_start
        ocr_duration.record(ocr_elapsed, {"gen_ai.system": "google_gemini", "gen_ai.operation.name": "ocr_extract"})

        if not result:
            print("[OCR] All Gemini models rate-limited or unavailable — using text fallback")
            extracted_text = file_bytes.decode("utf-8", errors="ignore") if mime_type.startswith("text/") else MOCK_RESUME_MARKDOWN.strip()
            return {"markdown": extracted_text, "embedding": None, "mock": True}

        # ── Record GenAI Semantic Convention metrics ───────────────────────────
        usage = result.usage_metadata
        if usage:
            prompt_tokens = usage.prompt_token_count or 0
            output_tokens = usage.response_token_count or 0  # google-genai uses response_token_count

            span.set_attribute("gen_ai.usage.input_tokens", prompt_tokens)
            span.set_attribute("gen_ai.usage.output_tokens", output_tokens)
            span.set_attribute("gen_ai.model.name", used_model or "unknown")

            token_counter.add(prompt_tokens, {
                "gen_ai.system": "google_gemini",
                "gen_ai.token.type": "input",
                "gen_ai.operation.name": "ocr_extract",
                "gen_ai.model.name": used_model or "unknown",
            })
            token_counter.add(output_tokens, {
                "gen_ai.system": "google_gemini",
                "gen_ai.token.type": "output",
                "gen_ai.operation.name": "ocr_extract",
                "gen_ai.model.name": used_model or "unknown",
            })

        extracted_text = result.text or ""
        span.set_attribute("teamflow.extracted_chars", len(extracted_text))

        # ── Step 1b: Generate text embedding (text-embedding-004, 768-dim) ────
        embedding = None
        with tracer.start_as_current_span("embedding_generation") as embed_span:
            embed_span.set_attribute("gen_ai.system", "google_gemini")
            embed_span.set_attribute("gen_ai.operation.name", "text_embedding")
            embed_span.set_attribute("gen_ai.model.name", EMBEDDING_MODEL)

            t_embed_start = time.perf_counter()
            embedding = generate_embedding(extracted_text)
            embed_elapsed = time.perf_counter() - t_embed_start

            ocr_duration.record(embed_elapsed, {
                "gen_ai.system": "google_gemini",
                "gen_ai.operation.name": "text_embedding",
            })

            if embedding:
                embed_span.set_attribute("teamflow.embedding_dims", len(embedding))
                print(f"[OCR] Generated {len(embedding)}-dim embedding in {embed_elapsed:.2f}s")
            else:
                embed_span.set_attribute("teamflow.embedding_failed", True)
                print("[OCR] Embedding generation skipped or failed")

        return {
            "markdown": extracted_text,
            "embedding": embedding,
            "mock": False,
        }
