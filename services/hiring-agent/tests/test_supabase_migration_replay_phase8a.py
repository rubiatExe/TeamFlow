"""Opt-in empty Supabase Postgres replay for every checked-in migration."""

from __future__ import annotations

import os
import re
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
MIGRATION_DIRECTORY = REPOSITORY_ROOT / "supabase/migrations"
SEED = REPOSITORY_ROOT / "supabase/seed.sql"
PHASE8A_MIGRATION = MIGRATION_DIRECTORY / "20260828192200_phase8a_supabase_boundary_hardening.sql"
CONFIDENCE_POLICY_SHA256 = "c83ba0b8261bd5d863feb154f9c816099efe49f7b222e50fe72a45689f611e53"
_CONFIDENCE_COMPONENT_IDS = (
    "workflow_completion_gate",
    "extraction_validation_gate",
    "context_validation_gate",
    "agent1_schema_gate",
    "literal_grounding_gate",
    "criteria_coverage",
    "evidence_consistency_gate",
    "score_calculation_gate",
    "provider_completion_gate",
    "safety_validation_gate",
)


def _confidence_artifacts(*, status: str, review_required: bool) -> tuple[object, ...]:
    reason_codes = ["criteria_evidence_missing"]
    policy_identity = {
        "policy_id": "resume-review-confidence",
        "policy_version": "1.0.0",
    }
    signals = [
        {
            "component_id": component_id,
            "score": 88 if component_id == "criteria_coverage" else 100,
            "hard_failure": False,
            "reason_codes": reason_codes if component_id == "criteria_coverage" else [],
        }
        for component_id in _CONFIDENCE_COMPONENT_IDS
    ]
    assessment = {
        "schema_version": "1.0",
        "score": 88,
        "is_probability": False,
        "hard_failure": False,
        "components": [
            {
                "component_id": signal["component_id"],
                "score": signal["score"],
                "reason_codes": signal["reason_codes"],
            }
            for signal in signals
        ],
        "reason_codes": reason_codes,
        "policy_identity": policy_identity,
    }
    policy = {
        "schema_version": "1.0",
        "policy_id": "resume-review-confidence",
        "policy_version": "1.0.0",
        "mode": "shadow",
        "status": "uncalibrated",
        "components": [
            {
                "component_id": component_id,
                "weight": 100 if component_id == "criteria_coverage" else 0,
            }
            for component_id in _CONFIDENCE_COMPONENT_IDS
        ],
    }
    shadow = {
        "schema_version": "1.0",
        "mode": "shadow",
        "score": 88,
        "is_probability": False,
        "hard_failure": False,
        "threshold_applied": False,
        "review_required": review_required,
        "status": status,
        "reason_codes": reason_codes,
        "policy_identity": policy_identity,
        "policy_sha256": CONFIDENCE_POLICY_SHA256,
    }
    return assessment, shadow, policy, signals


def _review_proposal() -> tuple[object, object]:
    role_id = "11111111-1111-4111-8111-111111111111"
    policy_identity = {
        "policy_id": "barista-score-policy",
        "policy_version": "1.0.0",
    }
    role_policy = [
        {
            "schema_version": "1.0",
            "role_id": role_id,
            "role_title": "Barista",
            "policy_identity": policy_identity,
            "criteria": [
                {
                    "criterion_id": "cafe-experience",
                    "criterion_text": "Cafe customer-service experience",
                    "weight": 100,
                }
            ],
        }
    ]
    evaluation = {
        "schema_version": "1.0",
        "ranked_roles": [
            {
                "role_id": role_id,
                "deterministic_score": 0,
                "scoring_policy": policy_identity,
                "criterion_assessments": [
                    {
                        "criterion_id": "cafe-experience",
                        "status": "unknown",
                        "evidence": [],
                    }
                ],
                "gaps": [
                    {
                        "role_id": role_id,
                        "criterion_id": "cafe-experience",
                        "criterion_text": "Cafe customer-service experience",
                        "status": "unknown",
                        "reason_code": "criterion_unknown",
                    }
                ],
            }
        ],
        "recommended_role_id": None,
        "limitations": [],
    }
    return role_policy, evaluation


def _replace_database(dsn: str, database: str) -> str:
    parsed = urlsplit(dsn)
    return urlunsplit((parsed.scheme, parsed.netloc, f"/{database}", parsed.query, ""))


