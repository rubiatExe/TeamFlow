from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from teamflow_hiring_agent.evaluation.diagnostic_judge import (
    CachedJudgeInput,
    CachedJudgeOutput,
    DiagnosticJudgeModelOutput,
    DiagnosticJudgeRunManifest,
    FixtureJudgeContractError,
    GeminiDiagnosticJudgeTransport,
    JudgeConfiguration,
    JudgeDimension,
    JudgeDimensionResult,
    JudgeExecutionStatus,
    JudgeFailure,
    JudgeFailureCategory,
    JudgeFailureCode,
    JudgeProducerKind,
    JudgeProviderResponse,
    JudgeReasonCode,
    JudgeVerdict,
    ScriptedFixtureJudge,
    ScriptedJudgeResult,
    TransientDiagnosticJudgePayload,
    build_diagnostic_judge_run_manifest,
    cached_judge_input_fingerprint,
    cached_judge_output_fingerprint,
    cached_judge_output_schema_fingerprint,
    canonical_judge_adapter_sha256,
    canonical_judge_generation_configuration_sha256,
    canonical_judge_prompt_sha256,
    canonical_judge_rubric_sha256,
    canonical_judge_safety_configuration_sha256,
    canonical_judge_tool_policy_sha256,
    diagnostic_judge_model_output_schema_fingerprint,
    judge_configuration_fingerprint,
    judge_run_manifest_fingerprint,
    run_live_diagnostic_judge,
    run_scripted_fixture_judge,
    transient_judge_payload_fingerprint,
    transient_judge_payload_schema_fingerprint,
)
from teamflow_hiring_agent.evaluation.fingerprints import ordered_digest
from teamflow_hiring_agent.evaluation.serialization import (
    artifact_json,
    canonical_json,
    jsonl_bytes,
)

PACKAGE_ROOT = Path(__file__).resolve().parents[1] / "teamflow_hiring_agent"
SHA_A = "a" * 64
SHA_B = "b" * 64
SHA_C = "c" * 64
SHA_D = "d" * 64
SHA_E = "e" * 64
SHA_F = "f" * 64


def configuration(**updates: object) -> JudgeConfiguration:
    payload: dict[str, object] = {
        "schema_version": "1.0",
        "judge_id": "semantic-judge-v1",
        "judge_adapter_version": "1.0.0",
        "judge_adapter_sha256": canonical_judge_adapter_sha256("teamflow-fixture"),
        "provider": "teamflow-fixture",
        "model": "scripted-diagnostic-judge",
        "model_version": "1.0.0",
        "prompt_id": "resume-review-semantic-v1",
        "prompt_version": "1.0.0",
        "prompt_sha256": canonical_judge_prompt_sha256(),
        "rubric_id": "grounding-relevance-consistency-v1",
        "rubric_version": "1.0.0",
        "rubric_sha256": canonical_judge_rubric_sha256(),
        "transient_input_schema_version": "1.0",
        "transient_input_schema_sha256": transient_judge_payload_schema_fingerprint(),
        "model_output_schema_version": "1.0",
        "model_output_schema_sha256": (diagnostic_judge_model_output_schema_fingerprint()),
        "output_schema_version": "1.0",
        "output_schema_sha256": cached_judge_output_schema_fingerprint(),
        "safety_configuration_version": "1.0.0",
        "safety_configuration_sha256": canonical_judge_safety_configuration_sha256(),
        "generation_configuration_version": "1.0.0",
        "generation_configuration_sha256": (canonical_judge_generation_configuration_sha256()),
        "tool_policy_version": "1.0.0",
        "tool_policy_sha256": canonical_judge_tool_policy_sha256(),
        "temperature": 0,
        "top_p": 1.0,
        "top_k": 1,
        "seed": 0,
        "candidate_count": 1,
        "max_output_tokens": 512,
        "timeout_milliseconds": 10_000,
        "retry_attempts": 1,
        "response_mime_type": "application/json",
        "tool_access": "none",
        "database_access": False,
        "diagnostic_only": True,
    }
    payload.update(updates)
    return JudgeConfiguration.model_validate(payload)


