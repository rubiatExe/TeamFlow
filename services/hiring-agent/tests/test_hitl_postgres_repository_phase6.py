"""Opt-in PostgreSQL 16 integration coverage for the Phase 6/8A migrations.

Set ``TEST_POSTGRES_DSN`` to a local superuser database. The test creates and drops a
uniquely named sibling database, bootstraps only the Supabase/base tables referenced by
the migrations, and then executes the repository migration files verbatim.
"""

from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import hmac
import json
import os
import time
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from teamflow_hiring_agent.resume_review.confidence import (
    ConfidenceSignal,
    ConfidenceSignalId,
    assess_confidence,
    build_shadow_record,
    confidence_policy_sha256,
    load_default_confidence_policy,
)
from teamflow_hiring_agent.resume_review.contracts import RoleScoringPolicy
from teamflow_hiring_agent.resume_review.hitl.contracts import StartResumeReviewRunRequest
from teamflow_hiring_agent.resume_review.hitl.repository import PostgresHitlRepository
from teamflow_hiring_agent.resume_review.persistence import role_policy_fingerprint
from teamflow_hiring_agent.resume_review.workflow_contracts import canonical_snapshot_sha256

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
PHASE4_MIGRATION = REPOSITORY_ROOT / "supabase/migrations/20260827090000_resume_review_phase4.sql"
MIGRATION = REPOSITORY_ROOT / "supabase/migrations/20260828051404_durable_hitl_phase6.sql"
PHASE8A_MIGRATION = (
    REPOSITORY_ROOT / "supabase/migrations/20260828192200_phase8a_supabase_boundary_hardening.sql"
)
SECURITY_MIGRATION = (
    REPOSITORY_ROOT
    / "supabase/migrations/20260829001553_hitl_actor_capabilities_and_retention_inventory.sql"
)
CAPABILITY_KEY = b"k" * 32
CAPABILITY_SECRET = base64.urlsafe_b64encode(CAPABILITY_KEY).decode("ascii").rstrip("=")
CAPABILITY_KEY_ID = hashlib.sha256(CAPABILITY_KEY).hexdigest()
AUTH_ISSUER = "https://project.example.test/auth/v1"
HITL_SERVICE_PASSWORD = "test-only-hitl-service-password"

ACTOR = "a1000000-0000-4000-8000-000000000001"
REVIEWER = "a1000000-0000-4000-8000-000000000002"
OUTSIDER = "a1000000-0000-4000-8000-000000000003"
OWNER = "a1000000-0000-4000-8000-000000000004"
MERCHANT = "b1000000-0000-4000-8000-000000000001"
OUTSIDER_MERCHANT = "b1000000-0000-4000-8000-000000000002"
DEMO_MERCHANT = "00000000-0000-0000-0000-000000000001"
ROLE = "c1000000-0000-4000-8000-000000000001"
CANDIDATE = "d1000000-0000-4000-8000-000000000001"
DEMO_CANDIDATE = "00000000-0000-0000-0000-000000000002"
ACL_ANALYSIS_ID = "e9000000-0000-4000-8000-000000000099"
ACL_REQUEST_ID = "f9000000-0000-4000-8000-000000000099"
CONTENT_SHA = "a" * 64
DOCUMENT = f"doc-{CONTENT_SHA}"
SOURCE_BLOCK_ID = "src-aaaaaaaaaaaa-p0001-b0001-cc8c358e3584"
CONFIDENCE_POLICY_SHA = confidence_policy_sha256(load_default_confidence_policy())
_DOCUMENT_SNAPSHOT_WITHOUT_SHA: dict[str, object] = {
    "schema_version": "1.0",
    "merchant_id": MERCHANT,
    "document_id": DOCUMENT,
    "content_sha256": CONTENT_SHA,
    "status": "complete",
    "text": "Verified experience",
    "source_blocks": [
        {
            "source_block_id": SOURCE_BLOCK_ID,
            "page_number": 1,
            "ordinal": 1,
            "text": "Verified experience",
        }
    ],
    "extraction_method": "pdf_text",
    "model_id": "test",
    "embedding_available": True,
    "mock": False,
    "warnings": [],
    "quality": {
        "assessment": "usable",
        "character_count": 19,
        "block_count": 1,
        "page_count": 1,
        "reason_codes": [],
    },
}
SNAPSHOT_SHA = canonical_snapshot_sha256(_DOCUMENT_SNAPSHOT_WITHOUT_SHA)

_BOOTSTRAP_SQL = """
create extension if not exists "uuid-ossp";
create schema auth;
create table auth.users (id uuid primary key);
create table auth.sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade
);
create function auth.uid() returns uuid language sql stable set search_path = '' as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create function auth.jwt() returns jsonb language sql stable set search_path = '' as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), ''),
    '{}'
  )::jsonb
$$;

-- Vanilla PostgreSQL does not bundle pgvector. A scalar domain is sufficient for
-- this migration-focused gate because semantic search execution belongs to the
-- separate pinned-Supabase replay; only the Phase 19 capability signature is a
-- prerequisite here.
create domain vector as text;

create table public.merchants (
  id uuid primary key,
  email text unique not null,
  store_name text not null
);
create table public.jobs (
  id uuid primary key,
  created_at timestamptz not null default now(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  title text not null,
  wage_min numeric,
  wage_max numeric,
  is_active boolean not null default true,
  dealbreakers jsonb not null default '[]'::jsonb,
  nice_to_haves jsonb not null default '[]'::jsonb,
  description text,
  scoring_policy_id text,
  scoring_policy_version text,
  scoring_criteria jsonb
);
create table public.candidates (
  id uuid primary key,
  created_at timestamptz not null default now(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  name text not null,
  email text,
  phone text,
  resume_url text not null,
  resume_text text,
  status text not null default 'new',
  fit_score integer check (fit_score between 0 and 100),
  analysis jsonb,
  red_flags jsonb not null default '[]'::jsonb,
  summary text,
  embedding vector,
  unique (merchant_id, id)
);
create table public.applications (
  id uuid primary key,
  candidate_id uuid references public.candidates(id) on delete set null,
  role_id text not null,
  data jsonb not null,
  submitted_at timestamptz default now()
);
create table public.audit_logs (
  id uuid primary key,
  created_at timestamptz default now(),
  candidate_id uuid references public.candidates(id) on delete cascade,
  merchant_id uuid references public.merchants(id),
  action text not null,
  input_data jsonb,
  output_data jsonb
);

create function public.teamflow_request_jwt_claims()
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog
as $claims_function$
declare
  raw_claims text;
  parsed_claims jsonb;
begin
  raw_claims := current_setting('request.jwt.claims', true);
  if raw_claims is null or raw_claims = '' or octet_length(raw_claims) > 8192 then
    return '{}'::jsonb;
  end if;
  begin
    parsed_claims := raw_claims::jsonb;
  exception
    when invalid_text_representation then return '{}'::jsonb;
  end;
  if jsonb_typeof(parsed_claims) <> 'object' then
    return '{}'::jsonb;
  end if;
  return parsed_claims;
end
$claims_function$;

create function public.teamflow_match_candidates(
  candidate_query vector,
  match_merchant_id uuid,
  match_threshold double precision default 0.5,
  match_count integer default 5
)
returns table (merchant_id uuid, similarity double precision)
language sql
stable
set search_path = pg_catalog
as $function$
  select null::uuid, null::double precision where false
$function$;

create policy teamflow_hiring_reader_jobs_select on public.jobs
for select to teamflow_hiring_reader using (
  is_active is true
  and merchant_id = (
    select case
      when claims ->> 'role' = 'teamflow_hiring_reader'
        and coalesce(claims ->> 'merchant_id', '') ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (claims ->> 'merchant_id')::uuid
      else null
    end
    from (select public.teamflow_request_jwt_claims() as claims) as request_context
  )
);
create policy teamflow_hiring_reader_candidates_select on public.candidates
for select to teamflow_hiring_reader using (
  merchant_id = (
    select case
      when claims ->> 'role' = 'teamflow_hiring_reader'
        and coalesce(claims ->> 'merchant_id', '') ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (claims ->> 'merchant_id')::uuid
      else null
    end
    from (select public.teamflow_request_jwt_claims() as claims) as request_context
  )
);
"""


def _replace_database(dsn: str, database: str) -> str:
    parsed = urlsplit(dsn)
    return urlunsplit((parsed.scheme, parsed.netloc, f"/{database}", parsed.query, ""))


def _hitl_service_dsn(dsn: str) -> str:
    return make_conninfo(
        dsn,
        user="teamflow_hitl_service",
        password=HITL_SERVICE_PASSWORD,
    )


@pytest.fixture(scope="module")
def migrated_database() -> str:
    source_dsn = os.getenv("TEST_POSTGRES_DSN")
    if not source_dsn:
        pytest.skip("TEST_POSTGRES_DSN is not configured")
    parsed = urlsplit(source_dsn)
    if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        pytest.skip("Phase 6 migration integration is restricted to local PostgreSQL")
    database = f"teamflow_phase6_{uuid4().hex}"
    admin_dsn = _replace_database(source_dsn, "postgres")
    test_dsn = _replace_database(source_dsn, database)

    with psycopg.connect(admin_dsn, autocommit=True) as connection:
        is_superuser = connection.execute(
            "select rolsuper from pg_roles where rolname = current_user"
        ).fetchone()
        if is_superuser is None or not is_superuser[0]:
            pytest.skip("Phase 6/8A migration integration requires a local superuser")
        connection.execute(
            """
            do $roles$
            begin
              if not exists (select 1 from pg_roles where rolname = 'postgres') then
                -- GitHub's PostgreSQL service uses a named superuser. Create the
                -- production migration-owner identity so default-ACL assertions are
                -- exercised instead of silently skipping the integration suite.
                create role postgres superuser nologin;
              end if;
              if not exists (select 1 from pg_roles where rolname = 'anon') then
                create role anon nologin;
              end if;
              if not exists (select 1 from pg_roles where rolname = 'authenticated') then
                create role authenticated nologin;
              end if;
              if not exists (select 1 from pg_roles where rolname = 'service_role') then
                create role service_role nologin;
              end if;
              if not exists (select 1 from pg_roles where rolname = 'authenticator') then
                create role authenticator nologin noinherit;
              end if;
              if not exists (
                select 1 from pg_roles where rolname = 'teamflow_hiring_reader'
              ) then
                create role teamflow_hiring_reader nologin noinherit;
              end if;
            end
            $roles$;
            """
        )
        connection.execute(
            "grant teamflow_hiring_reader to authenticator "
            "with admin false, inherit false, set true"
        )
        connection.execute(sql.SQL("create database {}").format(sql.Identifier(database)))

    try:
        with psycopg.connect(test_dsn, autocommit=True) as connection:
            connection.execute("set role postgres")
            try:
                connection.execute(_BOOTSTRAP_SQL, prepare=False)
                connection.execute(
                    PHASE4_MIGRATION.read_text(encoding="utf-8"),
                    prepare=False,
                )
                connection.execute(MIGRATION.read_text(encoding="utf-8"), prepare=False)
                connection.execute(PHASE8A_MIGRATION.read_text(encoding="utf-8"), prepare=False)
                connection.execute(SECURITY_MIGRATION.read_text(encoding="utf-8"), prepare=False)
                connection.execute(
                    """
                    insert into teamflow_private.hitl_capability_keys (
                      key_id, secret, auth_issuer
                    )
                    values (%s, %s, %s)
                    """,
                    (CAPABILITY_KEY_ID, CAPABILITY_KEY, AUTH_ISSUER),
                )
                _seed(connection)
            finally:
                connection.execute("reset role")
            connection.execute(
                sql.SQL("alter role teamflow_hitl_service login password {}").format(
                    sql.Literal(HITL_SERVICE_PASSWORD)
                )
            )
        yield test_dsn
    finally:
        with psycopg.connect(admin_dsn, autocommit=True) as connection:
            connection.execute("alter role teamflow_hitl_service nologin password null")
            connection.execute(
                sql.SQL("drop database {} with (force)").format(sql.Identifier(database))
            )


