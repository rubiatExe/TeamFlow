from teamflow_hiring_agent.contracts import HiringAgentOutput, HiringAgentRequest

MERCHANT_ID = "00000000-0000-0000-0000-000000000001"
CANDIDATE_ID = "00000000-0000-0000-0000-000000000002"
ROLE_ID = "00000000-0000-0000-0000-000000000003"
REQUEST_ID = "00000000-0000-0000-0000-000000000004"


def test_hiring_agent_output_contract_accepts_valid_response():
    output = HiringAgentOutput.model_validate(
        {
            "summary": "Candidate reviewed",
            "recommendation": "Invite the candidate for a structured interview.",
            "fit_score": 82,
            "analysis": {"evidence": ["Three years of barista experience"]},
            "request_id": REQUEST_ID,
            "tool_calls": ["get_candidate", "get_job_requirements"],
        }
    )

    assert output.fit_score == 82
    assert output.tool_calls == ["get_candidate", "get_job_requirements"]


def test_hiring_agent_output_contract_rejects_invalid_score():
    try:
        HiringAgentOutput.model_validate(
            {
                "summary": "Candidate reviewed",
                "recommendation": "Continue review.",
                "fit_score": 101,
            }
        )
    except ValueError:
        return

    raise AssertionError("fit_score above 100 must be rejected")


def test_request_accepts_the_existing_camel_case_api_contract():
    request = HiringAgentRequest.model_validate(
        {
            "candidateId": CANDIDATE_ID,
            "roleId": ROLE_ID,
            "merchantId": MERCHANT_ID,
            "redFlags": ["Needs availability confirmation"],
        }
    )

    assert str(request.candidate_id) == CANDIDATE_ID
    assert str(request.role_id) == ROLE_ID
    assert request.red_flags == ["Needs availability confirmation"]


def test_write_requires_candidate_score_and_non_empty_analysis():
    try:
        HiringAgentRequest(
            merchantId=MERCHANT_ID,
            candidateId=CANDIDATE_ID,
            score=80,
        )
    except ValueError:
        pass
    else:
        raise AssertionError("partial writes must be rejected")

    assert HiringAgentRequest(
        merchantId=MERCHANT_ID,
        candidateId=CANDIDATE_ID,
        roleId=ROLE_ID,
        score=80,
        analysis={"evidence": "Relevant experience"},
    ).has_explicit_write


def test_request_rejects_protected_characteristics_in_analysis():
    try:
        HiringAgentRequest(
            merchantId=MERCHANT_ID,
            candidateId=CANDIDATE_ID,
            roleId=ROLE_ID,
            score=80,
            analysis={"race": "must not be hiring evidence"},
        )
    except ValueError:
        return

    raise AssertionError("protected characteristics must be rejected")
