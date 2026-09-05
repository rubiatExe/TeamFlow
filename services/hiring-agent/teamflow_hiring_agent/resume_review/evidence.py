"""Deterministic grounding and safety checks between the two model stages."""

from __future__ import annotations

import re
from collections.abc import Iterable

from ..security import (
    contains_contact_request_language,
    contains_instructional_manipulation,
    contains_sensitive_text,
    contains_unsafe_hiring_language,
    normalize_security_text,
)
from .contracts import (
    Agent1Evaluation,
    Agent1ModelOutput,
    Agent2PlanningContext,
    Agent2QuestionPlan,
    CriterionStatus,
    RoleScoringPolicy,
)
from .scoring import ResumeReviewContractError, validate_agent2_question_plan
from .workflow_contracts import StoredDocumentExtraction


class EvidenceValidationError(ResumeReviewContractError):
    """Raised when model claims lack literal membership in the canonical snapshot."""


_NEGATION_TERMS = frozenset(
    {
        "cannot",
        "cant",
        "lack",
        "lacked",
        "lacking",
        "lacks",
        "never",
        "no",
        "not",
        "unable",
        "without",
    }
)
_GENERIC_CRITERION_TERMS = frozenset(
    {
        "ability",
        "and",
        "demonstrated",
        "experience",
        "for",
        "knowledge",
        "of",
        "proficiency",
        "required",
        "skill",
        "skills",
        "the",
        "to",
        "work",
        "working",
        "with",
    }
)
_DECISION_STATUS_RE = re.compile(r"(?i)\b(?:fulfilled|met|satisfied|present|pass(?:ed|es)?)\b")
_DECISION_DIRECTIVE_VERBS = frozenset(
    {
        "accept",
        "acknowledge",
        "classify",
        "consider",
        "count",
        "credit",
        "deem",
        "evaluate",
        "judge",
        "mark",
        "recognize",
        "record",
        "regard",
        "take",
        "treat",
        "view",
    }
)
_DIRECTIVE_PREFIXES = (
    ("please",),
    ("kindly",),
    ("you", "should"),
    ("you", "must"),
)


def _lexical_tokens(value: str) -> tuple[str, ...]:
    normalized = normalize_security_text(value)
    return tuple(re.findall(r"[a-z0-9]+", normalized))


def _lexeme_variants(token: str) -> frozenset[str]:
    variants = {token}
    if len(token) > 4 and token.endswith("s") and not token.endswith("ss"):
        variants.add(token[:-1])
    if len(token) > 5 and token.endswith("ed"):
        variants.update({token[:-1], token[:-2]})
    if len(token) > 6 and token.endswith("ing"):
        variants.update({token[:-3], f"{token[:-3]}e"})
    return frozenset(variants)


def _met_or_not_met_quote_has_criterion_overlap(quote: str, criterion_text: str) -> bool:
    """Require a conservative lexical anchor; this is not semantic entailment."""

    generic_variants = {
        variant for token in _GENERIC_CRITERION_TERMS for variant in _lexeme_variants(token)
    }
    criterion_terms = {
        variant
        for token in _lexical_tokens(criterion_text)
        if len(token) >= 3
        for variant in _lexeme_variants(token)
        if variant not in generic_variants
    }
    if not criterion_terms:
        return False
    quote_terms = {
        variant for token in _lexical_tokens(quote) for variant in _lexeme_variants(token)
    }
    return bool(criterion_terms.intersection(quote_terms))


def _met_quote_obviously_negates_criterion(quote: str, criterion_text: str) -> bool:
    """Catch narrow, explicit negations without claiming semantic entailment."""

    quote_tokens = _lexical_tokens(quote)
    criterion_tokens = {
        token
        for token in _lexical_tokens(criterion_text)
        if len(token) >= 3 and token not in _GENERIC_CRITERION_TERMS
    }
    if not criterion_tokens:
        return False

    criterion_phrase = " ".join(_lexical_tokens(criterion_text))
    for index, token in enumerate(quote_tokens):
        if token not in _NEGATION_TERMS:
            continue
        if token == "not" and index + 1 < len(quote_tokens) and quote_tokens[index + 1] == "only":
            continue
        if token == "no" and "no code" in criterion_phrase:
            continue
        nearby = set(quote_tokens[index + 1 : index + 5])
        if nearby.intersection(criterion_tokens):
            return True
    return False