def _policy_snapshot(count: int = 1) -> list[dict[str, object]]:
    return [
        {
            "schema_version": "1.0",
            "role_id": ROLE,
            "role_title": f"Role {index}",
            "policy_identity": {
                "policy_id": f"policy-{index:03d}",
                "policy_version": "1.0.0",
            },
            "criteria": [
                {
                    "criterion_id": f"criterion-{index:03d}",
                    "criterion_text": "Verified experience",
                    "weight": 100,
                }
            ],
        }
        for index in range(1, count + 1)
    ]


def _evaluation(score: int) -> dict[str, object]:
    if score != 100:
        raise ValueError("the one-criterion integration fixture has a score of 100")
    return {
        "schema_version": "1.0",
        "ranked_roles": [
            {
                "role_id": ROLE,
                "deterministic_score": score,
                "scoring_policy": {
                    "policy_id": "policy-001",
                    "policy_version": "1.0.0",
                },
                "criterion_assessments": [
                    {
                        "criterion_id": "criterion-001",
                        "status": "met",
                        "evidence": [
                            {
                                "criterion_id": "criterion-001",
                                "exact_quote": "Verified experience",
                                "source_block_id": SOURCE_BLOCK_ID,
                            }
                        ],
                    }
                ],
                "gaps": [],
            }
        ],
        "recommended_role_id": ROLE,
        "limitations": [],
    }


def _confidence_assessment() -> dict[str, object]:
    return assess_confidence(
        tuple(ConfidenceSignal.model_validate(item) for item in _confidence_signals()),
        load_default_confidence_policy(),
    ).model_dump(mode="json")


def _confidence_policy() -> dict[str, object]:
    return load_default_confidence_policy().model_dump(mode="json")


def _confidence_signals() -> list[dict[str, object]]:
    return [
        ConfidenceSignal(
            component_id=component.component_id,
            score=(88 if component.component_id is ConfidenceSignalId.CRITERIA_COVERAGE else 100),
            hard_failure=False,
            reason_codes=(
                ("criteria_evidence_missing",)
                if component.component_id is ConfidenceSignalId.CRITERIA_COVERAGE
                else ()
            ),
        ).model_dump(mode="json")
        for component in load_default_confidence_policy().components
    ]


def _confidence_shadow() -> dict[str, object]:
    policy = load_default_confidence_policy()
    signals = tuple(ConfidenceSignal.model_validate(item) for item in _confidence_signals())
    return build_shadow_record(
        assess_confidence(signals, policy),
        policy,
        signals=signals,
        review_required=True,
        status="review_required",
    ).model_dump(mode="json")


def _seed(connection: psycopg.Connection[dict[str, object]]) -> None:
    connection.execute(
        "insert into auth.users(id) values (%s::uuid), (%s::uuid), (%s::uuid), (%s::uuid)",
        (ACTOR, REVIEWER, OUTSIDER, OWNER),
    )
    connection.execute(
        "insert into public.merchants(id,email,store_name) values (%s,'phase6@test','Phase 6')",
        (MERCHANT,),
    )
    connection.execute(
        "insert into public.merchants(id,email,store_name) values (%s,'outsider@test','Outsider')",
        (OUTSIDER_MERCHANT,),
    )
    connection.execute(
        "insert into public.merchants(id,email,store_name) values (%s,'demo@test','Demo')",
        (DEMO_MERCHANT,),
    )
    connection.execute(
        "insert into public.jobs(id,merchant_id,title,is_active) values (%s,%s,'Role',true)",
        (ROLE, MERCHANT),
    )
    connection.execute(
        "insert into public.candidates(id,merchant_id,name,resume_url) values (%s,%s,'C','r.pdf')",
        (CANDIDATE, MERCHANT),
    )
    connection.execute(
        "insert into public.candidates(id,merchant_id,name,resume_url) "
        "values (%s,%s,'Demo Candidate','demo.pdf')",
        (DEMO_CANDIDATE, DEMO_MERCHANT),
    )
    connection.execute(
        """
        insert into public.resume_documents(
          merchant_id,document_id,schema_version,content_sha256,snapshot_sha256,
          status,text,source_blocks,extraction_method,model_id,
          embedding_available,mock,warnings,quality
        ) values (
          %s,%s,'1.0',%s,%s,'complete','Verified experience',
          %s,'pdf_text','test',true,false,'[]'::jsonb,
          '{"assessment":"usable","character_count":19,"block_count":1,"page_count":1,"reason_codes":[]}'::jsonb
        )
        """,
        (
            MERCHANT,
            DOCUMENT,
            "a" * 64,
            SNAPSHOT_SHA,
            Jsonb(
                [
                    {
                        "source_block_id": SOURCE_BLOCK_ID,
                        "page_number": 1,
                        "ordinal": 1,
                        "text": "Verified experience",
                    }
                ]
            ),
        ),
    )
    connection.execute(
        "insert into public.candidate_resume_documents values (%s,%s,%s)",
        (MERCHANT, CANDIDATE, DOCUMENT),
    )
    connection.execute(
        """
        insert into public.resume_review_runs(
          id,schema_version,request_id,merchant_id,document_id,candidate_id,
          input_sha256,extraction_snapshot_sha256,policy_sha256,
          role_policy_snapshot,confidence_assessment,confidence_shadow_record,
          confidence_policy_snapshot,confidence_signal_snapshot,
          confidence_policy_sha256,confidence_threshold_applied,
          status,review_required,agent1_evaluation,
          questions_status,question_plan,reason_codes
        ) values (
          %s,'1.0',%s,%s,%s,%s,
          %s,%s,%s,%s,%s,%s,%s,%s,%s,false,
          'review_required',true,%s,
          'skipped',null,'["criteria_evidence_missing"]'::jsonb
        )
        """,
        (
            ACL_ANALYSIS_ID,
            ACL_REQUEST_ID,
            MERCHANT,
            DOCUMENT,
            CANDIDATE,
            "1" * 64,
            SNAPSHOT_SHA,
            role_policy_fingerprint(
                tuple(RoleScoringPolicy.model_validate(item) for item in _policy_snapshot())
            ),
            Jsonb(_policy_snapshot()),
            Jsonb(_confidence_assessment()),
            Jsonb(_confidence_shadow()),
            Jsonb(_confidence_policy()),
            Jsonb(_confidence_signals()),
            CONFIDENCE_POLICY_SHA,
            Jsonb(_evaluation(100)),
        ),
    )
    connection.execute(
        """
        insert into public.merchant_memberships(merchant_id,user_id,role)
        values (%s,%s,'manager'),(%s,%s,'reviewer'),(%s,%s,'owner')
        """,
        (MERCHANT, ACTOR, MERCHANT, REVIEWER, MERCHANT, OWNER),
    )
    connection.execute(
        """
        insert into public.merchant_memberships(merchant_id,user_id,role)
        values (%s,%s,'reviewer')
        """,
        (OUTSIDER_MERCHANT, OUTSIDER),
    )


async def _prepare(
    dsn: str,
    *,
    request_id: str,
    workflow_id: str,
    analysis_id: str,
    request_sha: str,
    analysis_sha: str,
    score: int,
    policy_count: int = 1,
    candidate_id: str = CANDIDATE,
    confidence_assessment: dict[str, object] | None = None,
    confidence_shadow: dict[str, object] | None = None,
    confidence_policy: dict[str, object] | None = None,
    confidence_signals: list[dict[str, object]] | None = None,
    confidence_policy_sha: str | None = None,
    analysis_status: str = "review_required",
    review_required: bool = True,
    confidence_threshold_applied: bool = False,
) -> dict[str, object]:
    policy_snapshot = _policy_snapshot(policy_count)
    policy_sha = role_policy_fingerprint(
        tuple(RoleScoringPolicy.model_validate(item) for item in policy_snapshot)
    )
    connection = await psycopg.AsyncConnection.connect(dsn, row_factory=dict_row)
    try:
        cursor = await connection.execute(
            """
            select * from teamflow_private.prepare_resume_review_workflow(
              %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,
              %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s
            )
            """,
            (
                ACTOR,
                workflow_id,
                analysis_id,
                request_id,
                request_sha,
                DOCUMENT,
                candidate_id,
                analysis_sha,
                SNAPSHOT_SHA,
                policy_sha,
                Jsonb(policy_snapshot),
                Jsonb(
                    _confidence_assessment()
                    if confidence_assessment is None
                    else confidence_assessment
                ),
                Jsonb(_confidence_shadow() if confidence_shadow is None else confidence_shadow),
                Jsonb(_confidence_policy() if confidence_policy is None else confidence_policy),
                Jsonb(_confidence_signals() if confidence_signals is None else confidence_signals),
                CONFIDENCE_POLICY_SHA if confidence_policy_sha is None else confidence_policy_sha,
                confidence_threshold_applied,
                analysis_status,
                review_required,
                Jsonb(_evaluation(score)),
                "skipped",
                None,
                Jsonb(["analysis_complete"]),
                Jsonb(["analysis_complete", "human_approval_required"]),
            ),
        )
        row = await cursor.fetchone()
        await connection.commit()
        assert row is not None
        return row
    finally:
        await connection.close()


async def _record_approval(
    dsn: str,
    *,
    workflow_id: str,
    review_id: str,
    decision_id: str,
    client_sha: str,
) -> tuple[str, str | None]:
    connection = await psycopg.AsyncConnection.connect(dsn, row_factory=dict_row)
    try:
        try:
            await connection.execute(
                """
                select * from teamflow_private.record_resume_review_decision(
                  %s,%s,%s,%s,1,%s,'approve',null,null
                )
                """,
                (REVIEWER, workflow_id, review_id, decision_id, client_sha),
            )
            await connection.commit()
            return workflow_id, None
        except psycopg.Error as exc:
            await connection.rollback()
            return workflow_id, exc.sqlstate
    finally:
        await connection.close()


async def _record_reject(
    dsn: str,
    *,
    workflow_id: str,
    review_id: str,
    decision_id: str,
    client_sha: str,
) -> tuple[str, str | None]:
    connection = await psycopg.AsyncConnection.connect(dsn, row_factory=dict_row)
    try:
        try:
            await connection.execute(
                """
                select * from teamflow_private.record_resume_review_decision(
                  %s,%s,%s,%s,1,%s,'reject',null,'concurrent_reject'
                )
                """,
                (REVIEWER, workflow_id, review_id, decision_id, client_sha),
            )
            await connection.commit()
            return workflow_id, None
        except psycopg.Error as exc:
            await connection.rollback()
            return workflow_id, exc.sqlstate
    finally:
        await connection.close()


async def _together(*awaitables: object) -> list[object]:
    return list(await asyncio.gather(*awaitables))


