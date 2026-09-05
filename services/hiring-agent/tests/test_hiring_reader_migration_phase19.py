"""Isolated PostgreSQL 17 proof for the standalone Phase 19 reader boundary."""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.rows import dict_row

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS = tuple(
    REPOSITORY_ROOT / "supabase/migrations" / name
    for name in (
        "000_teamflow_base.sql",
        "001_add_embedding_column.sql",
        "20260826211439_harden_hiring_data_api.sql",
    )
)
TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
JOB_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01"
JOB_A_INACTIVE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02"
JOB_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01"
CANDIDATE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab01"
CANDIDATE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbc01"
QUERY_VECTOR = "[" + ",".join(["1", *("0" for _ in range(767))]) + "]"


def _replace_database(dsn: str, database: str) -> str:
    parsed = urlsplit(dsn)
    return urlunsplit((parsed.scheme, parsed.netloc, f"/{database}", parsed.query, ""))


def _claims(merchant_id: str | None = TENANT_A, role: str | None = "teamflow_hiring_reader") -> str:
    payload = {}
    if merchant_id is not None:
        payload["merchant_id"] = merchant_id
    if role is not None:
        payload["role"] = role
    return json.dumps(payload, separators=(",", ":"))


def _set_reader_claims(connection: psycopg.Connection, claims: str) -> None:
    connection.execute("reset role")
    connection.execute("select set_config('request.jwt.claims', %s, false)", (claims,))
    connection.execute("set role teamflow_hiring_reader")


def _rpc_count(
    connection: psycopg.Connection,
    *,
    merchant_id: str = TENANT_A,
    threshold: float | str = 0.5,
    count: int = 5,
    vector: str = QUERY_VECTOR,
) -> int:
    return connection.execute(
        """
        select count(*) as result_count
        from public.teamflow_match_candidates(
          %s::vector, %s::uuid, %s::double precision, %s::integer
        )
        """,
        (vector, merchant_id, threshold, count),
    ).fetchone()["result_count"]