def live_configuration(**updates: object) -> JudgeConfiguration:
    return configuration(
        judge_adapter_sha256=canonical_judge_adapter_sha256("google-gemini"),
        provider="google-gemini",
        model="gemini-diagnostic-judge-v1",
        model_version="gemini-diagnostic-judge-v1-001",
        **updates,
    )


def cached_input(
    *,
    case_id: str = "TF-RRV1-VA-901",
    case_fingerprint: str = SHA_A,
    config: JudgeConfiguration | None = None,
    **updates: object,
) -> CachedJudgeInput:
    resolved_configuration = config or configuration()
    payload: dict[str, object] = {
        "schema_version": "1.0",
        "run_id": "fixture-judge-run-001",
        "case_id": case_id,
        "dataset_name": "resume_review_v1",
        "dataset_version": "1.1.0",
        "dataset_fingerprint": SHA_B,
        "split": "validation",
        "purpose": "validation",
        "source_kind": "synthetic",
        "anonymization_approval_fingerprint": None,
        "case_input_fingerprint": case_fingerprint,
        "generator_run_manifest_fingerprint": SHA_C,
        "generator_configuration_fingerprint": SHA_D,
        "agent1_result_fingerprint": SHA_E,
        "question_plan_fingerprint": SHA_F,
        "transient_payload_sha256": "1" * 64,
        "judge_configuration_fingerprint": judge_configuration_fingerprint(resolved_configuration),
        "contains_resume_text": False,
        "contains_prompt_text": False,
        "contains_free_form_rationale": False,
        "contains_candidate_identifiers": False,
        "contains_tenant_identifiers": False,
        "contains_contact_details": False,
        "contains_hiring_scores": False,
    }
    payload.update(updates)
    return CachedJudgeInput.model_validate(payload)


def transient_payload(
    *,
    case_id: str = "TF-RRV1-VA-901",
    **updates: object,
) -> TransientDiagnosticJudgePayload:
    payload: dict[str, object] = {
        "schema_version": "1.0",
        "case_id": case_id,
        "source_kind": "synthetic",
        "anonymization_approval_fingerprint": None,
        "role_policy_fingerprint": SHA_A,
        "approved_criteria": [
            {
                "criterion_id": "customer-service",
                "criterion_text": "Customer service experience",
                "weight": 60,
            },
            {
                "criterion_id": "food-safety",
                "criterion_text": "Food safety certification",
                "weight": 40,
            },
        ],
        "source_blocks": [
            {
                "source_block_id": "source-block-001",
                "text": "Worked at Northstar Cafe for three years.",
            }
        ],
        "criterion_assessments": [
            {
                "criterion_id": "customer-service",
                "status": "met",
                "evidence": [
                    {
                        "criterion_id": "customer-service",
                        "source_block_id": "source-block-001",
                        "exact_quote": "Worked at Northstar Cafe for three years.",
                    }
                ],
            },
            {
                "criterion_id": "food-safety",
                "status": "unknown",
                "evidence": [],
            },
        ],
        "deterministic_score": 60,
        "gaps": [{"criterion_id": "food-safety", "status": "unknown"}],
        "questions": [
            {
                "target_criterion_id": "food-safety",
                "question": "What food-safety training have you completed?",
            }
        ],
    }
    payload.update(updates)
    return TransientDiagnosticJudgePayload.model_validate(payload)


class FakeJudgeTransport:
    def __init__(
        self,
        response: JudgeProviderResponse | None = None,
        *,
        error: Exception | None = None,
    ) -> None:
        self.response = response
        self.error = error
        self.calls = 0
        self.payload_json = ""
        self.producer_kind = JudgeProducerKind.TEST_TRANSPORT
        self.provider = "google-gemini"

    async def generate(
        self,
        *,
        payload_json: str,
        configuration: JudgeConfiguration,
    ) -> JudgeProviderResponse:
        self.calls += 1
        self.payload_json = payload_json
        assert configuration.tool_access == "none"
        if self.error is not None:
            raise self.error
        assert self.response is not None
        return self.response


