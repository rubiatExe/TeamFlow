"""Deterministic validation and redaction at the LLM trust boundary."""

import json
import re
import unicodedata
from typing import Any

MAX_JSON_BYTES = 16_384
MAX_JSON_DEPTH = 6
MAX_JSON_ITEMS = 200
MAX_STRING_LENGTH = 4_000

_EMAIL_RE = re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")
_PHONE_RE = re.compile(r"(?<!\w)(?:\+?1[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}(?!\w)")
_COMPACT_PHONE_RE = re.compile(r"(?<!\d)(?:\+?1)?\d{10}(?!\d)")
_SECRET_RE = re.compile(
    r"(?i)\b(api[ _-]?key|access[ _-]?token|password|secret)\b\s*[:=]\s*[^\s,;]+"
)
_PROTECTED_TRAIT_RE = re.compile(
    r"(?i)\b(age|disability|ethnicity|gender|genetic information|marital status|"
    r"national origin|pregnan(?:cy|t)|race|religion|sexual orientation|"
    r"date of birth|born)\b|\b\d{1,3}\s*(?:years? old|year-old)\b"
)
_MEDICAL_TRAIT_RE = re.compile(
    r"(?i)\b(diagnos(?:is|ed)|disease|health condition|medical condition|medication|"
    r"mental health|medical history)\b"
)
_INSTRUCTIONAL_MANIPULATION_RE = re.compile(
    r"(?is)\b(?:ignore|disregard|override|forget)\b.{0,60}"
    r"\b(?:instructions?|prompts?|polic(?:y|ies)|rules?|criterion|criteria|"
    r"(?:system|developer)\s+(?:messages?|instructions?|prompts?))\b|"
    r"\b(?:system|developer)\s+(?:messages?|instructions?|prompts?)\s*:|"
    r"\b(?:set|assign|change|output|give)\b.{0,40}"
    r"\b(?:fit[ _-]?score|candidate[ _-]?score|hiring[ _-]?score|"
    r"rank|ranking|recommendation)\b|"
    r"\b(?:award|give)\b.{0,30}\b(?:maximum|full|perfect)\b.{0,20}"
    r"\b(?:points?|score)\b|"
    r"\b(?:treat|mark|classify)\b.{0,40}\b(?:all|every)\b.{0,30}"
    r"\b(?:requirement|requirements|criterion|criteria|qualification|qualifications|"
    r"prerequisite|prerequisites|condition|conditions)\b.{0,30}"
    r"\b(?:fulfilled|met|satisfied)\b|"
    r"\b(?:assum(?:e|ed|ing)|presum(?:e|ed|ing)|suppos(?:e|ed|ing)|"
    r"consider(?:ed|ing)?)\b.{0,50}"
    r"\b(?:all|every|each)\b.{0,30}"
    r"\b(?:requirement|requirements|criterion|criteria|qualification|qualifications|"
    r"prerequisite|prerequisites|condition|conditions)\b.{0,30}"
    r"\b(?:fulfilled|met|satisfied|present|pass(?:ed)?)\b|"
    r"\b(?:deem|regard|count)\b.{0,70}"
    r"\b(?:fulfilled|met|satisfied|present|pass(?:ed)?)\b|"
    r"\bact\s+as\s+(?:if|though)\b.{0,70}"
    r"\b(?:fulfilled|met|satisfied|present|pass(?:ed)?)\b|"
    r"\bpretend\b.{0,50}\b(?:applicant|candidate|me)\b.{0,40}"
    r"\b(?:meet|meets|met|satisfies)\b.{0,30}"
    r"\b(?:job\s+description|requirements?|qualifications?|prerequisites?)\b|"
    r"\b(?:evaluation|assessment)\s+note\s*:.{0,30}"
    r"\ball\b.{0,20}\b(?:prerequisites?|requirements?|qualifications?)\b.{0,20}"
    r"\b(?:pass|passed|met|satisfied)\b|"
    r"\bsystem\s*:\s*.{0,50}\b(?:classify|mark|treat)\b.{0,40}"
    r"\b(?:criterion|criteria|requirement|requirements)\b|"
    r"\b(?:hire|reject)\s+(?:me|this\s+candidate|the\s+candidate)\b|"
    r"\b(?:call|invoke)\b.{0,40}\b(?:tool|api|sql)\b|"
    r"\b(?:update|delete|write)\b.{0,40}"
    r"\b(?:candidate(?:'s)?\s+(?:record|score)|fit[ _-]?score)\b"
)
_CONTACT_REQUEST_RE = re.compile(
    r"(?is)\b(?:what(?:'s| is)|provide|share|give|confirm|enter|supply|send)\b.{0,60}"
    r"\b(?:your\s+)?(?:e-?mail(?:\s+address)?|phone(?:\s+number)?|"
    r"telephone(?:\s+number)?|mobile(?:\s+number)?|home\s+address|"
    r"mailing\s+address|street\s+address|contact\s+(?:details|information))\b|"
    r"\b(?:your|candidate(?:'s)?)\s+(?:e-?mail(?:\s+address)?|phone(?:\s+number)?|"
    r"telephone(?:\s+number)?|mobile(?:\s+number)?|home\s+address|"
    r"mailing\s+address|street\s+address|contact\s+(?:details|information))\b|"
    r"\b(?:how|what)\b.{0,30}\b(?:contact|reach)\s+you\b"
)


def _normalized_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", key.lower())