def test_phase8a_source_preserves_the_phase19_reader_contract() -> None:
    """Keep the guard active even when the opt-in PostgreSQL replay is unavailable."""

    source = PHASE8A_MIGRATION.read_text(encoding="utf-8")
    normalized = " ".join(source.split()).lower()

    assert "create or replace function public.teamflow_match_candidates" not in normalized
    assert "drop function if exists public.teamflow_match_candidates" not in normalized
    assert "drop policy if exists teamflow_hiring_reader_jobs_select" not in normalized
    assert "drop policy if exists teamflow_hiring_reader_candidates_select" not in normalized
    assert "auth.jwt()" not in normalized
    assert normalized.count("claims ->> 'role' = 'teamflow_hiring_reader'") == 2
    assert normalized.count("claims ->> 'role' = 'teamflow_review_writer'") == 2

    candidate_grant = re.search(
        r"grant\s+select\s*\(([^)]*)\)\s*on\s+table\s+public\.candidates\s+"
        r"to\s+teamflow_hiring_reader",
        source,
        flags=re.IGNORECASE | re.DOTALL,
    )
    assert candidate_grant is not None
    granted_candidate_columns = {
        column.strip().lower() for column in candidate_grant.group(1).split(",")
    }
    assert granted_candidate_columns == {
        "id",
        "merchant_id",
        "job_id",
        "status",
        "resume_text",
        "created_at",
        "embedding",
    }