def dimension_results(
    *verdicts: JudgeVerdict,
) -> tuple[JudgeDimensionResult, ...]:
    resolved = verdicts or (
        JudgeVerdict.PASS,
        JudgeVerdict.PASS,
        JudgeVerdict.PASS,
    )
    reason_codes = {
        (JudgeDimension.GROUNDEDNESS, JudgeVerdict.PASS): (JudgeReasonCode.EVIDENCE_SUPPORTED,),
        (JudgeDimension.GROUNDEDNESS, JudgeVerdict.FAIL): (JudgeReasonCode.EVIDENCE_NOT_SUPPORTED,),
        (JudgeDimension.GROUNDEDNESS, JudgeVerdict.UNCERTAIN): (
            JudgeReasonCode.SOURCE_CONTEXT_INSUFFICIENT,
        ),
        (JudgeDimension.CRITERIA_RELEVANCE, JudgeVerdict.PASS): (
            JudgeReasonCode.CRITERIA_RELEVANT,
        ),
        (JudgeDimension.CRITERIA_RELEVANCE, JudgeVerdict.FAIL): (
            JudgeReasonCode.CRITERION_EVIDENCE_IRRELEVANT,
        ),
        (JudgeDimension.CRITERIA_RELEVANCE, JudgeVerdict.UNCERTAIN): (
            JudgeReasonCode.CRITERIA_CONTEXT_INSUFFICIENT,
        ),
        (JudgeDimension.INTERNAL_CONSISTENCY, JudgeVerdict.PASS): (
            JudgeReasonCode.INTERNALLY_CONSISTENT,
        ),
        (JudgeDimension.INTERNAL_CONSISTENCY, JudgeVerdict.FAIL): (
            JudgeReasonCode.SCORE_EVIDENCE_CONFLICT,
        ),
        (JudgeDimension.INTERNAL_CONSISTENCY, JudgeVerdict.UNCERTAIN): (
            JudgeReasonCode.CONSISTENCY_CONTEXT_INSUFFICIENT,
        ),
    }
    return tuple(
        JudgeDimensionResult(
            dimension=dimension,
            verdict=verdict,
            reason_codes=reason_codes[(dimension, verdict)],
        )
        for dimension, verdict in zip(JudgeDimension, resolved, strict=True)
    )


def provider_response(
    *,
    configuration: JudgeConfiguration,
    output_text: str | None = None,
    finish_reason: str = "STOP",
    observed_model_version: str | None = None,
    candidate_count: int = 1,
    prompt_blocked: bool = False,
    emitted_tool_call: bool = False,
) -> JudgeProviderResponse:
    model_output = DiagnosticJudgeModelOutput(dimensions=dimension_results())
    return JudgeProviderResponse(
        output_text=output_text if output_text is not None else artifact_json(model_output),
        finish_reason=finish_reason,
        observed_model_version=observed_model_version or configuration.model_version,
        candidate_count=candidate_count,
        prompt_blocked=prompt_blocked,
        emitted_tool_call=emitted_tool_call,
    )


def scripted_judge(
    inputs: list[CachedJudgeInput],
    *,
    config: JudgeConfiguration | None = None,
    verdicts: tuple[JudgeVerdict, ...] | None = None,
) -> ScriptedFixtureJudge:
    resolved_configuration = config or configuration()
    scripts = [
        ScriptedJudgeResult(
            case_id=record.case_id,
            judge_input_fingerprint=cached_judge_input_fingerprint(record),
            dimensions=dimension_results(*(verdicts or ())),
        )
        for record in inputs
    ]
    return ScriptedFixtureJudge(
        resolved_configuration,
        scripts,
        allow_fixture_judge=True,
    )