async def _exercise_repository_projection(
    dsn: str,
    *,
    request_id: str,
    workflow_id: str,
    request_sha: str,
) -> None:
    async with PostgresHitlRepository(
        dsn,
        capability_secret=CAPABILITY_SECRET,
        auth_issuer=AUTH_ISSUER,
        min_size=1,
        max_size=2,
    ) as repository:
        membership = await repository.resolve_membership(
            user_id=ACTOR,
            allowed_roles=("owner", "manager"),
        )
        prepared = await repository.lookup_request(
            membership=membership,
            request=StartResumeReviewRunRequest(
                schema_version="2.0",
                request_id=request_id,
                document_id=DOCUMENT,
                candidate_id=CANDIDATE,
            ),
            request_sha256=request_sha,
        )
        assert prepared is not None
        assert prepared.workflow_id == workflow_id
        assert prepared.reason_codes == (
            "analysis_complete",
            "human_approval_required",
        )
        inspected = await repository.inspect(user_id=ACTOR, run_id=workflow_id)
        assert inspected.status.value == "completed"
        assert inspected.run_version == 4


async def _exercise_pending_repository_projection(
    dsn: str,
    *,
    newest_workflow_id: str,
    older_workflow_id: str,
) -> None:
    async with PostgresHitlRepository(
        dsn,
        capability_secret=CAPABILITY_SECRET,
        auth_issuer=AUTH_ISSUER,
        min_size=1,
        max_size=2,
    ) as repository:
        first_page, has_more = await repository.list_pending(
            user_id=ACTOR,
            limit=1,
            before_created_at=None,
            before_id=None,
        )
        assert has_more is True
        assert [item.run_id for item in first_page] == [newest_workflow_id]
        assert first_page[0].top_role.role_id == ROLE
        assert first_page[0].top_role.role_title == "Role 1"
        assert first_page[0].top_role.deterministic_score == 100
        assert first_page[0].top_role.recommended_role_id == ROLE

        second_page, has_more = await repository.list_pending(
            user_id=ACTOR,
            limit=1,
            before_created_at=first_page[0].created_at,
            before_id=first_page[0].run_id,
        )
        assert has_more is False
        assert [item.run_id for item in second_page] == [older_workflow_id]

        detail = await repository.inspect_detail(
            user_id=REVIEWER,
            run_id=newest_workflow_id,
        )
        assert detail.run_id == newest_workflow_id
        assert detail.status.value == "pending_review"
        assert detail.proposal.top_role_id == ROLE
        assert detail.proposal.recommended_role_id == ROLE
        assert len(detail.proposal.roles) == 1
        assert detail.proposal.roles[0].deterministic_score == 100
        assert len(detail.proposal.criterion_details) == 1
        criterion = detail.proposal.criterion_details[0]
        assert criterion.criterion_id == "criterion-001"
        assert criterion.status.value == "met"
        assert criterion.evidence_snippets[0].exact_quote == "Verified experience"
        assert criterion.evidence_snippets[0].source_block_id == SOURCE_BLOCK_ID

        public_payload = detail.model_dump(mode="json")
        serialized = str(public_payload)
        for private_field in (
            "merchant_id",
            "request_sha256",
            "analysis_input_sha256",
            "extraction_snapshot_sha256",
            "role_policy_snapshot",
            "document_snapshot",
            "source_blocks",
            "checkpoint",
        ):
            assert private_field not in serialized
        assert detail.proposal.confidence.policy_sha256 == CONFIDENCE_POLICY_SHA
        assert detail.proposal.confidence.is_probability is False
        assert detail.proposal.confidence.threshold_applied is False


def test_phase8a_role_acl_rls_and_default_privilege_boundary(
    migrated_database: str,
) -> None:
    with psycopg.connect(migrated_database, autocommit=True, row_factory=dict_row) as connection:
        privileges = connection.execute(
            """
            select
              has_table_privilege('anon', 'public.candidates', 'SELECT') as anon_candidates,
              has_table_privilege(
                'authenticated', 'public.merchant_memberships', 'SELECT'
              ) as authenticated_membership,
              has_table_privilege(
                'authenticated', 'public.resume_review_workflows', 'SELECT'
              ) as authenticated_workflow,
              has_table_privilege(
                'service_role', 'public.merchant_memberships', 'SELECT'
              ) as legacy_service_membership,
              has_table_privilege(
                'service_role', 'public.resume_review_workflows', 'SELECT'
              ) as legacy_service_workflow,
              has_table_privilege(
                'service_role', 'public.applications', 'INSERT'
              ) as application_insert,
              has_table_privilege(
                'service_role', 'public.applications', 'UPDATE'
              ) as application_update,
              has_table_privilege(
                'service_role', 'public.audit_logs', 'DELETE'
              ) as audit_delete,
              has_schema_privilege(
                'service_role', 'teamflow_private', 'USAGE'
              ) as legacy_service_private_schema,
              has_schema_privilege(
                'teamflow_hitl_service', 'teamflow_private', 'USAGE'
              ) as hitl_private_schema,
              has_function_privilege(
                'service_role',
                'teamflow_private.resolve_active_membership(uuid)',
                'EXECUTE'
              ) as legacy_service_actor_rpc,
              has_function_privilege(
                'teamflow_hitl_service',
                'teamflow_private.resolve_active_membership(uuid)',
                'EXECUTE'
              ) as hitl_actor_rpc,
              has_function_privilege(
                'teamflow_hitl_service',
                'teamflow_private.resume_review_retention_inventory(timestamptz)',
                'EXECUTE'
              ) as hitl_retention_inventory,
              has_column_privilege(
                'teamflow_hiring_reader', 'public.candidates', 'name', 'SELECT'
              ) as reader_candidate_name,
              has_column_privilege(
                'teamflow_hiring_reader', 'public.candidates', 'email', 'SELECT'
              ) as reader_candidate_email,
              has_column_privilege(
                'teamflow_review_writer', 'public.resume_review_runs',
                'input_sha256', 'INSERT'
              ) as writer_run_insert,
              has_column_privilege(
                'teamflow_review_writer', 'public.resume_review_runs',
                'status', 'UPDATE'
              ) as writer_run_update,
              has_column_privilege(
                'teamflow_review_writer', 'public.candidates', 'name', 'SELECT'
              ) as writer_candidate_name,
              has_schema_privilege(
                'teamflow_hiring_reader', 'public', 'USAGE'
              ) as reader_public_usage,
              has_schema_privilege(
                'teamflow_hiring_reader', 'public', 'CREATE'
              ) as reader_public_create
            """
        ).fetchone()
        assert privileges == {
            "anon_candidates": False,
            "authenticated_membership": True,
            "authenticated_workflow": False,
            "legacy_service_membership": False,
            "legacy_service_workflow": False,
            "application_insert": True,
            "application_update": False,
            "audit_delete": False,
            "legacy_service_private_schema": False,
            "hitl_private_schema": True,
            "legacy_service_actor_rpc": False,
            "hitl_actor_rpc": False,
            "hitl_retention_inventory": False,
            "reader_candidate_name": False,
            "reader_candidate_email": False,
            "writer_run_insert": True,
            "writer_run_update": False,
            "writer_candidate_name": False,
            "reader_public_usage": True,
            "reader_public_create": False,
        }

        role_rows = connection.execute(
            """
            select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
                   rolinherit, rolreplication, rolbypassrls
            from pg_roles
            where rolname in (
              'teamflow_hitl_service',
              'teamflow_checkpoint_migrator',
              'teamflow_checkpoint_runtime',
              'teamflow_hiring_reader',
              'teamflow_review_writer'
            )
            order by rolname
            """
        ).fetchall()
        assert len(role_rows) == 5
        for role in role_rows:
            assert role["rolcanlogin"] is (role["rolname"] == "teamflow_hitl_service")
            assert role["rolsuper"] is False
            assert role["rolcreatedb"] is False
            assert role["rolcreaterole"] is False
            assert role["rolinherit"] is False
            assert role["rolreplication"] is False
            assert role["rolbypassrls"] is False

        rls_gap_count = connection.execute(
            """
            select count(*) as gap_count
            from pg_class as relation
            join pg_namespace as namespace on namespace.oid = relation.relnamespace
            where namespace.nspname = 'public'
              and relation.relkind = 'r'
              and relation.relname = any(%s)
              and not relation.relrowsecurity
            """,
            (
                [
                    "merchants",
                    "jobs",
                    "candidates",
                    "applications",
                    "audit_logs",
                    "resume_documents",
                    "candidate_resume_documents",
                    "resume_review_runs",
                    "merchant_memberships",
                    "resume_review_workflows",
                    "resume_reviews",
                    "resume_review_decisions",
                    "candidate_score_revisions",
                    "resume_review_events",
                ],
            ),
        ).fetchone()
        assert rls_gap_count == {"gap_count": 0}

        membership_index = connection.execute(
            """
            select indexrelid::regclass::text as index_name,
                   indisunique,
                   pg_get_expr(indpred, indrelid) as predicate
            from pg_index
            where indexrelid =
              'public.merchant_memberships_one_active_per_user_idx'::regclass
            """
        ).fetchone()
        assert membership_index == {
            "index_name": "merchant_memberships_one_active_per_user_idx",
            "indisunique": True,
            "predicate": "(status = 'active'::text)",
        }

        trigger_count = connection.execute(
            """
            select count(*) as trigger_count
            from pg_trigger
            where not tgisinternal
              and tgname in ('applications_reject_update', 'audit_logs_reject_update')
              and tgenabled = 'O'
            """
        ).fetchone()
        assert trigger_count == {"trigger_count": 2}

        capability_policy_count = connection.execute(
            """
            select count(*) as policy_count
            from pg_policy
            where polname in (
              'teamflow_hiring_reader_jobs_select',
              'teamflow_hiring_reader_candidates_select',
              'teamflow_hiring_reader_documents_select',
              'teamflow_hiring_reader_document_links_select',
              'teamflow_review_writer_runs_select',
              'teamflow_review_writer_runs_insert'
            )
            """
        ).fetchone()
        assert capability_policy_count == {"policy_count": 6}

        unexpected_reader_function_count = connection.execute(
            """
            select count(*) as function_count
            from pg_proc as function_def
            join pg_namespace as namespace on namespace.oid = function_def.pronamespace
            where namespace.nspname = 'public'
              and function_def.proname not in (
                'teamflow_match_candidates', 'teamflow_request_jwt_claims'
              )
              and has_function_privilege(
                'teamflow_hiring_reader', function_def.oid, 'EXECUTE'
              )
            """
        ).fetchone()
        assert unexpected_reader_function_count == {"function_count": 0}

        missing_fk_indexes = connection.execute(
            """
            select relation.relname as table_name, constraint_def.conname
            from pg_constraint as constraint_def
            join pg_class as relation on relation.oid = constraint_def.conrelid
            join pg_namespace as namespace on namespace.oid = relation.relnamespace
            where namespace.nspname = 'public'
              and constraint_def.contype = 'f'
              and not exists (
                select 1
                from pg_index as index_def
                where index_def.indrelid = constraint_def.conrelid
                  and index_def.indisvalid
                  and index_def.indisready
                  and constraint_def.conkey <@ (
                    index_def.indkey::smallint[]
                  )[0:cardinality(constraint_def.conkey) - 1]
              )
            order by relation.relname, constraint_def.conname
            """
        ).fetchall()
        assert missing_fk_indexes == []

        reader_claim_results: list[int] = []
        for claims in (
            "{}",
            '{"role":"teamflow_hiring_reader","merchant_id":"not-a-uuid"}',
            f'{{"role":"teamflow_hiring_reader","merchant_id":"{OUTSIDER_MERCHANT}"}}',
            f'{{"role":"teamflow_hiring_reader","merchant_id":"{MERCHANT}"}}',
            f'{{"role":"teamflow_hiring_reader","merchant_id":"{DEMO_MERCHANT}"}}',
        ):
            connection.execute(
                "select set_config('request.jwt.claims', %s, false)",
                (claims,),
            )
            connection.execute("set role teamflow_hiring_reader")
            try:
                count = connection.execute(
                    "select count(id) as candidate_count from public.candidates"
                ).fetchone()
                reader_claim_results.append(count["candidate_count"])
            finally:
                connection.execute("reset role")
        assert reader_claim_results == [0, 0, 0, 1, 1]

        connection.execute(
            "select set_config('request.jwt.claims', %s, false)",
            (f'{{"role":"teamflow_hiring_reader","merchant_id":"{MERCHANT}"}}',),
        )
        connection.execute("set role teamflow_hiring_reader")
        try:
            with pytest.raises(psycopg.Error) as private_candidate_column:
                connection.execute("select email from public.candidates")
            assert private_candidate_column.value.sqlstate == "42501"
        finally:
            connection.execute("reset role")

        writer_claim_results: list[int] = []
        for claims in (
            "{}",
            '{"role":"teamflow_review_writer","merchant_id":"not-a-uuid"}',
            f'{{"role":"teamflow_review_writer","merchant_id":"{OUTSIDER_MERCHANT}"}}',
            f'{{"role":"teamflow_review_writer","merchant_id":"{MERCHANT}"}}',
        ):
            connection.execute(
                "select set_config('request.jwt.claims', %s, false)",
                (claims,),
            )
            connection.execute("set role teamflow_review_writer")
            try:
                count = connection.execute(
                    "select count(id) as run_count from public.resume_review_runs"
                ).fetchone()
                writer_claim_results.append(count["run_count"])
            finally:
                connection.execute("reset role")
        assert writer_claim_results == [0, 0, 0, 1]

        connection.execute("set role teamflow_hitl_service")
        try:
            with pytest.raises(psycopg.Error) as guessed_actor:
                connection.execute(
                    "select * from teamflow_private.resolve_active_membership(%s)",
                    (ACTOR,),
                )
            assert guessed_actor.value.sqlstate == "42501"
            with pytest.raises(psycopg.Error) as direct_table_access:
                connection.execute("select * from public.resume_review_workflows")
            assert direct_table_access.value.sqlstate == "42501"
        finally:
            connection.execute("reset role")

        connection.execute("set role service_role")
        try:
            with pytest.raises(psycopg.Error) as actor_rpc_access:
                connection.execute(
                    "select * from teamflow_private.resolve_active_membership(%s)",
                    (ACTOR,),
                )
            assert actor_rpc_access.value.sqlstate == "42501"
        finally:
            connection.execute("reset role")

        connection.execute("set role postgres")
        try:
            connection.execute("create table public.phase8a_future_table_canary (id bigint)")
            connection.execute(
                "create function public.phase8a_future_function_canary() "
                "returns bigint language sql as 'select 1::bigint'"
            )
        finally:
            connection.execute("reset role")
        canary_privileges = connection.execute(
            """
            select
              has_table_privilege(
                'anon', 'public.phase8a_future_table_canary', 'SELECT'
              ) as anon_table,
              has_table_privilege(
                'authenticated', 'public.phase8a_future_table_canary', 'SELECT'
              ) as authenticated_table,
              has_table_privilege(
                'service_role', 'public.phase8a_future_table_canary', 'SELECT'
              ) as service_table,
              has_function_privilege(
                'public', 'public.phase8a_future_function_canary()', 'EXECUTE'
              ) as public_function,
              has_function_privilege(
                'anon', 'public.phase8a_future_function_canary()', 'EXECUTE'
              ) as anon_function,
              has_function_privilege(
                'service_role', 'public.phase8a_future_function_canary()', 'EXECUTE'
              ) as service_function,
              has_table_privilege(
                'teamflow_hiring_reader', 'public.phase8a_future_table_canary', 'SELECT'
              ) as reader_table,
              has_table_privilege(
                'teamflow_review_writer', 'public.phase8a_future_table_canary', 'INSERT'
              ) as writer_table,
              has_function_privilege(
                'teamflow_hiring_reader',
                'public.phase8a_future_function_canary()', 'EXECUTE'
              ) as reader_function,
              has_function_privilege(
                'teamflow_review_writer',
                'public.phase8a_future_function_canary()', 'EXECUTE'
              ) as writer_function
            """
        ).fetchone()
        assert canary_privileges == {
            "anon_table": False,
            "authenticated_table": False,
            "service_table": False,
            "public_function": False,
            "anon_function": False,
            "service_function": False,
            "reader_table": False,
            "writer_table": False,
            "reader_function": False,
            "writer_function": False,
        }
        connection.execute("drop function public.phase8a_future_function_canary()")
        connection.execute("drop table public.phase8a_future_table_canary")