def _known_status_quote_contains_criterion_directive(
    quote: str,
    criterion_text: str,
) -> bool:
    """Reject criterion-overlapping verdict language before lexical grounding."""

    if not _met_or_not_met_quote_has_criterion_overlap(quote, criterion_text):
        return False

    normalized_quote = normalize_security_text(quote)
    if _DECISION_STATUS_RE.search(normalized_quote):
        return True

    quote_tokens = _lexical_tokens(quote)
    for prefix in _DIRECTIVE_PREFIXES:
        if quote_tokens[: len(prefix)] == prefix:
            quote_tokens = quote_tokens[len(prefix) :]
            break
    if not quote_tokens or quote_tokens[0] not in _DECISION_DIRECTIVE_VERBS:
        return False

    # A leading word such as "credit" can be part of the criterion itself (for
    # example, "credit risk analysis"). Treat it as a directive only when the
    # imperative verb is external to the configured criterion vocabulary.
    criterion_tokens = set(_lexical_tokens(criterion_text))
    return quote_tokens[0] not in criterion_tokens


def validate_agent1_projection_safety(model_output: Agent1ModelOutput) -> None:
    """Re-run public-output safety checks without requiring raw document text."""

    for role_assessment in model_output.role_assessments:
        for assessment in role_assessment.criterion_assessments:
            for evidence in assessment.evidence:
                if contains_sensitive_text(evidence.exact_quote):
                    raise EvidenceValidationError("evidence quote contains private data")
                if contains_unsafe_hiring_language(evidence.exact_quote):
                    raise EvidenceValidationError(
                        "evidence quote uses a protected or medical characteristic"
                    )
                if contains_instructional_manipulation(evidence.exact_quote):
                    raise EvidenceValidationError(
                        "evidence quote contains decision or prompt instructions"
                    )

    # Model-provided limitations are deliberately discarded by the graph. The
    # remaining non-evidence strings are strict catalog identifiers validated
    # against application-owned policy below. Scanning their serialized hashes and
    # UUIDs as prose would create false contact-data matches.


def validate_role_policy_safety(policies: Iterable[RoleScoringPolicy]) -> None:
    """Reject criteria that ask the models to use protected or medical traits."""

    policy_list = tuple(policies)
    if not policy_list:
        raise EvidenceValidationError("at least one active role policy is required")
    for policy in policy_list:
        if contains_sensitive_text(policy.role_title):
            raise EvidenceValidationError("active role policy contains private data")
        if contains_unsafe_hiring_language(policy.role_title):
            raise EvidenceValidationError("active role policy contains prohibited language")
        if contains_instructional_manipulation(policy.role_title):
            raise EvidenceValidationError("active role policy contains decision instructions")
        for criterion in policy.criteria:
            if contains_unsafe_hiring_language(criterion.criterion_id):
                raise EvidenceValidationError("active role policy contains prohibited language")
            if contains_instructional_manipulation(criterion.criterion_id):
                raise EvidenceValidationError("active role policy contains decision instructions")
            if contains_unsafe_hiring_language(criterion.criterion_text):
                raise EvidenceValidationError("active role policy contains prohibited language")
            if contains_sensitive_text(criterion.criterion_text):
                raise EvidenceValidationError("active role policy contains private data")
            if contains_instructional_manipulation(criterion.criterion_text):
                raise EvidenceValidationError("active role policy contains decision instructions")