def test_phase19_reader_migration_is_replayable_and_tenant_bound() -> None:
    source_dsn = os.getenv("TEST_SUPABASE_POSTGRES_DSN")
    if not source_dsn:
        pytest.skip("TEST_SUPABASE_POSTGRES_DSN is not configured")
    parsed = urlsplit(source_dsn)
    if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        pytest.skip("Phase 19 replay is restricted to local PostgreSQL")

    assert [migration.name for migration in MIGRATIONS] == [
        "000_teamflow_base.sql",
        "001_add_embedding_column.sql",
        "20260826211439_harden_hiring_data_api.sql",
    ]
    assert all(migration.is_file() for migration in MIGRATIONS)

    database = f"teamflow_phase19_{uuid4().hex}"
    admin_dsn = _replace_database(source_dsn, "postgres")
    replay_dsn = _replace_database(source_dsn, database)
    reader_existed = False

    with psycopg.connect(admin_dsn, autocommit=True) as admin:
        assert admin.execute(
            "select rolsuper from pg_roles where rolname = current_user"
        ).fetchone()[0]
        reader_existed = admin.execute(
            "select exists(select 1 from pg_roles where rolname = 'teamflow_hiring_reader')"
        ).fetchone()[0]
        admin.execute(
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
        admin.execute(sql.SQL("create database {} owner postgres").format(sql.Identifier(database)))

    try:
        with psycopg.connect(replay_dsn, autocommit=True, row_factory=dict_row) as connection:
            connection.execute("set role postgres")
            for migration in MIGRATIONS:
                connection.execute(migration.read_text(encoding="utf-8"), prepare=False)

            # The focused migration is safe to retry and does not rely on later tables.
            connection.execute(MIGRATIONS[-1].read_text(encoding="utf-8"), prepare=False)

            connection.execute(
                """
                insert into public.merchants (id, email, store_name) values
                  (%s, 'tenant-a@example.invalid', 'Tenant A'),
                  (%s, 'tenant-b@example.invalid', 'Tenant B')
                """,
                (TENANT_A, TENANT_B),
            )
            connection.execute(
                """
                insert into public.jobs (id, merchant_id, title, is_active) values
                  (%s, %s, 'Active A', true),
                  (%s, %s, 'Inactive A', false),
                  (%s, %s, 'Active B', true)
                """,
                (JOB_A, TENANT_A, JOB_A_INACTIVE, TENANT_A, JOB_B, TENANT_B),
            )
            connection.execute(
                """
                insert into public.candidates (
                  id, merchant_id, job_id, name, email, status, resume_url,
                  resume_text, embedding
                ) values
                  (%s, %s, %s, 'Candidate A', 'candidate-a@example.invalid',
                   'new', 'private/a.pdf', 'Tenant A evidence', %s::vector),
                  (%s, %s, %s, 'Candidate B', 'candidate-b@example.invalid',
                   'new', 'private/b.pdf', 'Tenant B evidence', %s::vector)
                """,
                (
                    CANDIDATE_A,
                    TENANT_A,
                    JOB_A,
                    QUERY_VECTOR,
                    CANDIDATE_B,
                    TENANT_B,
                    JOB_B,
                    QUERY_VECTOR,
                ),
            )

            role = connection.execute(
                """
                select rolcanlogin, rolinherit, rolcreatedb, rolcreaterole,
                       rolsuper, rolreplication, rolbypassrls
                from pg_roles where rolname = 'teamflow_hiring_reader'
                """
            ).fetchone()
            assert role == {
                "rolcanlogin": False,
                "rolinherit": False,
                "rolcreatedb": False,
                "rolcreaterole": False,
                "rolsuper": False,
                "rolreplication": False,
                "rolbypassrls": False,
            }

            memberships = connection.execute(
                """
                select granted.rolname as granted_role,
                       member.rolname as member_role,
                       membership.admin_option,
                       membership.inherit_option,
                       membership.set_option
                from pg_auth_members as membership
                join pg_roles as granted on granted.oid = membership.roleid
                join pg_roles as member on member.oid = membership.member
                where granted.rolname = 'teamflow_hiring_reader'
                   or member.rolname = 'teamflow_hiring_reader'
                """
            ).fetchall()
            assert {
                (
                    row["granted_role"],
                    row["member_role"],
                    row["admin_option"],
                    row["inherit_option"],
                    row["set_option"],
                )
                for row in memberships
            } == {
                ("teamflow_hiring_reader", "postgres", True, False, False),
                ("teamflow_hiring_reader", "authenticator", False, False, True),
            }

            owned_objects = connection.execute(
                """
                select
                  (select count(*) from pg_class
                   where relowner = (select oid from pg_roles
                                     where rolname = 'teamflow_hiring_reader'))
                  +
                  (select count(*) from pg_proc
                   where proowner = (select oid from pg_roles
                                     where rolname = 'teamflow_hiring_reader'))
                  +
                  (select count(*) from pg_namespace
                   where nspowner = (select oid from pg_roles
                                     where rolname = 'teamflow_hiring_reader'))
                  as object_count
                """
            ).fetchone()
            assert owned_objects == {"object_count": 0}

            reader_columns = connection.execute(
                """
                select table_name, column_name
                from information_schema.column_privileges
                where table_schema = 'public'
                  and grantee = 'teamflow_hiring_reader'
                  and privilege_type = 'SELECT'
                order by table_name, column_name
                """
            ).fetchall()
            assert {(row["table_name"], row["column_name"]) for row in reader_columns} == {
                ("jobs", "id"),
                ("jobs", "merchant_id"),
                ("jobs", "title"),
                ("jobs", "description"),
                ("jobs", "dealbreakers"),
                ("jobs", "nice_to_haves"),
                ("jobs", "is_active"),
                ("candidates", "id"),
                ("candidates", "merchant_id"),
                ("candidates", "job_id"),
                ("candidates", "status"),
                ("candidates", "resume_text"),
                ("candidates", "created_at"),
                ("candidates", "embedding"),
            }

            acl = connection.execute(
                """
                select
                  has_table_privilege('teamflow_hiring_reader', 'public.jobs', 'SELECT')
                    as reader_table_select,
                  has_schema_privilege('teamflow_hiring_reader', 'public', 'CREATE')
                    as reader_schema_create,
                  has_column_privilege(
                    'teamflow_hiring_reader', 'public.candidates', 'email', 'SELECT'
                  ) as reader_email,
                  has_table_privilege('anon', 'public.jobs', 'SELECT')
                    as anon_jobs_select,
                  has_table_privilege('authenticated', 'public.candidates', 'SELECT')
                    as authenticated_candidates_select,
                  has_table_privilege('authenticator', 'public.candidates', 'SELECT')
                    as authenticator_candidates_select,
                  has_table_privilege('service_role', 'public.merchants', 'SELECT')
                    as service_merchants_select,
                  has_table_privilege('service_role', 'public.jobs', 'SELECT')
                    as service_jobs_select,
                  has_table_privilege('service_role', 'public.jobs', 'INSERT')
                    as service_jobs_insert,
                  (has_table_privilege('service_role', 'public.candidates', 'SELECT')
                   and has_table_privilege('service_role', 'public.candidates', 'INSERT')
                   and has_table_privilege('service_role', 'public.candidates', 'UPDATE')
                   and has_table_privilege('service_role', 'public.candidates', 'DELETE'))
                    as service_candidates_crud,
                  (has_table_privilege('service_role', 'public.applications', 'SELECT')
                   and has_table_privilege('service_role', 'public.applications', 'INSERT'))
                    as service_applications_write,
                  has_table_privilege('service_role', 'public.applications', 'UPDATE')
                    as service_applications_update,
                  has_table_privilege('service_role', 'public.audit_logs', 'SELECT')
                    as service_audit_select,
                  has_function_privilege(
                    'service_role',
                    'public.match_candidates(vector,uuid,double precision,integer)',
                    'EXECUTE'
                  ) as service_legacy_rpc,
                  has_function_privilege(
                    'service_role',
                    'public.teamflow_match_candidates(vector,uuid,double precision,integer)',
                    'EXECUTE'
                  ) as service_scoped_rpc,
                  has_function_privilege(
                    'teamflow_hiring_reader',
                    'public.match_candidates(vector,uuid,double precision,integer)',
                    'EXECUTE'
                  ) as reader_legacy_rpc,
                  has_function_privilege(
                    'teamflow_hiring_reader',
                    'public.teamflow_match_candidates(vector,uuid,double precision,integer)',
                    'EXECUTE'
                  ) as reader_scoped_rpc,
                  has_function_privilege(
                    'anon', 'public.teamflow_request_jwt_claims()', 'EXECUTE'
                  ) as anon_claims_helper,
                  has_function_privilege(
                    'service_role', 'public.teamflow_request_jwt_claims()', 'EXECUTE'
                  ) as service_claims_helper,
                  has_function_privilege(
                    'teamflow_hiring_reader',
                    'public.teamflow_request_jwt_claims()', 'EXECUTE'
                  ) as reader_claims_helper
                """
            ).fetchone()
            assert acl == {
                "reader_table_select": False,
                "reader_schema_create": False,
                "reader_email": False,
                "anon_jobs_select": False,
                "authenticated_candidates_select": False,
                "authenticator_candidates_select": False,
                "service_merchants_select": True,
                "service_jobs_select": True,
                "service_jobs_insert": False,
                "service_candidates_crud": True,
                "service_applications_write": True,
                "service_applications_update": False,
                "service_audit_select": False,
                "service_legacy_rpc": True,
                "service_scoped_rpc": False,
                "reader_legacy_rpc": False,
                "reader_scoped_rpc": True,
                "anon_claims_helper": False,
                "service_claims_helper": False,
                "reader_claims_helper": True,
            }

            database_shape = connection.execute(
                """
                select
                  (select count(*) from pg_policy as policy
                   join pg_class as relation on relation.oid = policy.polrelid
                   join pg_namespace as namespace on namespace.oid = relation.relnamespace
                   where namespace.nspname = 'public'
                     and relation.relname = any(array[
                       'merchants', 'jobs', 'candidates', 'applications', 'audit_logs'
                     ])) as policy_count,
                  (select count(*) from pg_proc as procedure
                   join pg_namespace as namespace on namespace.oid = procedure.pronamespace
                   where namespace.nspname = 'public'
                     and procedure.proname = 'teamflow_match_candidates') as rpc_overloads,
                  (select not procedure.prosecdef
                          and procedure.provolatile = 's'
                          and procedure.proconfig @> array[
                            'search_path=pg_catalog, extensions, public'
                          ]::text[]
                   from pg_proc as procedure
                   where procedure.oid = 'public.teamflow_match_candidates(
                     vector,uuid,double precision,integer
                   )'::regprocedure) as rpc_safe,
                  (select pg_get_function_result(procedure.oid)
                   from pg_proc as procedure
                   where procedure.oid = 'public.teamflow_match_candidates(
                     vector,uuid,double precision,integer
                   )'::regprocedure) as rpc_result,
                  (select procedure.proowner = (
                     select oid from pg_roles where rolname = 'postgres'
                   ) from pg_proc as procedure
                   where procedure.oid = 'public.teamflow_match_candidates(
                     vector,uuid,double precision,integer
                   )'::regprocedure) as rpc_owned_by_postgres,
                  (select not procedure.prosecdef
                          and procedure.provolatile = 's'
                          and procedure.proconfig @> array['search_path=pg_catalog']::text[]
                          and procedure.proowner = (
                            select oid from pg_roles where rolname = 'postgres'
                          )
                   from pg_proc as procedure
                   where procedure.oid =
                     'public.teamflow_request_jwt_claims()'::regprocedure)
                    as claims_helper_safe,
                  (select bool_and(relation.relrowsecurity)
                   from pg_class as relation
                   join pg_namespace as namespace on namespace.oid = relation.relnamespace
                   where namespace.nspname = 'public'
                     and relation.relname = any(array[
                       'merchants', 'jobs', 'candidates', 'applications', 'audit_logs'
                     ])) as all_rls
                """
            ).fetchone()
            assert database_shape == {
                "policy_count": 2,
                "rpc_overloads": 1,
                "rpc_safe": True,
                "rpc_result": "TABLE(merchant_id uuid, similarity double precision)",
                "rpc_owned_by_postgres": True,
                "claims_helper_safe": True,
                "all_rls": True,
            }

            index_names = {
                row["indexname"]
                for row in connection.execute(
                    """
                    select indexname from pg_indexes
                    where schemaname = 'public'
                      and indexname = any(array[
                        'jobs_merchant_id_idx',
                        'candidates_merchant_created_id_idx',
                        'candidates_merchant_status_created_id_idx'
                      ])
                    """
                ).fetchall()
            }
            assert index_names == {
                "jobs_merchant_id_idx",
                "candidates_merchant_created_id_idx",
                "candidates_merchant_status_created_id_idx",
            }

            _set_reader_claims(connection, _claims())
            jobs = connection.execute(
                """
                select id, merchant_id, title, description, dealbreakers,
                       nice_to_haves, is_active
                from public.jobs order by id
                """
            ).fetchall()
            assert [str(row["id"]) for row in jobs] == [JOB_A]
            candidates = connection.execute(
                """
                select id, merchant_id, job_id, status, resume_text, created_at
                from public.candidates order by created_at desc, id
                """
            ).fetchall()
            assert [str(row["id"]) for row in candidates] == [CANDIDATE_A]
            assert _rpc_count(connection) == 1
            assert _rpc_count(connection, merchant_id=TENANT_B) == 0
            assert _rpc_count(connection, vector="[1,0]") == 0
            for invalid_count in (-1, 0, 21):
                assert _rpc_count(connection, count=invalid_count) == 0
            for invalid_threshold in (-0.1, 1.1, "NaN"):
                assert _rpc_count(connection, threshold=invalid_threshold) == 0

            with pytest.raises(psycopg.errors.InsufficientPrivilege) as email_error:
                connection.execute("select email from public.candidates")
            assert email_error.value.sqlstate == "42501"
            with pytest.raises(psycopg.errors.InsufficientPrivilege) as update_error:
                connection.execute(
                    "update public.candidates set status = 'hired' where id = %s",
                    (CANDIDATE_A,),
                )
            assert update_error.value.sqlstate == "42501"
            with pytest.raises(psycopg.errors.InsufficientPrivilege) as legacy_rpc_error:
                connection.execute(
                    "select * from public.match_candidates(%s::vector, %s, 0.5, 5)",
                    (QUERY_VECTOR, TENANT_A),
                )
            assert legacy_rpc_error.value.sqlstate == "42501"

            for rejected_claims in (
                _claims(role="authenticated"),
                _claims(merchant_id=None),
                _claims(role=None),
                _claims(merchant_id=TENANT_A.upper()),
                _claims(merchant_id="not-a-uuid"),
                "{}",
                "not-json",
                "x" * 8193,
                "",
            ):
                _set_reader_claims(connection, rejected_claims)
                assert connection.execute(
                    "select count(id) as row_count from public.candidates"
                ).fetchone() == {"row_count": 0}
                assert _rpc_count(connection) == 0

            connection.execute("reset role")
            connection.execute("set role postgres")
            connection.execute(
                """
                create table public.phase19_future_table (id bigint);
                create sequence public.phase19_future_sequence;
                create function public.phase19_future_function()
                returns integer language sql as 'select 1';
                """
            )
            future_acl = connection.execute(
                """
                select
                  has_table_privilege('anon', 'public.phase19_future_table', 'SELECT')
                    as anon_table,
                  has_table_privilege(
                    'authenticated', 'public.phase19_future_table', 'MAINTAIN'
                  ) as authenticated_maintain,
                  has_table_privilege(
                    'service_role', 'public.phase19_future_table', 'TRUNCATE'
                  ) as service_truncate,
                  has_table_privilege(
                    'teamflow_hiring_reader', 'public.phase19_future_table', 'SELECT'
                  ) as reader_table,
                  has_sequence_privilege(
                    'service_role', 'public.phase19_future_sequence', 'USAGE'
                  ) as service_sequence,
                  has_function_privilege(
                    'anon', 'public.phase19_future_function()', 'EXECUTE'
                  ) as anon_function,
                  has_function_privilege(
                    'service_role', 'public.phase19_future_function()', 'EXECUTE'
                  ) as service_function,
                  has_function_privilege(
                    'teamflow_hiring_reader', 'public.phase19_future_function()', 'EXECUTE'
                  ) as reader_function
                """
            ).fetchone()
            assert future_acl == {
                "anon_table": False,
                "authenticated_maintain": False,
                "service_truncate": False,
                "reader_table": False,
                "service_sequence": False,
                "anon_function": False,
                "service_function": False,
                "reader_function": False,
            }

            # Database ownership implicitly grants pg_database_owner and can restore
            # CREATE on public. A drifted reader must stop the migration, not be
            # normalized into an apparently safe role.
            connection.execute("reset role")
            connection.execute(
                sql.SQL("alter database {} owner to teamflow_hiring_reader").format(
                    sql.Identifier(database)
                )
            )
            connection.execute("set role postgres")
            with pytest.raises(psycopg.errors.InsufficientPrivilege) as owner_drift_error:
                connection.execute(MIGRATIONS[-1].read_text(encoding="utf-8"), prepare=False)
            assert owner_drift_error.value.sqlstate == "42501"
            assert "teamflow_hiring_reader_owns_database_objects" in str(owner_drift_error.value)
            connection.execute("rollback")
            connection.execute("reset role")
            connection.execute(
                sql.SQL("alter database {} owner to postgres").format(sql.Identifier(database))
            )
    finally:
        with psycopg.connect(admin_dsn, autocommit=True) as admin:
            admin.execute(
                sql.SQL("drop database if exists {} with (force)").format(sql.Identifier(database))
            )
            if (
                not reader_existed
                and admin.execute(
                    "select exists(select 1 from pg_roles where rolname = 'teamflow_hiring_reader')"
                ).fetchone()[0]
            ):
                admin.execute("revoke teamflow_hiring_reader from authenticator")
                admin.execute("drop role teamflow_hiring_reader")