def test_actual_migration_atomicity_privacy_and_concurrency(
    migrated_database: str,
) -> None:
    dsn = migrated_database
    with psycopg.connect(dsn, row_factory=dict_row) as connection:
        privileges = connection.execute(
            """
            select
              has_table_privilege('authenticated','public.resume_review_workflows','select')
                as authenticated_workflow_select,
              has_table_privilege('teamflow_hitl_service','public.resume_review_workflows','select')
                as service_workflow_select
            """
        ).fetchone()
        assert privileges == {
            "authenticated_workflow_select": False,
            "service_workflow_select": False,
        }

        # Migrations and future TeamFlow functions are owned by ``postgres`` in
        # Supabase. GitHub's service container uses a differently named session
        # superuser, so exercise the migration owner's default ACL explicitly.
        connection.execute("set role postgres")
        try:
            connection.execute(
                "create function teamflow_private.phase6_future_canary() "
                "returns int language sql as 'select 1'"
            )
        finally:
            connection.execute("reset role")
        canary = connection.execute(
            """
            select
              has_function_privilege('public','teamflow_private.phase6_future_canary()','execute')
                as public_exec,
              has_function_privilege('authenticated','teamflow_private.phase6_future_canary()','execute')
                as authenticated_exec,
              has_function_privilege('teamflow_hitl_service','teamflow_private.phase6_future_canary()','execute')
                as service_exec
            """
        ).fetchone()
        assert canary == {
            "public_exec": False,
            "authenticated_exec": False,
            "service_exec": False,
        }
        connection.execute("drop function teamflow_private.phase6_future_canary()")
        connection.commit()

    request_a = "f1000000-0000-4000-8000-000000000001"
    workflow_a = "11000000-0000-4000-8000-000000000001"
    analysis_a = "e1000000-0000-4000-8000-000000000001"
    exact_results = asyncio.run(
        _together(
            _prepare(
                dsn,
                request_id=request_a,
                workflow_id=workflow_a,
                analysis_id=analysis_a,
                request_sha="1" * 64,
                analysis_sha="2" * 64,
                score=100,
            ),
            _prepare(
                dsn,
                request_id=request_a,
                workflow_id=workflow_a,
                analysis_id=analysis_a,
                request_sha="1" * 64,
                analysis_sha="2" * 64,
                score=100,
            ),
        )
    )
    assert {str(row["workflow_id"]) for row in exact_results} == {workflow_a}
    assert sorted(bool(row["replayed"]) for row in exact_results) == [False, True]

    with psycopg.connect(dsn, row_factory=dict_row) as connection:
        recovered_reasons = connection.execute(
            """
            select reason_codes from teamflow_private.lookup_resume_review_workflow(
              %s,%s,%s,%s,%s
            )
            """,
            (ACTOR, request_a, "1" * 64, DOCUMENT, CANDIDATE),
        ).fetchone()
        assert recovered_reasons == {
            "reason_codes": ["analysis_complete", "human_approval_required"]
        }

        connection.execute(
            "update public.merchant_memberships set status='suspended' where user_id=%s",
            (ACTOR,),
        )
        created = connection.execute(
            """
            select * from teamflow_private.create_resume_review(
              %s,%s,%s,%s,%s
            )
            """,
            (
                workflow_a,
                request_a,
                "1" * 64,
                analysis_a,
                Jsonb(["analysis_complete", "human_approval_required"]),
            ),
        ).fetchone()
        assert created is not None
        review_a = str(created["review_id"])
        connection.commit()
        with pytest.raises(psycopg.Error) as cross_tenant_context:
            connection.execute(
                """
                select * from teamflow_private.load_resume_review_edit_context(
                  %s,%s,%s,1
                )
                """,
                (OUTSIDER, workflow_a, review_a),
            )
        assert cross_tenant_context.value.sqlstate == "PT404"
        connection.rollback()

    decision_a = "12000000-0000-4000-8000-000000000001"
    first = asyncio.run(
        _record_approval(
            dsn,
            workflow_id=workflow_a,
            review_id=review_a,
            decision_id=decision_a,
            client_sha="3" * 64,
        )
    )
    assert first[1] is None

    with psycopg.connect(dsn, row_factory=dict_row) as connection:
        terminal = connection.execute(
            "select status,version from public.resume_review_workflows where id=%s",
            (workflow_a,),
        ).fetchone()
        assert terminal == {"status": "completed", "version": 4}
        assert connection.execute(
            "select score_version from public.candidates where id=%s", (CANDIDATE,)
        ).fetchone() == {"score_version": 1}

        connection.execute(
            "update public.merchant_memberships set status='suspended' where user_id=%s",
            (REVIEWER,),
        )
        recovered = connection.execute(
            """
            select * from teamflow_private.recover_resume_review_decision(
              %s,%s,%s,%s,1,%s
            )
            """,
            (REVIEWER, workflow_a, review_a, decision_a, "3" * 64),
        ).fetchone()
        assert recovered is not None and recovered["requires_resume"] is True
        assert connection.execute(
            "select count(*) as count from public.candidate_score_revisions"
        ).fetchone() == {"count": 1}

        with pytest.raises(psycopg.Error) as conflict:
            connection.execute(
                """
                select * from teamflow_private.recover_resume_review_decision(
                  %s,%s,%s,%s,1,%s
                )
                """,
                (REVIEWER, workflow_a, review_a, decision_a, "4" * 64),
            )
        assert conflict.value.sqlstate == "PT409"
        connection.rollback()

        connection.execute(
            "update public.merchant_memberships set status='active' where user_id in (%s,%s)",
            (ACTOR, REVIEWER),
        )
        connection.commit()

    asyncio.run(
        _exercise_repository_projection(
            _hitl_service_dsn(dsn),
            request_id=request_a,
            workflow_id=workflow_a,
            request_sha="1" * 64,
        )
    )

    requests = (
        (
            "f1000000-0000-4000-8000-000000000002",
            "11000000-0000-4000-8000-000000000002",
            "e1000000-0000-4000-8000-000000000002",
            "5" * 64,
            "6" * 64,
        ),
        (
            "f1000000-0000-4000-8000-000000000003",
            "11000000-0000-4000-8000-000000000003",
            "e1000000-0000-4000-8000-000000000003",
            "7" * 64,
            "8" * 64,
        ),
    )
    for request_id, workflow_id, analysis_id, request_sha, analysis_sha in requests:
        asyncio.run(
            _prepare(
                dsn,
                request_id=request_id,
                workflow_id=workflow_id,
                analysis_id=analysis_id,
                request_sha=request_sha,
                analysis_sha=analysis_sha,
                score=100,
            )
        )

    reviews: dict[str, str] = {}
    with psycopg.connect(dsn, row_factory=dict_row) as connection:
        for request_id, workflow_id, analysis_id, request_sha, _analysis_sha in requests:
            row = connection.execute(
                "select * from teamflow_private.create_resume_review(%s,%s,%s,%s,%s)",
                (
                    workflow_id,
                    request_id,
                    request_sha,
                    analysis_id,
                    Jsonb(["analysis_complete", "human_approval_required"]),
                ),
            ).fetchone()
            assert row is not None
            reviews[workflow_id] = str(row["review_id"])
        connection.commit()

    concurrent = asyncio.run(
        _together(
            _record_approval(
                dsn,
                workflow_id=requests[0][1],
                review_id=reviews[requests[0][1]],
                decision_id="12000000-0000-4000-8000-000000000002",
                client_sha="9" * 64,
            ),
            _record_approval(
                dsn,
                workflow_id=requests[1][1],
                review_id=reviews[requests[1][1]],
                decision_id="12000000-0000-4000-8000-000000000003",
                client_sha="a" * 64,
            ),
        )
    )
    assert sorted(state for _, state in concurrent if state is not None) == ["PT409"]
    assert sum(state is None for _, state in concurrent) == 1
    stale_workflow = next(workflow for workflow, state in concurrent if state == "PT409")

    with psycopg.connect(dsn, row_factory=dict_row) as connection:
        rejected = connection.execute(
            """
            select * from teamflow_private.record_resume_review_decision(
              %s,%s,%s,%s,1,%s,'reject',null,%s
            )
            """,
            (
                REVIEWER,
                stale_workflow,
                reviews[stale_workflow],
                "12000000-0000-4000-8000-000000000004",
                "b" * 64,
                "concurrent_proposal_stale",
            ),
        ).fetchone()
        assert rejected is not None
        assert connection.execute(
            "select status from public.resume_review_workflows where id=%s",
            (stale_workflow,),
        ).fetchone() == {"status": "rejected"}
        assert connection.execute(
            "select score_version from public.candidates where id=%s",
            (CANDIDATE,),
        ).fetchone() == {"score_version": 2}
        connection.commit()

        with pytest.raises(psycopg.Error) as scored_insert:
            connection.execute(
                """
                insert into public.candidates(id,merchant_id,name,resume_url,fit_score)
                values (%s,%s,'Unreviewed','x.pdf',99)
                """,
                (str(uuid4()), MERCHANT),
            )
        assert scored_insert.value.sqlstate == "55000"
        connection.rollback()

        evidence_candidate = "d1000000-0000-4000-8000-000000000099"
        evidence_document = f"doc-{'e' * 64}"
        connection.execute(
            "insert into public.candidates(id,merchant_id,name,resume_url) "
            "values (%s,%s,'Evidence only','e.pdf')",
            (evidence_candidate, OUTSIDER_MERCHANT),
        )
        connection.execute(
            """
            insert into public.resume_documents(
              merchant_id,document_id,schema_version,content_sha256,snapshot_sha256,
              status,text,source_blocks,extraction_method,model_id,
              embedding_available,mock,warnings,quality
                ) values (
                  %s,%s,'1.0',%s,%s,'complete','Evidence only',
                  '[{"source_block_id":"src-eeeeeeeeeeee-p0001-b0001-8d4399180f1c",'
                    '"page_number":1,"ordinal":1,"text":"Evidence only"}]'::jsonb,
                  'pdf_text','test',false,false,'[]'::jsonb,
                  '{"assessment":"usable","character_count":13,"block_count":1,'
                    '"page_count":1,"reason_codes":[]}'::jsonb
                )
            """,
            (OUTSIDER_MERCHANT, evidence_document, "e" * 64, "f" * 64),
        )
        connection.execute(
            "insert into public.candidate_resume_documents values (%s,%s,%s)",
            (OUTSIDER_MERCHANT, evidence_candidate, evidence_document),
        )
        connection.execute(
            """
            insert into public.resume_review_runs(
                  id,schema_version,request_id,merchant_id,document_id,candidate_id,
                  input_sha256,extraction_snapshot_sha256,policy_sha256,
                  role_policy_snapshot,confidence_assessment,confidence_shadow_record,
                  confidence_policy_snapshot,confidence_signal_snapshot,
                  confidence_policy_sha256,confidence_threshold_applied,
                  status,review_required,agent1_evaluation,
                  questions_status,question_plan,reason_codes
                ) values (
                  %s,'1.0',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,false,
                  'review_required',true,%s,'skipped',null,
                  '["criteria_evidence_missing"]'::jsonb
            )
            """,
            (
                "e1000000-0000-4000-8000-000000000099",
                "f1000000-0000-4000-8000-000000000099",
                OUTSIDER_MERCHANT,
                evidence_document,
                evidence_candidate,
                "0" * 64,
                "f" * 64,
                "1" * 64,
                Jsonb(_policy_snapshot()),
                Jsonb(_confidence_assessment()),
                Jsonb(_confidence_shadow()),
                Jsonb(_confidence_policy()),
                Jsonb(_confidence_signals()),
                CONFIDENCE_POLICY_SHA,
                Jsonb(_evaluation(100)),
            ),
        )
        connection.commit()

        with pytest.raises(psycopg.Error) as evidence_retention:
            connection.execute(
                "delete from public.merchants where id=%s",
                (OUTSIDER_MERCHANT,),
            )
        assert evidence_retention.value.sqlstate == "55000"
        connection.rollback()

        with pytest.raises(psycopg.Error) as retained_delete:
            connection.execute("delete from public.merchants where id=%s", (MERCHANT,))
        assert retained_delete.value.sqlstate == "55000"
        connection.rollback()