def validate_agent1_evidence(
    model_output: Agent1ModelOutput,
    policies: Iterable[RoleScoringPolicy],
    document: StoredDocumentExtraction,
) -> None:
    """Validate exact catalog coverage and literal source-block membership."""

    policy_list = tuple(policies)
    policy_by_role = {policy.role_id: policy for policy in policy_list}
    if len(policy_by_role) != len(policy_list):
        raise EvidenceValidationError("active role IDs must be unique")
    actual_roles = {assessment.role_id for assessment in model_output.role_assessments}
    if actual_roles != set(policy_by_role):
        raise EvidenceValidationError("Agent 1 role IDs do not match the active catalog")

    block_by_id = {block.source_block_id: block.text for block in document.source_blocks}
    for role_assessment in model_output.role_assessments:
        policy = policy_by_role[role_assessment.role_id]
        expected_criteria = {criterion.criterion_id for criterion in policy.criteria}
        actual_criteria = {
            assessment.criterion_id for assessment in role_assessment.criterion_assessments
        }
        if actual_criteria != expected_criteria:
            raise EvidenceValidationError("Agent 1 criterion IDs do not match the active policy")

        for assessment in role_assessment.criterion_assessments:
            criterion = next(
                item for item in policy.criteria if item.criterion_id == assessment.criterion_id
            )
            for evidence in assessment.evidence:
                source_text = block_by_id.get(evidence.source_block_id)
                if source_text is None:
                    raise EvidenceValidationError("evidence references an unknown source block")
                if evidence.exact_quote not in source_text:
                    raise EvidenceValidationError(
                        "evidence quote is not a literal substring of its source block"
                    )
                if assessment.status in {
                    CriterionStatus.MET,
                    CriterionStatus.NOT_MET,
                } and _known_status_quote_contains_criterion_directive(
                    evidence.exact_quote,
                    criterion.criterion_text,
                ):
                    raise EvidenceValidationError(
                        "known-status evidence contains a criterion decision directive"
                    )
                if assessment.status in {
                    CriterionStatus.MET,
                    CriterionStatus.NOT_MET,
                } and not _met_or_not_met_quote_has_criterion_overlap(
                    evidence.exact_quote,
                    criterion.criterion_text,
                ):
                    raise EvidenceValidationError(
                        "known-status evidence has no distinctive lexical overlap "
                        "with its criterion"
                    )
                if (
                    assessment.status is CriterionStatus.MET
                    and _met_quote_obviously_negates_criterion(
                        evidence.exact_quote,
                        criterion.criterion_text,
                    )
                ):
                    raise EvidenceValidationError(
                        "met evidence explicitly negates its configured criterion"
                    )
    validate_agent1_projection_safety(model_output)


def validate_question_plan_safety(
    context: Agent2PlanningContext,
    plan: Agent2QuestionPlan,
    *,
    evaluation: Agent1Evaluation,
    policies: Iterable[RoleScoringPolicy],
) -> None:
    """Validate provenance, complete gap coverage, and safe question wording."""

    policy_list = tuple(policies)
    validate_agent2_question_plan(context, plan, evaluation, policy_list)
    expected_targets = {gap.criterion_id for gap in context.gaps}
    actual_targets = {question.target_criterion_id for question in plan.questions}
    if actual_targets != expected_targets:
        raise EvidenceValidationError(
            "Agent 2 questions must cover every validated unknown gap exactly once"
        )

    normalized_questions: list[str] = []
    for question in plan.questions:
        combined = f"{question.question}\n{question.purpose}"
        if contains_unsafe_hiring_language(combined):
            raise EvidenceValidationError(
                "Agent 2 question uses a protected or medical characteristic"
            )
        if contains_sensitive_text(combined):
            raise EvidenceValidationError("Agent 2 question contains private data")
        if contains_contact_request_language(combined):
            raise EvidenceValidationError("Agent 2 question requests private contact data")
        if contains_instructional_manipulation(combined):
            raise EvidenceValidationError("Agent 2 question contains decision instructions")
        normalized_questions.append(re.sub(r"\s+", " ", question.question).strip().casefold())
    if len(normalized_questions) != len(set(normalized_questions)):
        raise EvidenceValidationError("Agent 2 question wording must be unique")