def test_configuration_is_strict_versioned_bounded_and_offline() -> None:
    config = configuration()
    assert config.temperature == 0
    assert config.top_p == 1.0
    assert config.top_k == 1
    assert config.seed == 0
    assert config.candidate_count == 1
    assert config.max_output_tokens == 512
    assert config.timeout_milliseconds == 10_000
    assert config.retry_attempts == 1
    assert config.response_mime_type == "application/json"
    assert config.tool_access == "none"
    assert config.database_access is False
    assert config.diagnostic_only is True

    for field, value in (
        ("temperature", 1),
        ("temperature", False),
        ("top_p", 0.9),
        ("top_k", 2),
        ("seed", 1),
        ("candidate_count", 2),
        ("max_output_tokens", 0),
        ("timeout_milliseconds", 0),
        ("retry_attempts", 2),
        ("response_mime_type", "text/plain"),
        ("tool_access", "search"),
        ("database_access", True),
        ("diagnostic_only", False),
        ("judge_adapter_sha256", SHA_A),
        ("safety_configuration_sha256", SHA_A),
        ("generation_configuration_sha256", SHA_A),
        ("output_schema_sha256", SHA_A),
    ):
        with pytest.raises(ValidationError):
            configuration(**{field: value})

    with pytest.raises(ValidationError):
        JudgeConfiguration.model_validate(
            {**config.model_dump(mode="json"), "unversioned_provider_option": True}
        )
    with pytest.raises(ValueError, match="unsupported diagnostic judge provider"):
        canonical_judge_adapter_sha256("unknown-provider")
    with pytest.raises(ValidationError, match="unsupported diagnostic judge provider"):
        configuration(provider="unknown-provider")


def test_cached_records_exclude_raw_content_identifiers_scores_and_rationale() -> None:
    record = cached_input()
    serialized = artifact_json(record)
    for canary in (
        "candidate@example.com",
        "+1-555-867-5309",
        "private resume sentence",
        "merchant-uuid-canary",
        "candidate-uuid-canary",
        "free form model explanation",
        '"fit_score"',
    ):
        assert canary not in serialized

    base = record.model_dump(mode="json")
    for forbidden_field, forbidden_value in (
        ("resume_text", "private resume sentence"),
        ("prompt_text", "private prompt"),
        ("candidate_id", "candidate-uuid-canary"),
        ("merchant_id", "merchant-uuid-canary"),
        ("fit_score", 99),
        ("rationale", "free form model explanation"),
    ):
        with pytest.raises(ValidationError):
            CachedJudgeInput.model_validate({**base, forbidden_field: forbidden_value})

    with pytest.raises(ValidationError):
        CachedJudgeInput.model_validate({**base, "contains_resume_text": True})
    with pytest.raises(ValidationError, match="may not evaluate"):
        CachedJudgeInput.model_validate({**base, "split": "test"})


def test_output_requires_all_dimensions_in_order_and_derives_overall_verdict() -> None:
    record = cached_input()
    results = dimension_results(
        JudgeVerdict.PASS,
        JudgeVerdict.UNCERTAIN,
        JudgeVerdict.FAIL,
    )
    output = run_scripted_fixture_judge(
        [record],
        scripted_judge([record], verdicts=tuple(item.verdict for item in results)),
    )[0]
    assert output.overall_verdict is JudgeVerdict.FAIL
    assert output.producer_kind is JudgeProducerKind.SCRIPTED_FIXTURE
    assert output.execution_status is JudgeExecutionStatus.COMPLETED
    assert output.diagnostic_only is True
    assert output.threshold_applied is False

    payload = output.model_dump(mode="json")
    with pytest.raises(ValidationError, match="complete and in canonical"):
        CachedJudgeOutput.model_validate(
            {**payload, "dimensions": list(reversed(payload["dimensions"]))}
        )
    with pytest.raises(ValidationError, match="derived"):
        CachedJudgeOutput.model_validate({**payload, "overall_verdict": "pass"})
    with pytest.raises(ValidationError):
        CachedJudgeOutput.model_validate(
            {**payload, "free_form_rationale": "private model chain of thought"}
        )

    bad_reason = results[0].model_dump(mode="json")
    bad_reason["reason_codes"] = ["source_conflict", "evidence_not_supported"]
    with pytest.raises(ValidationError, match="lexical order"):
        JudgeDimensionResult.model_validate(bad_reason)

    with pytest.raises(ValidationError, match="dimension verdict"):
        JudgeDimensionResult(
            dimension=JudgeDimension.GROUNDEDNESS,
            verdict=JudgeVerdict.PASS,
            reason_codes=(JudgeReasonCode.CRITERIA_RELEVANT,),
        )