def test_reviewer_queue_and_detail_are_tenant_scoped_and_bounded(
    migrated_database: str,
) -> None:
    dsn = migrated_database
    pending = (
        (
            "f1000000-0000-4000-8000-000000000021",
            "11000000-0000-4000-8000-000000000021",
            "e1000000-0000-4000-8000-000000000021",
            "1" * 64,
            "2" * 64,
            "2026-08-28 10:00:00+00",
        ),
        (
            "f1000000-0000-4000-8000-000000000022",
            "11000000-0000-4000-8000-000000000022",
            "e1000000-0000-4000-8000-000000000022",
            "3" * 64,
            "4" * 64,
            "2026-08-28 10:01:00+00",
        ),
    )
    for request_id, workflow_id, analysis_id, request_sha, analysis_sha, _ in pending:
        asyncio.run(
            _prepare(
                dsn,
                request_id=request_id,
                workflow_id=workflow_id,
                analysis_id=analysis_id,
                request_sha=request_sha,
                analysis_sha=analysis_sha,
                score=100,
            )
        )

    raw_detail_columns = {
        "schema_version",
        "workflow_id",
        "request_id",
        "document_id",
        "workflow_status",
        "workflow_version",
        "review_id",
        "review_version",
        "reason_codes",
        "candidate_id",
        "created_at",
        "extraction_snapshot_sha256",
        "policy_sha256",
        "role_policy_snapshot",
        "agent1_evaluation",
        "question_plan",
        "analysis_status",
        "analysis_review_required",
        "confidence_assessment",
        "confidence_shadow_record",
        "confidence_policy_snapshot",
        "confidence_signal_snapshot",
        "confidence_policy_sha256",
        "confidence_threshold_applied",
        "document_snapshot",
    }
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as connection:
        for request_id, workflow_id, analysis_id, request_sha, _, created_at in pending:
            created = connection.execute(
                "select * from teamflow_private.create_resume_review(%s,%s,%s,%s,%s)",
                (
                    workflow_id,
                    request_id,
                    request_sha,
                    analysis_id,
                    Jsonb(["analysis_complete", "human_approval_required"]),
                ),
            ).fetchone()
            assert created is not None
            connection.execute(
                "update public.resume_review_workflows set created_at=%s where id=%s",
                (created_at, workflow_id),
            )

        expected_ids = [pending[1][1], pending[0][1]]
        for authorized_actor in (OWNER, ACTOR, REVIEWER):
            rows = connection.execute(
                """
                select * from teamflow_private.list_pending_resume_reviews(
                  %s::uuid, 50, null, null
                )
                """,
                (authorized_actor,),
            ).fetchall()
            assert [str(row["workflow_id"]) for row in rows] == expected_ids
            assert all(row["has_more"] is False for row in rows)
            assert set(rows[0]) == {
                "workflow_id",
                "candidate_id",
                "created_at",
                "workflow_version",
                "review_id",
                "review_version",
                "reason_codes",
                "top_role_id",
                "top_role_title",
                "top_role_score",
                "recommended_role_id",
                "has_more",
            }

        assert (
            connection.execute(
                """
            select * from teamflow_private.list_pending_resume_reviews(
              %s::uuid, 50, null, null
            )
            """,
                (OUTSIDER,),
            ).fetchall()
            == []
        )

        for invalid_limit in (None, 51):
            with pytest.raises(psycopg.Error) as invalid_page:
                connection.execute(
                    """
                    select * from teamflow_private.list_pending_resume_reviews(
                      %s::uuid, %s::integer, null, null
                    )
                    """,
                    (ACTOR, invalid_limit),
                ).fetchall()
            assert invalid_page.value.sqlstate == "22023"

        detail = connection.execute(
            "select * from teamflow_private.inspect_resume_review_detail(%s,%s)",
            (OWNER, pending[1][1]),
        ).fetchone()
        assert detail is not None
        assert set(detail) == raw_detail_columns
        assert detail["extraction_snapshot_sha256"] == SNAPSHOT_SHA
        assert detail["document_snapshot"] == {
            **_DOCUMENT_SNAPSHOT_WITHOUT_SHA,
            "snapshot_sha256": SNAPSHOT_SHA,
        }
        assert detail["policy_sha256"] == role_policy_fingerprint(
            (RoleScoringPolicy.model_validate(_policy_snapshot()[0]),)
        )
        assert detail["role_policy_snapshot"] == _policy_snapshot()
        assert detail["agent1_evaluation"] == _evaluation(100)
        assert detail["question_plan"] is None
        assert detail["analysis_status"] == "review_required"
        assert detail["analysis_review_required"] is True
        assert detail["confidence_assessment"] == _confidence_assessment()
        assert detail["confidence_shadow_record"] == _confidence_shadow()
        assert detail["confidence_policy_snapshot"] == _confidence_policy()
        assert detail["confidence_signal_snapshot"] == _confidence_signals()
        assert detail["confidence_policy_sha256"] == CONFIDENCE_POLICY_SHA
        assert detail["confidence_threshold_applied"] is False

        with pytest.raises(psycopg.Error) as cross_tenant_detail:
            connection.execute(
                "select * from teamflow_private.inspect_resume_review_detail(%s,%s)",
                (OUTSIDER, pending[1][1]),
            ).fetchone()
        assert cross_tenant_detail.value.sqlstate == "PT404"

        function_privileges = connection.execute(
            """
            select
              has_function_privilege(
                'teamflow_hitl_service',
                'teamflow_private.list_pending_resume_reviews(uuid,integer,timestamptz,uuid)',
                'execute'
              ) as list_hitl,
              has_function_privilege(
                'authenticated',
                'teamflow_private.list_pending_resume_reviews(uuid,integer,timestamptz,uuid)',
                'execute'
              ) as list_authenticated,
              has_function_privilege(
                'public',
                'teamflow_private.list_pending_resume_reviews(uuid,integer,timestamptz,uuid)',
                'execute'
              ) as list_public,
              has_function_privilege(
                'teamflow_hitl_service',
                'teamflow_private.inspect_resume_review_detail(uuid,uuid)',
                'execute'
              ) as detail_hitl,
              has_function_privilege(
                'authenticated',
                'teamflow_private.inspect_resume_review_detail(uuid,uuid)',
                'execute'
              ) as detail_authenticated,
              has_function_privilege(
                'public',
                'teamflow_private.inspect_resume_review_detail(uuid,uuid)',
                'execute'
              ) as detail_public
            """
        ).fetchone()
        assert function_privileges == {
            "list_hitl": False,
            "list_authenticated": False,
            "list_public": False,
            "detail_hitl": False,
            "detail_authenticated": False,
            "detail_public": False,
        }

        connection.execute("set role teamflow_checkpoint_migrator")
        try:
            connection.execute(
                "create function teamflow_checkpoints.phase6_future_checkpoint_canary() "
                "returns text language sql security definer as "
                "'select current_user::text'"
            )
        finally:
            connection.execute("reset role")
        checkpoint_canary = connection.execute(
            """
            select
              has_function_privilege(
                'public',
                'teamflow_checkpoints.phase6_future_checkpoint_canary()',
                'execute'
              ) as public_exec,
              has_function_privilege(
                'teamflow_checkpoint_runtime',
                'teamflow_checkpoints.phase6_future_checkpoint_canary()',
                'execute'
              ) as runtime_exec,
              has_function_privilege(
                'teamflow_hitl_service',
                'teamflow_checkpoints.phase6_future_checkpoint_canary()',
                'execute'
              ) as hitl_exec
            """
        ).fetchone()
        assert checkpoint_canary == {
            "public_exec": False,
            "runtime_exec": False,
            "hitl_exec": False,
        }
        connection.execute("drop function teamflow_checkpoints.phase6_future_checkpoint_canary()")

    asyncio.run(
        _exercise_pending_repository_projection(
            _hitl_service_dsn(dsn),
            newest_workflow_id=pending[1][1],
            older_workflow_id=pending[0][1],
        )
    )