def test_all_supabase_migrations_replay_from_an_empty_application_schema() -> None:
    source_dsn = os.getenv("TEST_SUPABASE_POSTGRES_DSN")
    if not source_dsn:
        pytest.skip("TEST_SUPABASE_POSTGRES_DSN is not configured")
    parsed = urlsplit(source_dsn)
    if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        pytest.skip("Migration replay is restricted to local Supabase PostgreSQL")

    migration_files = sorted(MIGRATION_DIRECTORY.glob("*.sql"))
    assert [migration.name for migration in migration_files] == [
        "000_teamflow_base.sql",
        "001_add_embedding_column.sql",
        "20260826211439_harden_hiring_data_api.sql",
        "20260827090000_resume_review_phase4.sql",
        "20260828051404_durable_hitl_phase6.sql",
        "20260828192200_phase8a_supabase_boundary_hardening.sql",
        "20260829001553_hitl_actor_capabilities_and_retention_inventory.sql",
    ]

    database = f"teamflow_replay_{uuid4().hex}"
    admin_dsn = _replace_database(source_dsn, "postgres")
    replay_dsn = _replace_database(source_dsn, database)
    with psycopg.connect(admin_dsn, autocommit=True) as connection:
        if not connection.execute(
            "select rolsuper from pg_roles where rolname = current_user"
        ).fetchone()[0]:
            pytest.skip("Migration replay requires an isolated local superuser")
        connection.execute(
            """
            do $roles$
            begin
              if not exists (select 1 from pg_roles where rolname = 'postgres') then
                create role postgres superuser nologin;
              end if;
              if not exists (select 1 from pg_roles where rolname = 'anon') then
                create role anon nologin;
              end if;
              if not exists (select 1 from pg_roles where rolname = 'authenticated') then
                create role authenticated nologin;
              end if;
              if not exists (select 1 from pg_roles where rolname = 'service_role') then
                create role service_role nologin bypassrls;
              end if;
              if not exists (select 1 from pg_roles where rolname = 'authenticator') then
                create role authenticator nologin noinherit;
              end if;
            end
            $roles$;
            """
        )
        connection.execute(
            sql.SQL("create database {} owner postgres").format(sql.Identifier(database))
        )

    try:
        with psycopg.connect(replay_dsn, autocommit=True, row_factory=dict_row) as connection:
            connection.execute("set role postgres")
            try:
                # Supabase Auth owns these objects before application migrations run.
                connection.execute(
                    """
                    create schema if not exists auth;
                    create table if not exists auth.users (id uuid primary key);
                    create table if not exists auth.sessions (
                      id uuid primary key,
                      user_id uuid not null references auth.users(id)
                    );
                    create or replace function auth.uid()
                    returns uuid language sql stable set search_path = '' as $$
                      select nullif(
                        current_setting('request.jwt.claim.sub', true), ''
                      )::uuid
                    $$;
                    create or replace function auth.jwt()
                    returns jsonb language sql stable set search_path = '' as $$
                      select coalesce(
                        nullif(current_setting('request.jwt.claims', true), ''),
                        '{}'
                      )::jsonb
                    $$;
                    """,
                    prepare=False,
                )
                for migration in migration_files:
                    connection.execute(
                        migration.read_text(encoding="utf-8"),
                        prepare=False,
                    )
                connection.execute(SEED.read_text(encoding="utf-8"), prepare=False)
                connection.execute(
                    """
                    insert into public.resume_documents (
                      merchant_id, document_id, schema_version, content_sha256,
                      snapshot_sha256, status, text, source_blocks,
                      extraction_method, model_id, embedding_available, mock,
                      warnings, quality
                    ) values (
                      '00000000-0000-0000-0000-000000000001'::uuid,
                      'doc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                      '1.0',
                      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                      '1ef90e4e9cd4a3217ed0a98c5b53482cb5bee3798a1a2d9eb820623050d3e03b',
                      'complete', 'Replay evidence',
                      '[{"source_block_id":"src-aaaaaaaaaaaa-p0001-b0001-d2a0ff70adaf",'
                        '"page_number":1,"ordinal":1,"text":"Replay evidence"}]'::jsonb,
                      'pdf_text', 'replay-extractor', true, false, '[]'::jsonb,
                      '{"assessment":"usable","character_count":15,"block_count":1,'
                        '"page_count":1,"reason_codes":[]}'::jsonb
                    )
                    """
                )
            finally:
                connection.execute("reset role")

            state = connection.execute(
                """
                select
                  (select count(*)
                   from pg_class as relation
                   join pg_namespace as namespace
                     on namespace.oid = relation.relnamespace
                   where namespace.nspname = 'public'
                     and relation.relkind = 'r'
                     and relation.relname = any(%s)) as table_count,
                  to_regprocedure(
                    'public.teamflow_match_candidates(vector,uuid,double precision,integer)'
                  ) is not null as scoped_match_rpc,
                  has_function_privilege(
                    'teamflow_hiring_reader',
                    'public.match_candidates(vector,uuid,double precision,integer)',
                    'EXECUTE'
                  ) as legacy_match_reader,
                  has_function_privilege(
                    'teamflow_hiring_reader',
                    'public.teamflow_match_candidates(vector,uuid,double precision,integer)',
                    'EXECUTE'
                  ) as scoped_match_reader,
                  (select pg_get_function_result(procedure.oid)
                   from pg_proc as procedure
                   where procedure.oid =
                     'public.teamflow_match_candidates(
                       vector,uuid,double precision,integer
                     )'::regprocedure) as scoped_match_result,
                  has_column_privilege(
                    'teamflow_hiring_reader', 'public.candidates', 'name', 'SELECT'
                  ) as reader_candidate_name,
                  has_column_privilege(
                    'teamflow_hiring_reader', 'public.candidates', 'analysis', 'SELECT'
                  ) as reader_candidate_analysis,
                  has_column_privilege(
                    'teamflow_hiring_reader', 'public.jobs',
                    'scoring_policy_id', 'SELECT'
                  ) as reader_scoring_policy,
                  has_table_privilege(
                    'service_role', 'public.merchants', 'INSERT'
                  ) as service_merchant_insert,
                  has_table_privilege(
                    'service_role', 'public.jobs', 'UPDATE'
                  ) as service_job_update,
                  has_table_privilege(
                    'service_role', 'public.audit_logs', 'SELECT'
                  ) as service_audit_select,
                  has_function_privilege(
                    'service_role',
                    'public.match_candidates(vector,uuid,double precision,integer)',
                    'EXECUTE'
                  ) as service_legacy_match,
                  has_function_privilege(
                    'teamflow_review_writer', 'public.uuid_generate_v4()', 'EXECUTE'
                  ) as writer_uuid_generator,
                  has_function_privilege(
                    'teamflow_review_writer',
                    'teamflow_private.valid_reason_codes(jsonb)', 'EXECUTE'
                  ) as writer_reason_validator,
                  has_function_privilege(
                    'teamflow_review_writer',
                    'teamflow_private.valid_confidence_provenance('
                    'jsonb,jsonb,jsonb,jsonb,text,boolean,text,boolean)', 'EXECUTE'
                  ) as writer_confidence_validator,
                  has_function_privilege(
                    'teamflow_review_writer', 'extensions.digest(bytea,text)',
                    'EXECUTE'
                  ) as writer_confidence_digest,
                  has_function_privilege(
                    'teamflow_review_writer',
                    'teamflow_private.resolve_active_membership(uuid)', 'EXECUTE'
                  ) as writer_actor_rpc
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
            assert state == {
                "table_count": 14,
                "scoped_match_rpc": True,
                "legacy_match_reader": False,
                "scoped_match_reader": True,
                "scoped_match_result": ("TABLE(merchant_id uuid, similarity double precision)"),
                "reader_candidate_name": False,
                "reader_candidate_analysis": False,
                "reader_scoring_policy": True,
                "service_merchant_insert": False,
                "service_job_update": False,
                "service_audit_select": False,
                "service_legacy_match": True,
                "writer_uuid_generator": True,
                "writer_reason_validator": True,
                "writer_confidence_validator": True,
                "writer_confidence_digest": True,
                "writer_actor_rpc": False,
            }

            connection.execute(
                "select set_config("
                "'request.jwt.claims', "
                '\'{"role":"teamflow_hiring_reader",'
                '"merchant_id":"00000000-0000-0000-0000-000000000001"}\', '
                "false)"
            )
            connection.execute("set role teamflow_hiring_reader")
            try:
                demo_jobs = connection.execute(
                    "select count(id) as job_count from public.jobs"
                ).fetchone()
                match_cursor = connection.execute(
                    """
                    select * from public.teamflow_match_candidates(
                      array_fill(0::real, array[768])::vector,
                      '00000000-0000-0000-0000-000000000099'::uuid,
                      0.5,
                      5
                    )
                    """
                )
                rpc_columns = tuple(column.name for column in match_cursor.description)
                cross_tenant_rpc = match_cursor.fetchall()
            finally:
                connection.execute("reset role")
            assert demo_jobs == {"job_count": 2}
            assert rpc_columns == ("merchant_id", "similarity")
            assert cross_tenant_rpc == []

            for rejected_claims in (
                '{"merchant_id":"00000000-0000-0000-0000-000000000001"}',
                '{"role":"authenticated","merchant_id":"00000000-0000-0000-0000-000000000001"}',
            ):
                connection.execute(
                    "select set_config('request.jwt.claims', %s, false)",
                    (rejected_claims,),
                )
                connection.execute("set role teamflow_hiring_reader")
                try:
                    hidden_jobs = connection.execute(
                        "select count(id) as job_count from public.jobs"
                    ).fetchone()
                finally:
                    connection.execute("reset role")
                assert hidden_jobs == {"job_count": 0}

            connection.execute(
                "select set_config("
                "'request.jwt.claims', "
                '\'{"role":"teamflow_review_writer",'
                '"merchant_id":"00000000-0000-0000-0000-000000000001"}\', '
                "false)"
            )
            connection.execute("set role teamflow_review_writer")
            try:
                role_policy, evaluation = _review_proposal()
                review_confidence = _confidence_artifacts(
                    status="review_required",
                    review_required=True,
                )
                complete_confidence = _confidence_artifacts(
                    status="complete",
                    review_required=False,
                )
                insert_run_statement = """
                    insert into public.resume_review_runs (
                      schema_version, request_id, merchant_id, document_id,
                      input_sha256, extraction_snapshot_sha256, policy_sha256,
                      role_policy_snapshot, confidence_assessment,
                      confidence_shadow_record, confidence_policy_snapshot,
                      confidence_signal_snapshot, confidence_policy_sha256,
                      confidence_threshold_applied, status, review_required,
                      agent1_evaluation, questions_status, question_plan, reason_codes
                    ) values (
                      '1.0', %s::uuid,
                      '00000000-0000-0000-0000-000000000001'::uuid,
                      'doc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                      %s,
                      '1ef90e4e9cd4a3217ed0a98c5b53482cb5bee3798a1a2d9eb820623050d3e03b',
                      '76c77b761408dadc833c98f7fc787dfa2979c0d4f9d0679cc88213fadec810c9',
                      %s, %s, %s, %s, %s, %s, false, %s, %s, %s,
                      'skipped', null, %s
                    )
                    returning id, input_sha256
                """
                with pytest.raises(psycopg.errors.CheckViolation):
                    connection.execute(
                        insert_run_statement,
                        (
                            "44444444-4444-4444-8444-444444444444",
                            "e" * 64,
                            Jsonb(role_policy),
                            Jsonb(complete_confidence[0]),
                            Jsonb(complete_confidence[1]),
                            Jsonb(complete_confidence[2]),
                            Jsonb(complete_confidence[3]),
                            CONFIDENCE_POLICY_SHA256,
                            "complete",
                            False,
                            Jsonb(evaluation),
                            Jsonb(["analysis_complete"]),
                        ),
                    )

                inserted_run = connection.execute(
                    insert_run_statement,
                    (
                        "33333333-3333-4333-8333-333333333333",
                        "c" * 64,
                        Jsonb(role_policy),
                        Jsonb(review_confidence[0]),
                        Jsonb(review_confidence[1]),
                        Jsonb(review_confidence[2]),
                        Jsonb(review_confidence[3]),
                        CONFIDENCE_POLICY_SHA256,
                        "review_required",
                        True,
                        Jsonb(evaluation),
                        Jsonb(["human_approval_required"]),
                    ),
                ).fetchone()
            finally:
                connection.execute("reset role")
            assert inserted_run["id"] is not None
            assert inserted_run["input_sha256"] == "c" * 64

            connection.execute(
                "select set_config("
                "'request.jwt.claims', "
                '\'{"role":"teamflow_hiring_reader",'
                '"merchant_id":"00000000-0000-0000-0000-000000000001"}\', '
                "false)"
            )
            connection.execute("set role teamflow_review_writer")
            try:
                hidden_runs = connection.execute(
                    "select count(id) as run_count from public.resume_review_runs"
                ).fetchone()
            finally:
                connection.execute("reset role")
            assert hidden_runs == {"run_count": 0}
    finally:
        with psycopg.connect(admin_dsn, autocommit=True) as connection:
            connection.execute(
                sql.SQL("drop database {} with (force)").format(sql.Identifier(database))
            )