def test_typed_failures_are_cached_without_semantic_verdicts() -> None:
    record = cached_input()
    payload = {
        "schema_version": "1.0",
        "run_id": record.run_id,
        "case_id": record.case_id,
        "judge_input_fingerprint": cached_judge_input_fingerprint(record),
        "agent1_result_fingerprint": record.agent1_result_fingerprint,
        "question_plan_fingerprint": record.question_plan_fingerprint,
        "judge_configuration_fingerprint": record.judge_configuration_fingerprint,
        "producer_kind": "live_provider",
        "execution_status": "operational_error",
        "failure": {
            "category": "operational",
            "code": "provider_timeout",
            "retryable": True,
        },
        "dimensions": [],
        "overall_verdict": None,
        "diagnostic_only": True,
        "threshold_applied": False,
        "contains_resume_text": False,
        "contains_prompt_text": False,
        "contains_raw_model_output": False,
        "contains_free_form_rationale": False,
        "contains_candidate_identifiers": False,
        "contains_tenant_identifiers": False,
        "contains_contact_details": False,
        "contains_hiring_scores": False,
    }
    failed = CachedJudgeOutput.model_validate(payload)
    assert failed.failure == JudgeFailure(
        category=JudgeFailureCategory.OPERATIONAL,
        code=JudgeFailureCode.PROVIDER_TIMEOUT,
        retryable=True,
    )
    with pytest.raises(ValidationError, match="cannot contain semantic verdicts"):
        CachedJudgeOutput.model_validate(
            {
                **payload,
                "dimensions": [item.model_dump(mode="json") for item in dimension_results()],
                "overall_verdict": "pass",
            }
        )
    with pytest.raises(ValidationError, match="matching typed failure"):
        CachedJudgeOutput.model_validate(
            {
                **payload,
                "execution_status": "contract_failure",
            }
        )
    with pytest.raises(ValidationError, match="failure code does not match"):
        JudgeFailure(
            category=JudgeFailureCategory.OPERATIONAL,
            code=JudgeFailureCode.MALFORMED_OUTPUT,
            retryable=False,
        )


def test_transient_payload_is_one_role_literal_grounded_bounded_and_not_repr_safe() -> None:
    payload = transient_payload()
    assert payload.deterministic_score == 60
    assert transient_judge_payload_fingerprint(payload) == transient_judge_payload_fingerprint(
        payload
    )
    assert "Northstar Cafe" not in repr(payload)
    assert "food-safety training" not in repr(payload)

    dumped = payload.model_dump(mode="json")
    changed_score = {**dumped, "deterministic_score": 100}
    with pytest.raises(ValidationError, match="approved weights"):
        TransientDiagnosticJudgePayload.model_validate(changed_score)

    ungrounded = payload.model_dump(mode="json")
    ungrounded["criterion_assessments"][0]["evidence"][0]["exact_quote"] = (
        "This sentence is absent from source."
    )
    with pytest.raises(ValidationError, match="literal source"):
        TransientDiagnosticJudgePayload.model_validate(ungrounded)

    oversized = payload.model_dump(mode="json")
    oversized["source_blocks"] = [
        {
            "source_block_id": f"source-block-{index:03d}",
            "text": (
                "Worked at Northstar Cafe for three years. " + "x" * 7_900
                if index == 1
                else "x" * 7_950
            ),
        }
        for index in range(1, 10)
    ]
    with pytest.raises(ValidationError, match="exceeds 65536"):
        TransientDiagnosticJudgePayload.model_validate(oversized)