def test_repeated_concurrent_exact_prepare_never_races_on_stable_primary_keys(
    migrated_database: str,
) -> None:
    async def exercise() -> None:
        for index in range(1, 25):
            request_id = f"f2000000-0000-4000-8000-{index:012x}"
            workflow_id = f"12000000-0000-4000-8000-{index:012x}"
            analysis_id = f"e2000000-0000-4000-8000-{index:012x}"
            results = await _together(
                _prepare(
                    migrated_database,
                    request_id=request_id,
                    workflow_id=workflow_id,
                    analysis_id=analysis_id,
                    request_sha="5" * 64,
                    analysis_sha="6" * 64,
                    score=100,
                ),
                _prepare(
                    migrated_database,
                    request_id=request_id,
                    workflow_id=workflow_id,
                    analysis_id=analysis_id,
                    request_sha="5" * 64,
                    analysis_sha="6" * 64,
                    score=100,
                ),
            )
            assert {str(row["workflow_id"]) for row in results} == {workflow_id}
            assert sorted(bool(row["replayed"]) for row in results) == [False, True]

    asyncio.run(exercise())


def test_confidence_provenance_is_recomputed_and_exactly_replayed(
    migrated_database: str,
) -> None:
    assessment = _confidence_assessment()
    shadow = _confidence_shadow()
    policy = _confidence_policy()
    signals = _confidence_signals()

    def valid(
        *,
        candidate_assessment: object = assessment,
        candidate_shadow: object = shadow,
        candidate_policy: object = policy,
        candidate_signals: object = signals,
        policy_sha: str = CONFIDENCE_POLICY_SHA,
        threshold_applied: bool = False,
        status: str = "review_required",
        review_required: bool = True,
    ) -> bool:
        with psycopg.connect(migrated_database) as connection:
            row = connection.execute(
                """
                select teamflow_private.valid_confidence_provenance(
                  %s::jsonb,%s::jsonb,%s::jsonb,%s::jsonb,
                  %s::text,%s::boolean,%s::text,%s::boolean
                )
                """,
                (
                    Jsonb(candidate_assessment),
                    Jsonb(candidate_shadow),
                    Jsonb(candidate_policy),
                    Jsonb(candidate_signals),
                    policy_sha,
                    threshold_applied,
                    status,
                    review_required,
                ),
            ).fetchone()
            assert row is not None
            return bool(row[0])

    assert CONFIDENCE_POLICY_SHA == (
        "c83ba0b8261bd5d863feb154f9c816099efe49f7b222e50fe72a45689f611e53"
    )
    assert valid()

    invalid_cases: list[dict[str, object]] = []
    for field, value in (
        ("is_probability", True),
        ("score", "88"),
        ("hard_failure", True),
    ):
        changed = copy.deepcopy(assessment)
        changed[field] = value
        invalid_cases.append({"candidate_assessment": changed})

    changed = copy.deepcopy(assessment)
    changed["components"][1]["component_id"] = changed["components"][0]["component_id"]
    invalid_cases.append({"candidate_assessment": changed})
    changed = copy.deepcopy(assessment)
    changed["components"][5]["score"] = 87
    invalid_cases.append({"candidate_assessment": changed})
    changed = copy.deepcopy(assessment)
    changed["unexpected"] = "field"
    invalid_cases.append({"candidate_assessment": changed})

    for field, value in (
        ("is_probability", True),
        ("mode", "calibrated"),
        ("threshold_applied", True),
        ("status", "degraded"),
    ):
        changed = copy.deepcopy(shadow)
        changed[field] = value
        invalid_cases.append({"candidate_shadow": changed})

    changed = copy.deepcopy(policy)
    changed["components"][0]["component_id"] = "bogus_component"
    invalid_cases.append({"candidate_policy": changed})
    changed = copy.deepcopy(policy)
    changed["components"][0]["weight"] = "0"
    invalid_cases.append({"candidate_policy": changed})
    changed = copy.deepcopy(signals)
    changed[0]["component_id"] = "bogus_component"
    invalid_cases.append({"candidate_signals": changed})
    changed = copy.deepcopy(signals)
    changed[5]["reason_codes"] = ["duplicate_reason", "duplicate_reason"]
    invalid_cases.append({"candidate_signals": changed})
    invalid_cases.extend(
        (
            {"policy_sha": "0" * 64},
            {"threshold_applied": True},
            {"status": "degraded"},
            {"review_required": False},
        )
    )
    for invalid in invalid_cases:
        assert not valid(**invalid)

    invalid_assessment = copy.deepcopy(assessment)
    invalid_assessment["components"][0]["component_id"] = "bogus_component"
    with pytest.raises(psycopg.Error) as invalid_prepare:
        asyncio.run(
            _prepare(
                migrated_database,
                request_id="f3000000-0000-4000-8000-000000000001",
                workflow_id="13000000-0000-4000-8000-000000000001",
                analysis_id="e3000000-0000-4000-8000-000000000001",
                request_sha="1" * 64,
                analysis_sha="2" * 64,
                score=100,
                confidence_assessment=invalid_assessment,
            )
        )
    assert invalid_prepare.value.sqlstate == "22023"

    replay_request = "f3000000-0000-4000-8000-000000000002"
    replay_workflow = "13000000-0000-4000-8000-000000000002"
    replay_analysis = "e3000000-0000-4000-8000-000000000002"
    asyncio.run(
        _prepare(
            migrated_database,
            request_id=replay_request,
            workflow_id=replay_workflow,
            analysis_id=replay_analysis,
            request_sha="3" * 64,
            analysis_sha="4" * 64,
            score=100,
        )
    )
    with pytest.raises(psycopg.Error) as changed_replay:
        asyncio.run(
            _prepare(
                migrated_database,
                request_id=replay_request,
                workflow_id=replay_workflow,
                analysis_id=replay_analysis,
                request_sha="3" * 64,
                analysis_sha="4" * 64,
                score=100,
                confidence_signals=list(reversed(signals)),
            )
        )
    assert changed_replay.value.sqlstate == "PT409"

    degraded_shadow = copy.deepcopy(shadow)
    degraded_shadow["status"] = "degraded"
    degraded_shadow["review_required"] = False
    degraded_request = "f3000000-0000-4000-8000-000000000003"
    degraded_workflow = "13000000-0000-4000-8000-000000000003"
    degraded_analysis = "e3000000-0000-4000-8000-000000000003"
    with pytest.raises(psycopg.errors.CheckViolation) as auto_complete_rejected:
        asyncio.run(
            _prepare(
                migrated_database,
                request_id=degraded_request,
                workflow_id=degraded_workflow,
                analysis_id=degraded_analysis,
                request_sha="5" * 64,
                analysis_sha="6" * 64,
                score=100,
                confidence_shadow=degraded_shadow,
                analysis_status="degraded",
                review_required=False,
            )
        )
    assert auto_complete_rejected.value.sqlstate == "23514"
    with psycopg.connect(migrated_database, row_factory=dict_row) as connection:
        persisted = connection.execute(
            "select count(*) as run_count from public.resume_review_runs where id=%s",
            (degraded_analysis,),
        ).fetchone()
    assert persisted == {"run_count": 0}


def test_concurrent_cross_workflow_decision_id_collision_is_typed(
    migrated_database: str,
) -> None:
    second_candidate = "d4000000-0000-4000-8000-000000000002"
    with psycopg.connect(migrated_database) as connection:
        connection.execute(
            """
            insert into public.candidates(id,merchant_id,name,resume_url)
            values (%s,%s,'Decision collision','collision.pdf')
            """,
            (second_candidate, MERCHANT),
        )
        connection.execute(
            "insert into public.candidate_resume_documents values (%s,%s,%s)",
            (MERCHANT, second_candidate, DOCUMENT),
        )
        connection.commit()

    cases = (
        (
            "f4000000-0000-4000-8000-000000000001",
            "14000000-0000-4000-8000-000000000001",
            "e4000000-0000-4000-8000-000000000001",
            CANDIDATE,
            "7" * 64,
        ),
        (
            "f4000000-0000-4000-8000-000000000002",
            "14000000-0000-4000-8000-000000000002",
            "e4000000-0000-4000-8000-000000000002",
            second_candidate,
            "8" * 64,
        ),
    )
    reviews: dict[str, str] = {}
    for request_id, workflow_id, analysis_id, candidate_id, request_sha in cases:
        asyncio.run(
            _prepare(
                migrated_database,
                request_id=request_id,
                workflow_id=workflow_id,
                analysis_id=analysis_id,
                request_sha=request_sha,
                analysis_sha="9" * 64,
                score=100,
                candidate_id=candidate_id,
            )
        )
        with psycopg.connect(migrated_database, row_factory=dict_row) as connection:
            created = connection.execute(
                "select * from teamflow_private.create_resume_review(%s,%s,%s,%s,%s)",
                (
                    workflow_id,
                    request_id,
                    request_sha,
                    analysis_id,
                    Jsonb(["analysis_complete", "human_approval_required"]),
                ),
            ).fetchone()
            assert created is not None
            reviews[workflow_id] = str(created["review_id"])
            connection.commit()

    shared_decision_id = "15000000-0000-4000-8000-000000000001"
    results = asyncio.run(
        _together(
            *(
                _record_reject(
                    migrated_database,
                    workflow_id=workflow_id,
                    review_id=reviews[workflow_id],
                    decision_id=shared_decision_id,
                    client_sha=("a" if index == 0 else "b") * 64,
                )
                for index, (_, workflow_id, _, _, _) in enumerate(cases)
            )
        )
    )
    assert sum(sqlstate is None for _, sqlstate in results) == 1
    assert [sqlstate for _, sqlstate in results if sqlstate is not None] == ["PT409"]
    with psycopg.connect(migrated_database, row_factory=dict_row) as connection:
        assert connection.execute(
            "select count(*) as count from public.resume_review_decisions where id=%s",
            (shared_decision_id,),
        ).fetchone() == {"count": 1}
        states = connection.execute(
            """
            select status, count(*) as count
            from public.resume_review_workflows where id = any(%s::uuid[])
            group by status order by status
            """,
            ([case[1] for case in cases],),
        ).fetchall()
        assert states == [
            {"status": "pending_review", "count": 1},
            {"status": "rejected", "count": 1},
        ]