PROTECTED_KEYS = {
    "age",
    "dateofbirth",
    "disability",
    "dob",
    "ethnicity",
    "gender",
    "geneticinformation",
    "maritalstatus",
    "nationalorigin",
    "pregnancy",
    "race",
    "religion",
    "sexualorientation",
}

SENSITIVE_OUTPUT_KEYS = {
    "address",
    "apikey",
    "email",
    "password",
    "phone",
    "resumetext",
    "secret",
    "token",
}


def validate_bounded_json(value: Any) -> Any:
    """Reject oversized, deeply nested, or protected-trait analysis payloads."""
    try:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        raise ValueError("analysis must contain JSON values") from exc
    if len(encoded.encode("utf-8")) > MAX_JSON_BYTES:
        raise ValueError("analysis exceeds the 16 KB limit")

    item_count = 0

    def walk(node: Any, depth: int) -> None:
        nonlocal item_count
        if depth > MAX_JSON_DEPTH:
            raise ValueError("analysis nesting exceeds the allowed depth")
        if isinstance(node, dict):
            item_count += len(node)
            for key, child in node.items():
                if len(key) > 100:
                    raise ValueError("analysis contains an oversized field name")
                if _normalized_key(key) in PROTECTED_KEYS:
                    raise ValueError("analysis cannot use protected characteristics")
                walk(child, depth + 1)
        elif isinstance(node, list):
            item_count += len(node)
            for child in node:
                walk(child, depth + 1)
        elif isinstance(node, str) and len(node) > MAX_STRING_LENGTH:
            raise ValueError("analysis contains an oversized string")
        if item_count > MAX_JSON_ITEMS:
            raise ValueError("analysis contains too many values")

    walk(value, 0)
    return value


def redact_sensitive_text(value: str, *, max_length: int) -> str:
    """Remove contact details and credential-shaped values from model output."""
    redacted = _EMAIL_RE.sub("[REDACTED_EMAIL]", value)
    redacted = _PHONE_RE.sub("[REDACTED_PHONE]", redacted)
    redacted = _COMPACT_PHONE_RE.sub("[REDACTED_PHONE]", redacted)
    redacted = _SECRET_RE.sub(lambda match: f"{match.group(1)}=[REDACTED]", redacted)
    return redacted[:max_length]


def contains_protected_trait_language(value: str) -> bool:
    """Flag model-generated hiring rationale that mentions protected traits."""
    return bool(_PROTECTED_TRAIT_RE.search(value))


def contains_sensitive_text(value: str) -> bool:
    """Detect contact details or credential-shaped text at a model-output boundary."""
    return bool(
        _EMAIL_RE.search(value)
        or _PHONE_RE.search(value)
        or _COMPACT_PHONE_RE.search(value)
        or _SECRET_RE.search(value)
    )


def contains_unsafe_hiring_language(value: str) -> bool:
    """Reject protected and medical characteristics from hiring policy/model output."""
    return bool(_PROTECTED_TRAIT_RE.search(value) or _MEDICAL_TRAIT_RE.search(value))


def contains_instructional_manipulation(value: str) -> bool:
    """Flag text that tries to control decisions, scores, tools, or prompt policy."""

    # NFKC closes full-width compatibility bypasses.  The small confusable map is
    # deliberately scoped to common Latin/Cyrillic prompt-injection substitutions;
    # this remains a lexical defense, not a claim of semantic prompt immunity.
    normalized = (
        unicodedata.normalize("NFKC", value)
        .casefold()
        .translate(
            str.maketrans(
                {
                    "а": "a",
                    "е": "e",
                    "і": "i",
                    "о": "o",
                    "р": "p",
                    "с": "c",
                    "х": "x",
                    "α": "a",
                    "β": "b",
                    "ε": "e",
                    "ι": "i",
                    "κ": "k",
                    "μ": "m",
                    "ν": "n",
                    "ο": "o",
                    "ρ": "p",
                    "τ": "t",
                    "χ": "x",
                }
            )
        )
    )
    normalized = re.sub(r"[\u200b-\u200f\u2060\ufeff]", "", normalized)
    return bool(_INSTRUCTIONAL_MANIPULATION_RE.search(normalized))


def contains_contact_request_language(value: str) -> bool:
    """Reject model questions that solicit candidate contact or address details."""

    return bool(_CONTACT_REQUEST_RE.search(value))


def sanitize_output_json(value: Any, *, depth: int = 0) -> Any:
    """Redact model output recursively and drop prohibited evidence fields."""
    if depth > MAX_JSON_DEPTH:
        return "[TRUNCATED]"
    if isinstance(value, dict):
        clean: dict[str, Any] = {}
        for key, child in list(value.items())[:MAX_JSON_ITEMS]:
            normalized = _normalized_key(str(key))
            if normalized in PROTECTED_KEYS | SENSITIVE_OUTPUT_KEYS:
                continue
            clean[str(key)[:100]] = sanitize_output_json(child, depth=depth + 1)
        return clean
    if isinstance(value, list):
        return [sanitize_output_json(child, depth=depth + 1) for child in value[:MAX_JSON_ITEMS]]
    if isinstance(value, str):
        return redact_sensitive_text(value, max_length=MAX_STRING_LENGTH)
    if isinstance(value, int | float | bool) or value is None:
        return value
    return redact_sensitive_text(str(value), max_length=MAX_STRING_LENGTH)