def test_live_runner_is_one_call_app_derived_and_content_free() -> None:
    config = live_configuration()
    payload = transient_payload()
    record = cached_input(
        config=config,
        transient_payload_sha256=transient_judge_payload_fingerprint(payload),
    )
    transport = FakeJudgeTransport(provider_response(configuration=config))
    output = asyncio.run(
        run_live_diagnostic_judge(
            record,
            payload,
            configuration=config,
            transport=transport,
        )
    )

    assert transport.calls == 1
    assert transport.payload_json == artifact_json(payload).rstrip("\n")
    assert output.execution_status is JudgeExecutionStatus.COMPLETED
    assert output.overall_verdict is JudgeVerdict.PASS
    assert output.producer_kind is JudgeProducerKind.TEST_TRANSPORT
    serialized = artifact_json(output)
    assert "Northstar Cafe" not in serialized
    assert "food-safety training" not in serialized

    changed_payload = transient_payload(
        questions=[],
    )
    with pytest.raises(FixtureJudgeContractError, match="fingerprint differs"):
        asyncio.run(
            run_live_diagnostic_judge(
                record,
                changed_payload,
                configuration=config,
                transport=transport,
            )
        )

    transport.producer_kind = JudgeProducerKind.LIVE_PROVIDER
    with pytest.raises(FixtureJudgeContractError, match="concrete Gemini"):
        asyncio.run(
            run_live_diagnostic_judge(
                record,
                payload,
                configuration=config,
                transport=transport,
            )
        )


@pytest.mark.parametrize(
    ("response_updates", "expected_code"),
    [
        ({"output_text": ""}, JudgeFailureCode.EMPTY_OUTPUT),
        ({"output_text": "not-json"}, JudgeFailureCode.MALFORMED_OUTPUT),
        (
            {"output_text": '{"schema_version":"1.0","schema_version":"1.0"}'},
            JudgeFailureCode.MALFORMED_OUTPUT,
        ),
        ({"finish_reason": "MAX_TOKENS"}, JudgeFailureCode.OUTPUT_TOKEN_LIMIT),
        ({"finish_reason": "SAFETY"}, JudgeFailureCode.SAFETY_BLOCK),
        ({"prompt_blocked": True}, JudgeFailureCode.SAFETY_BLOCK),
        ({"emitted_tool_call": True}, JudgeFailureCode.MALFORMED_OUTPUT),
        ({"candidate_count": 2}, JudgeFailureCode.MALFORMED_OUTPUT),
        ({"observed_model_version": "different-version"}, JudgeFailureCode.MALFORMED_OUTPUT),
    ],
)
def test_live_runner_fails_closed_on_incomplete_or_malformed_provider_output(
    response_updates: dict[str, object],
    expected_code: JudgeFailureCode,
) -> None:
    config = live_configuration()
    payload = transient_payload()
    record = cached_input(
        config=config,
        transient_payload_sha256=transient_judge_payload_fingerprint(payload),
    )
    response = provider_response(configuration=config, **response_updates)
    transport = FakeJudgeTransport(response)
    output = asyncio.run(
        run_live_diagnostic_judge(
            record,
            payload,
            configuration=config,
            transport=transport,
        )
    )
    assert transport.calls == 1
    assert output.execution_status is JudgeExecutionStatus.CONTRACT_FAILURE
    assert output.failure is not None
    assert output.failure.code is expected_code
    assert output.dimensions == ()
    assert output.overall_verdict is None


def test_live_runner_classifies_timeout_and_provider_error_without_retry_or_message() -> None:
    config = live_configuration()
    payload = transient_payload()
    record = cached_input(
        config=config,
        transient_payload_sha256=transient_judge_payload_fingerprint(payload),
    )
    for error, expected_code in (
        (TimeoutError("private resume canary"), JudgeFailureCode.PROVIDER_TIMEOUT),
        (RuntimeError("private resume canary"), JudgeFailureCode.PROVIDER_UNAVAILABLE),
    ):
        transport = FakeJudgeTransport(error=error)
        output = asyncio.run(
            run_live_diagnostic_judge(
                record,
                payload,
                configuration=config,
                transport=transport,
            )
        )
        assert transport.calls == 1
        assert output.execution_status is JudgeExecutionStatus.OPERATIONAL_ERROR
        assert output.failure is not None and output.failure.code is expected_code
        assert "private resume canary" not in artifact_json(output)