def test_role_policy_limit_is_enforced_by_actual_prepare_rpc(
    migrated_database: str,
) -> None:
    with pytest.raises(psycopg.Error) as captured:
        asyncio.run(
            _prepare(
                migrated_database,
                request_id="f1000000-0000-4000-8000-000000000009",
                workflow_id="11000000-0000-4000-8000-000000000009",
                analysis_id="e1000000-0000-4000-8000-000000000009",
                request_sha="c" * 64,
                analysis_sha="d" * 64,
                score=100,
                policy_count=6,
            )
        )
    assert captured.value.sqlstate == "22023"


def _actor_capability(
    *,
    actor_id: str,
    operation: str,
    payload: dict[str, object],
    auth_issuer: str = AUTH_ISSUER,
    session_id: str | None = None,
    assurance_level: str | None = None,
    authenticated_at: int | None = None,
    expires_at: int | None = None,
    nonce: str | None = None,
) -> tuple[object, ...]:
    payload_text = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    resource_sha256 = hashlib.sha256(payload_text.encode("utf-8")).hexdigest()
    expiry = int(time.time()) + 15 if expires_at is None else expires_at
    capability_nonce = str(uuid4()) if nonce is None else nonce
    message = "\n".join(
        (
            "teamflow-hitl-capability-v2",
            CAPABILITY_KEY_ID,
            auth_issuer,
            actor_id,
            session_id or "-",
            assurance_level or "-",
            str(authenticated_at) if authenticated_at is not None else "-",
            operation,
            resource_sha256,
            str(expiry),
            capability_nonce,
        )
    )
    return (
        actor_id,
        auth_issuer,
        session_id,
        assurance_level,
        authenticated_at,
        operation,
        resource_sha256,
        expiry,
        capability_nonce,
        CAPABILITY_KEY_ID,
        hmac.new(CAPABILITY_KEY, message.encode("utf-8"), hashlib.sha256).hexdigest(),
    )


def _execute_actor_operation(
    connection: psycopg.Connection[dict[str, object]],
    capability: tuple[object, ...],
    payload: dict[str, object],
) -> list[dict[str, object]]:
    payload_text = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return connection.execute(
        """
        select capability.result
        from teamflow_private.execute_hitl_actor_operation(
          %s::uuid, %s::text, %s::uuid, %s::text, %s::bigint, %s::text,
          %s::text, %s::text, %s::bigint, %s::uuid, %s::text, %s::text
        ) as capability(result)
        """,
        (*capability[:7], payload_text, *capability[7:]),
    ).fetchall()


def test_direct_dsn_actor_uuid_is_inert_without_one_use_capability(
    migrated_database: str,
) -> None:
    with psycopg.connect(
        migrated_database,
        autocommit=True,
        row_factory=dict_row,
    ) as connection:
        connection.execute("set role teamflow_hitl_service")
        with pytest.raises(psycopg.Error) as guessed_actor:
            connection.execute(
                "select * from teamflow_private.resolve_active_membership(%s)",
                (ACTOR,),
            )
        assert guessed_actor.value.sqlstate == "42501"

        expired = _actor_capability(
            actor_id=ACTOR,
            operation="resolve_membership",
            payload={},
            expires_at=int(time.time()) - 1,
        )
        with pytest.raises(psycopg.Error) as expired_capability:
            _execute_actor_operation(connection, expired, {})
        assert expired_capability.value.sqlstate == "PT403"

        actor_bound = list(
            _actor_capability(
                actor_id=ACTOR,
                operation="resolve_membership",
                payload={},
            )
        )
        actor_bound[0] = OUTSIDER
        with pytest.raises(psycopg.Error) as cross_actor:
            _execute_actor_operation(connection, tuple(actor_bound), {})
        assert cross_actor.value.sqlstate == "PT403"

        issuer_bound = list(
            _actor_capability(
                actor_id=ACTOR,
                operation="resolve_membership",
                payload={},
            )
        )
        issuer_bound[1] = "https://other.example.test/auth/v1"
        with pytest.raises(psycopg.Error) as cross_project:
            _execute_actor_operation(connection, tuple(issuer_bound), {})
        assert cross_project.value.sqlstate == "PT403"

        cloned_project = list(
            _actor_capability(
                actor_id=ACTOR,
                operation="resolve_membership",
                payload={},
            )
        )
        cloned_project[1] = "https://other.example.test/auth/v1"
        connection.execute("reset role")
        connection.execute(
            "update teamflow_private.hitl_capability_keys set auth_issuer=%s where key_id=%s",
            (cloned_project[1], CAPABILITY_KEY_ID),
        )
        connection.execute("set role teamflow_hitl_service")
        try:
            with pytest.raises(psycopg.Error) as cloned_project_replay:
                _execute_actor_operation(connection, tuple(cloned_project), {})
            assert cloned_project_replay.value.sqlstate == "PT403"
        finally:
            connection.execute("reset role")
            connection.execute(
                "update teamflow_private.hitl_capability_keys set auth_issuer=%s where key_id=%s",
                (AUTH_ISSUER, CAPABILITY_KEY_ID),
            )
            connection.execute("set role teamflow_hitl_service")

        capability = _actor_capability(
            actor_id=ACTOR,
            operation="resolve_membership",
            payload={},
        )
        result = _execute_actor_operation(connection, capability, {})
        assert result == [{"result": {"merchant_id": MERCHANT, "membership_role": "manager"}}]
        with pytest.raises(psycopg.Error) as replay:
            _execute_actor_operation(connection, capability, {})
        assert replay.value.sqlstate == "PT403"
        assert replay.value.diag.message_primary == "teamflow_hitl_capability_replayed"

        payload_bound = _actor_capability(
            actor_id=ACTOR,
            operation="resolve_membership",
            payload={},
        )
        with pytest.raises(psycopg.Error) as changed_payload:
            _execute_actor_operation(
                connection,
                payload_bound,
                {"workflow_id": "1a000000-0000-4000-8000-000000000001"},
            )
        assert changed_payload.value.sqlstate == "PT403"
        assert changed_payload.value.diag.message_primary == "teamflow_hitl_capability_invalid"

        connection.execute("reset role")

        assert connection.execute(
            "select teamflow_private.attest_hitl_runtime(%s, %s) as ready",
            (CAPABILITY_KEY_ID, AUTH_ISSUER),
        ).fetchone() == {"ready": False}

        with psycopg.connect(
            _hitl_service_dsn(migrated_database),
            autocommit=True,
            row_factory=dict_row,
        ) as service_connection:
            assert service_connection.execute(
                "select teamflow_private.attest_hitl_runtime(%s, %s) as ready",
                (CAPABILITY_KEY_ID, AUTH_ISSUER),
            ).fetchone() == {"ready": True}
            assert service_connection.execute(
                "select teamflow_private.attest_hitl_runtime(%s, %s) as ready",
                ("0" * 64, AUTH_ISSUER),
            ).fetchone() == {"ready": False}
            assert service_connection.execute(
                "select teamflow_private.attest_hitl_runtime(%s, %s) as ready",
                (CAPABILITY_KEY_ID, "https://other.example.test/auth/v1"),
            ).fetchone() == {"ready": False}

        connection.execute(
            "grant insert on teamflow_private.hitl_capability_keys to teamflow_hitl_service"
        )
        try:
            with psycopg.connect(
                _hitl_service_dsn(migrated_database),
                autocommit=True,
                row_factory=dict_row,
            ) as drifted_connection:
                assert drifted_connection.execute(
                    "select teamflow_private.attest_hitl_runtime(%s, %s) as ready",
                    (CAPABILITY_KEY_ID, AUTH_ISSUER),
                ).fetchone() == {"ready": False}
        finally:
            connection.execute(
                "revoke insert on teamflow_private.hitl_capability_keys from teamflow_hitl_service"
            )

        connection.execute("grant teamflow_hiring_reader to teamflow_hitl_service")
        try:
            with psycopg.connect(
                _hitl_service_dsn(migrated_database),
                autocommit=True,
                row_factory=dict_row,
            ) as drifted_connection:
                assert drifted_connection.execute(
                    "select teamflow_private.attest_hitl_runtime(%s, %s) as ready",
                    (CAPABILITY_KEY_ID, AUTH_ISSUER),
                ).fetchone() == {"ready": False}
        finally:
            connection.execute("revoke teamflow_hiring_reader from teamflow_hitl_service")

        connection.execute("grant select on auth.sessions to teamflow_hitl_service")
        try:
            with psycopg.connect(
                _hitl_service_dsn(migrated_database),
                autocommit=True,
                row_factory=dict_row,
            ) as drifted_connection:
                assert drifted_connection.execute(
                    "select teamflow_private.attest_hitl_runtime(%s, %s) as ready",
                    (CAPABILITY_KEY_ID, AUTH_ISSUER),
                ).fetchone() == {"ready": False}
        finally:
            connection.execute("revoke select on auth.sessions from teamflow_hitl_service")

        connection.execute("create sequence teamflow_private.hitl_attestation_drift_sequence")
        connection.execute(
            "grant usage on sequence teamflow_private.hitl_attestation_drift_sequence "
            "to teamflow_hitl_service"
        )
        try:
            with psycopg.connect(
                _hitl_service_dsn(migrated_database),
                autocommit=True,
                row_factory=dict_row,
            ) as drifted_connection:
                assert drifted_connection.execute(
                    "select teamflow_private.attest_hitl_runtime(%s, %s) as ready",
                    (CAPABILITY_KEY_ID, AUTH_ISSUER),
                ).fetchone() == {"ready": False}
        finally:
            connection.execute("drop sequence teamflow_private.hitl_attestation_drift_sequence")

        connection.execute("grant usage on schema auth to teamflow_hitl_service")
        try:
            with psycopg.connect(
                _hitl_service_dsn(migrated_database),
                autocommit=True,
                row_factory=dict_row,
            ) as drifted_connection:
                assert drifted_connection.execute(
                    "select teamflow_private.attest_hitl_runtime(%s, %s) as ready",
                    (CAPABILITY_KEY_ID, AUTH_ISSUER),
                ).fetchone() == {"ready": False}
        finally:
            connection.execute("revoke usage on schema auth from teamflow_hitl_service")

        connection.execute(
            """
            create function public.hitl_attestation_drift()
            returns boolean language sql security definer set search_path = ''
            as 'select true'
            """
        )
        connection.execute(
            "grant execute on function public.hitl_attestation_drift() to teamflow_hitl_service"
        )
        try:
            with psycopg.connect(
                _hitl_service_dsn(migrated_database),
                autocommit=True,
                row_factory=dict_row,
            ) as drifted_connection:
                assert drifted_connection.execute(
                    "select teamflow_private.attest_hitl_runtime(%s, %s) as ready",
                    (CAPABILITY_KEY_ID, AUTH_ISSUER),
                ).fetchone() == {"ready": False}
        finally:
            connection.execute("drop function public.hitl_attestation_drift()")