def test_concrete_gemini_transport_sends_rubric_schema_safety_limits_and_no_tools() -> None:
    config = live_configuration()
    captured: dict[str, object] = {}
    response = SimpleNamespace(
        candidates=[
            SimpleNamespace(
                content=SimpleNamespace(
                    parts=[
                        SimpleNamespace(
                            text=artifact_json(
                                DiagnosticJudgeModelOutput(dimensions=dimension_results())
                            ),
                            function_call=None,
                            tool_call=None,
                            executable_code=None,
                        )
                    ]
                ),
                finish_reason="STOP",
            )
        ],
        prompt_feedback=None,
        model_version=config.model_version,
    )

    class FakeModels:
        async def generate_content(self, **kwargs: object) -> object:
            captured.update(kwargs)
            return response

    transport = GeminiDiagnosticJudgeTransport(api_key="unit-test-key")
    transport._client = SimpleNamespace(aio=SimpleNamespace(models=FakeModels()))
    result = asyncio.run(
        transport.generate(payload_json=canonical_json(transient_payload()), configuration=config)
    )

    request_config = captured["config"]
    assert request_config.temperature == 0
    assert request_config.top_p == 1.0
    assert request_config.top_k == 1
    assert request_config.seed == 0
    assert request_config.candidate_count == 1
    assert request_config.max_output_tokens == 512
    assert request_config.tools == []
    assert request_config.automatic_function_calling.disable is True
    assert request_config.http_options.timeout == 10_000
    assert request_config.http_options.retry_options.attempts == 1
    assert request_config.response_mime_type == "application/json"
    assert request_config.response_json_schema == DiagnosticJudgeModelOutput.model_json_schema()
    assert "criteria_relevance" in request_config.system_instruction
    assert "unsupported or contradicted" in request_config.system_instruction
    assert "unapproved criterion" in request_config.system_instruction
    assert "question/gap conflict" in request_config.system_instruction
    assert "Canonical rubric JSON" in request_config.system_instruction
    assert [
        (setting.category.value, setting.threshold.value)
        for setting in request_config.safety_settings
    ] == [
        ("HARM_CATEGORY_HARASSMENT", "BLOCK_MEDIUM_AND_ABOVE"),
        ("HARM_CATEGORY_HATE_SPEECH", "BLOCK_MEDIUM_AND_ABOVE"),
        ("HARM_CATEGORY_SEXUALLY_EXPLICIT", "BLOCK_MEDIUM_AND_ABOVE"),
        ("HARM_CATEGORY_DANGEROUS_CONTENT", "BLOCK_MEDIUM_AND_ABOVE"),
    ]
    assert result.observed_model_version == config.model_version


def test_scripted_fixture_judge_requires_explicit_identity_and_exact_scripts() -> None:
    record = cached_input()
    script = ScriptedJudgeResult(
        case_id=record.case_id,
        judge_input_fingerprint=cached_judge_input_fingerprint(record),
        dimensions=dimension_results(),
    )
    with pytest.raises(FixtureJudgeContractError, match="explicit local opt-in"):
        ScriptedFixtureJudge(
            configuration(),
            [script],
            allow_fixture_judge=False,
        )
    with pytest.raises(FixtureJudgeContractError, match="provider=teamflow-fixture"):
        ScriptedFixtureJudge(
            live_configuration(),
            [script],
            allow_fixture_judge=True,
        )

    exact_judge = scripted_judge([record])
    changed = record.model_copy(update={"transient_payload_sha256": "2" * 64})
    with pytest.raises(FixtureJudgeContractError, match="exact cached judge input"):
        exact_judge.evaluate(changed)

    extra = cached_input(case_id="TF-RRV1-VA-902", case_fingerprint=SHA_B)
    with pytest.raises(FixtureJudgeContractError, match="exact cached-input population"):
        run_scripted_fixture_judge([record], scripted_judge([record, extra]))


def test_fixture_run_artifacts_are_canonical_bound_and_deterministic() -> None:
    config = configuration()
    first = cached_input(config=config)
    second = cached_input(
        case_id="TF-RRV1-VA-902",
        case_fingerprint=SHA_B,
        config=config,
    )
    judge = scripted_judge(
        [first, second],
        config=config,
        verdicts=(JudgeVerdict.PASS, JudgeVerdict.PASS, JudgeVerdict.UNCERTAIN),
    )
    outputs = run_scripted_fixture_judge([second, first], judge)
    assert [output.case_id for output in outputs] == [first.case_id, second.case_id]
    population_input_fingerprint = ordered_digest(
        record.case_input_fingerprint for record in (first, second)
    )
    arguments = {
        "configuration": config,
        "split_file_sha256": SHA_F,
        "population_case_input_fingerprint_sha256": population_input_fingerprint,
        "generator_provider": "google",
        "generator_model": "gemini-generator-v1",
        "inputs_file": "judge-inputs.jsonl",
        "outputs_file": "judge-outputs.jsonl",
    }
    manifest = build_diagnostic_judge_run_manifest(
        [second, first],
        list(reversed(outputs)),
        **arguments,
    )
    same_manifest = build_diagnostic_judge_run_manifest(
        [first, second],
        outputs,
        **arguments,
    )

    assert manifest == same_manifest
    assert manifest.input_count == manifest.output_count == 2
    assert manifest.full_split_count == 2
    assert manifest.completed_count == 2
    assert manifest.operational_error_count == 0
    assert manifest.contract_failure_count == 0
    assert manifest.same_provider_as_generator is False
    assert manifest.human_comparison_measured is False
    assert manifest.regression_gate_applied is False
    assert manifest.inputs_sha256 == same_manifest.inputs_sha256
    assert manifest.outputs_sha256 == same_manifest.outputs_sha256
    assert jsonl_bytes([second, first]) == jsonl_bytes([first, second])
    assert judge_run_manifest_fingerprint(manifest) == judge_run_manifest_fingerprint(same_manifest)
    assert len(cached_judge_output_fingerprint(outputs[0])) == 64

    changed_output = outputs[0].model_copy(update={"agent1_result_fingerprint": SHA_A})
    with pytest.raises(FixtureJudgeContractError, match="exact cached input"):
        build_diagnostic_judge_run_manifest(
            [first, second],
            [changed_output, outputs[1]],
            **arguments,
        )
    with pytest.raises(FixtureJudgeContractError, match="population input fingerprint"):
        build_diagnostic_judge_run_manifest(
            [first, second],
            outputs,
            **{**arguments, "population_case_input_fingerprint_sha256": SHA_A},
        )
    with pytest.raises(ValidationError, match="model identity must differ"):
        DiagnosticJudgeRunManifest.model_validate(
            {
                **manifest.model_dump(mode="json"),
                "generator_provider": config.provider,
                "generator_model": config.model,
                "same_provider_as_generator": True,
            }
        )


def test_offline_judge_has_no_runtime_provider_graph_tool_or_database_imports() -> None:
    source = (PACKAGE_ROOT / "evaluation" / "diagnostic_judge.py").read_text(encoding="utf-8")
    for forbidden in (
        "google.generativeai",
        "langgraph",
        "fastapi",
        "psycopg",
        "supabase",
        "teamflow_hiring_agent.resume_review",
    ):
        assert forbidden not in source

    for source_path in PACKAGE_ROOT.rglob("*.py"):
        if "evaluation" in source_path.parts:
            continue
        assert "diagnostic_judge" not in source_path.read_text(encoding="utf-8")