def test_decision_capability_requires_recent_aal2_and_live_session(
    migrated_database: str,
) -> None:
    session_id = "a2000000-0000-4000-8000-000000000001"
    payload = {
        "workflow_id": "1a000000-0000-4000-8000-000000000001",
        "review_id": "1b000000-0000-4000-8000-000000000001",
        "decision_id": "1c000000-0000-4000-8000-000000000001",
        "expected_review_version": 1,
        "client_request_sha256": "f" * 64,
    }
    now = int(time.time())
    with psycopg.connect(
        migrated_database,
        autocommit=True,
        row_factory=dict_row,
    ) as connection:
        connection.execute(
            "insert into auth.sessions(id,user_id) values (%s,%s)",
            (session_id, ACTOR),
        )
        connection.execute("set role teamflow_hitl_service")

        for capability in (
            _actor_capability(
                actor_id=ACTOR,
                operation="recover_decision",
                payload=payload,
                session_id=session_id,
                assurance_level="aal1",
                authenticated_at=now,
            ),
            _actor_capability(
                actor_id=ACTOR,
                operation="recover_decision",
                payload=payload,
                session_id=session_id,
                assurance_level="aal2",
                authenticated_at=now - 601,
            ),
            _actor_capability(
                actor_id=ACTOR,
                operation="recover_decision",
                payload=payload,
                session_id="a2000000-0000-4000-8000-000000000099",
                assurance_level="aal2",
                authenticated_at=now,
            ),
        ):
            with pytest.raises(psycopg.Error) as denied:
                _execute_actor_operation(connection, capability, payload)
            assert denied.value.sqlstate == "PT403"
            assert denied.value.diag.message_primary == "teamflow_recent_aal2_session_required"

        valid = _actor_capability(
            actor_id=ACTOR,
            operation="recover_decision",
            payload=payload,
            session_id=session_id,
            assurance_level="aal2",
            authenticated_at=now,
        )
        assert _execute_actor_operation(connection, valid, payload) == []
        connection.execute("reset role")

        consumed = connection.execute(
            """
            select operation, actor_id
            from teamflow_private.hitl_consumed_capabilities
            where nonce=%s
            """,
            (valid[8],),
        ).fetchone()
        assert consumed == {"operation": "recover_decision", "actor_id": UUID(ACTOR)}


def test_expired_capability_cleanup_is_bounded_idempotent_and_operator_only(
    migrated_database: str,
) -> None:
    old_nonces = (
        "a3000000-0000-4000-8000-000000000001",
        "a3000000-0000-4000-8000-000000000002",
    )
    live_nonce = "a3000000-0000-4000-8000-000000000003"
    with psycopg.connect(
        migrated_database,
        autocommit=True,
        row_factory=dict_row,
    ) as connection:
        connection.execute(
            """
            insert into teamflow_private.hitl_consumed_capabilities (
              key_id, nonce, actor_id, operation, resource_sha256, expires_at
            ) values
              (%s,%s,%s,'resolve_membership',%s,now() - interval '10 minutes'),
              (%s,%s,%s,'resolve_membership',%s,now() - interval '9 minutes'),
              (%s,%s,%s,'resolve_membership',%s,now() + interval '10 minutes')
            """,
            (
                CAPABILITY_KEY_ID,
                old_nonces[0],
                ACTOR,
                "1" * 64,
                CAPABILITY_KEY_ID,
                old_nonces[1],
                ACTOR,
                "2" * 64,
                CAPABILITY_KEY_ID,
                live_nonce,
                ACTOR,
                "3" * 64,
            ),
        )

        with pytest.raises(psycopg.Error) as unsafe_cutoff:
            connection.execute(
                """
                select teamflow_private.cleanup_expired_hitl_capabilities(
                  now() - interval '1 minute', 100
                )
                """
            )
        assert unsafe_cutoff.value.sqlstate == "22023"

        first = connection.execute(
            """
            select teamflow_private.cleanup_expired_hitl_capabilities(
              now() - interval '5 minutes', 1
            ) as deleted
            """
        ).fetchone()
        assert first == {"deleted": 1}
        remaining = connection.execute(
            """
            select
              count(*) filter (where nonce = any(%s::uuid[])) as expired,
              count(*) filter (where nonce = %s::uuid) as live
            from teamflow_private.hitl_consumed_capabilities
            """,
            (list(old_nonces), live_nonce),
        ).fetchone()
        assert remaining == {"expired": 1, "live": 1}

        assert connection.execute(
            """
            select teamflow_private.cleanup_expired_hitl_capabilities(
              now() - interval '5 minutes', 1
            ) as deleted
            """
        ).fetchone() == {"deleted": 1}
        assert connection.execute(
            """
            select teamflow_private.cleanup_expired_hitl_capabilities(
              now() - interval '5 minutes', 1
            ) as deleted
            """
        ).fetchone() == {"deleted": 0}
        assert connection.execute(
            """
            select count(*) as count
            from teamflow_private.hitl_consumed_capabilities
            where nonce=%s
            """,
            (live_nonce,),
        ).fetchone() == {"count": 1}

        connection.execute("set role teamflow_hitl_service")
        with pytest.raises(psycopg.Error) as runtime_cleanup:
            connection.execute(
                """
                select teamflow_private.cleanup_expired_hitl_capabilities(
                  now() - interval '5 minutes', 1
                )
                """
            )
        assert runtime_cleanup.value.sqlstate == "42501"
        connection.execute("reset role")


def test_retention_inventory_is_hold_aware_and_structurally_non_destructive(
    migrated_database: str,
) -> None:
    request_id = "f5000000-0000-4000-8000-000000000001"
    workflow_id = "16000000-0000-4000-8000-000000000001"
    analysis_id = "e5000000-0000-4000-8000-000000000001"
    decision_id = "17000000-0000-4000-8000-000000000001"
    request_sha = "c" * 64
    asyncio.run(
        _prepare(
            migrated_database,
            request_id=request_id,
            workflow_id=workflow_id,
            analysis_id=analysis_id,
            request_sha=request_sha,
            analysis_sha="d" * 64,
            score=100,
        )
    )
    with psycopg.connect(migrated_database, row_factory=dict_row) as connection:
        review = connection.execute(
            "select * from teamflow_private.create_resume_review(%s,%s,%s,%s,%s)",
            (
                workflow_id,
                request_id,
                request_sha,
                analysis_id,
                Jsonb(["analysis_complete", "human_approval_required"]),
            ),
        ).fetchone()
        assert review is not None
        connection.commit()
    recorded = asyncio.run(
        _record_reject(
            migrated_database,
            workflow_id=workflow_id,
            review_id=str(review["review_id"]),
            decision_id=decision_id,
            client_sha="e" * 64,
        )
    )
    assert recorded == (workflow_id, None)

    with psycopg.connect(migrated_database, row_factory=dict_row) as connection:
        connection.execute(
            """
            insert into teamflow_private.resume_review_retention_policies (
              merchant_id, policy_version, retention_days, inventory_enabled,
              approved_by, approved_at, legal_basis_code
            ) values (%s,'policy-1',1,true,%s,now(),'employment-records')
            """,
            (MERCHANT, OWNER),
        )
        as_of = connection.execute("select now() + interval '2 days' as value").fetchone()["value"]
        before = connection.execute(
            """
            select
              (select count(*) from public.resume_review_workflows) as workflows,
              (select count(*) from public.resume_reviews) as reviews,
              (select count(*) from public.resume_review_decisions) as decisions,
              (select count(*) from public.candidate_score_revisions) as revisions,
              (select count(*) from public.resume_review_events) as events
            """
        ).fetchone()
        due = connection.execute(
            """
            select *
            from teamflow_private.resume_review_retention_due_inventory(%s)
            where workflow_id=%s
            """,
            (as_of, workflow_id),
        ).fetchone()
        assert due is not None
        assert due["legal_hold"] is False
        assert due["legal_hold_ids"] == []
        assert due["purge_permitted"] is False
        assert (
            connection.execute(
                """
            select
              (select count(*) from public.resume_review_workflows) as workflows,
              (select count(*) from public.resume_reviews) as reviews,
              (select count(*) from public.resume_review_decisions) as decisions,
              (select count(*) from public.candidate_score_revisions) as revisions,
              (select count(*) from public.resume_review_events) as events
            """
            ).fetchone()
            == before
        )

        hold_id = "18000000-0000-4000-8000-000000000001"
        connection.execute(
            """
            insert into teamflow_private.resume_review_legal_holds (
              id, merchant_id, scope, workflow_id, reason_code, created_by
            ) values (%s,%s,'workflow',%s,'active-investigation',%s)
            """,
            (hold_id, MERCHANT, workflow_id, OWNER),
        )
        held = connection.execute(
            """
            select legal_hold, legal_hold_ids, purge_permitted
            from teamflow_private.resume_review_retention_due_inventory(%s)
            where workflow_id=%s
            """,
            (as_of, workflow_id),
        ).fetchone()
        assert held == {
            "legal_hold": True,
            "legal_hold_ids": [UUID(hold_id)],
            "purge_permitted": False,
        }
        connection.commit()

        with pytest.raises(psycopg.Error) as held_delete:
            connection.execute(
                "delete from public.resume_review_workflows where id=%s",
                (workflow_id,),
            )
        assert held_delete.value.sqlstate == "23503"
        assert (
            held_delete.value.diag.constraint_name
            == "resume_review_legal_holds_merchant_id_workflow_id_fkey"
        )
        connection.rollback()
        assert connection.execute(
            "select count(*) as count from teamflow_private.resume_review_legal_holds where id=%s",
            (hold_id,),
        ).fetchone() == {"count": 1}

        with pytest.raises(psycopg.Error) as activation:
            connection.execute(
                """
                update teamflow_private.resume_review_retention_policies
                set purge_enabled=true where merchant_id=%s
                """,
                (MERCHANT,),
            )
        assert activation.value.sqlstate == "23514"
        connection.rollback()

        connection.execute("set role teamflow_hitl_service")
        with pytest.raises(psycopg.Error) as application_inventory:
            connection.execute(
                "select * from teamflow_private.resume_review_retention_due_inventory(%s)",
                (as_of,),
            )
        assert application_inventory.value.sqlstate == "42501"
        connection.rollback()
        connection.execute("reset role")
