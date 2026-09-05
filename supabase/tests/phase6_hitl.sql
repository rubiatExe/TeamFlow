-- Run with `supabase test db` after applying all migrations.
-- The test is transactional and leaves no users or hiring records behind.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;
select plan(54);

select has_table('public', 'merchant_memberships', 'membership table exists');
select has_table('public', 'resume_review_workflows', 'workflow table exists');
select has_table('public', 'resume_reviews', 'review table exists');
select has_table('public', 'resume_review_decisions', 'decision table exists');
select has_table('public', 'candidate_score_revisions', 'score revision table exists');
select has_table('public', 'resume_review_events', 'event table exists');
select has_column('public', 'candidates', 'score_version', 'candidate score is versioned');
select has_column(
  'public', 'candidates', 'current_score_revision_id',
  'candidate points to its immutable score revision'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.resume_review_workflows'::regclass),
  'workflow table has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.merchant_memberships'::regclass),
  'membership table has RLS enabled'
);
select ok(
  not has_table_privilege('authenticated', 'public.resume_review_workflows', 'SELECT'),
  'authenticated cannot read private workflow snapshots directly'
);
select ok(
  has_table_privilege('authenticated', 'public.merchant_memberships', 'SELECT'),
  'authenticated may read its own active membership through RLS'
);
select ok(
  not has_table_privilege('authenticated', 'public.merchant_memberships', 'INSERT'),
  'authenticated cannot provision memberships'
);
select ok(
  has_function_privilege(
    'teamflow_hitl_service',
    'teamflow_private.create_resume_review(uuid,uuid,text,uuid,jsonb)',
    'EXECUTE'
  ),
  'dedicated service can create a review through the private RPC'
);
select ok(
  not has_table_privilege(
    'teamflow_hitl_service', 'public.resume_review_workflows', 'SELECT'
  ),
  'dedicated service cannot bypass safe projections with table reads'
);
select has_schema('teamflow_checkpoints', 'private checkpoint schema exists');
select ok(
  not (select rolcanlogin from pg_roles where rolname = 'teamflow_checkpoint_runtime'),
  'checkpoint runtime capability role cannot log in'
);
select ok(
  has_schema_privilege(
    'teamflow_checkpoint_runtime', 'teamflow_checkpoints', 'USAGE'
  ),
  'checkpoint runtime can use only its private schema'
);

insert into auth.users (id) values
  ('a1000000-0000-4000-8000-000000000001'),
  ('a1000000-0000-4000-8000-000000000002'),
  ('a1000000-0000-4000-8000-000000000003');
insert into public.merchants (id, email, store_name) values (
  'b1000000-0000-4000-8000-000000000001',
  'phase6-pgtap@example.test',
  'Phase 6 pgTAP'
);
insert into public.jobs (id, merchant_id, title, is_active) values (
  'c1000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  'Reviewer-tested role',
  true
);
insert into public.candidates (
  id, merchant_id, name, resume_url
) values (
  'd1000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  'Phase Six Candidate',
  'private/phase6.pdf'
);
insert into public.resume_documents (
  merchant_id, document_id, schema_version, content_sha256,
  snapshot_sha256, status, text, source_blocks, extraction_method,
  model_id, embedding_available, mock, warnings, quality
) values (
  'b1000000-0000-4000-8000-000000000001',
  'doc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '1.0',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'complete',
  'Verified source text for Phase 6.',
  '[]'::jsonb,
  'pdf_text',
  'test-extractor',
  false,
  false,
  '[]'::jsonb,
  '{}'::jsonb
);
insert into public.candidate_resume_documents (
  merchant_id, candidate_id, document_id
) values (
  'b1000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000001',
  'doc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
);
insert into public.merchant_memberships (merchant_id, user_id, role) values
  (
    'b1000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'manager'
  ),
  (
    'b1000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000002',
    'reviewer'
  );
insert into public.resume_review_runs (
  id, schema_version, request_id, merchant_id, document_id, candidate_id,
  input_sha256, extraction_snapshot_sha256, policy_sha256,
  role_policy_snapshot, confidence_assessment, confidence_shadow_record,
  confidence_policy_snapshot, confidence_signal_snapshot,
  confidence_policy_sha256, confidence_threshold_applied,
  status, review_required, agent1_evaluation,
  questions_status, question_plan, reason_codes
) values (
  'e1000000-0000-4000-8000-000000000001',
  '1.0',
  'f1000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  'doc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'd1000000-0000-4000-8000-000000000001',
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  '[{"schema_version":"1.0"}]'::jsonb,
  '{
    "schema_version":"1.0",
    "score":88,
    "is_probability":false,
    "hard_failure":false,
    "components":[
      {"component_id":"workflow_completion_gate","score":100,"reason_codes":[]},
      {"component_id":"extraction_validation_gate","score":100,"reason_codes":[]},
      {"component_id":"context_validation_gate","score":100,"reason_codes":[]},
      {"component_id":"agent1_schema_gate","score":100,"reason_codes":[]},
      {"component_id":"literal_grounding_gate","score":100,"reason_codes":[]},
      {
        "component_id":"criteria_coverage",
        "score":88,
        "reason_codes":["criteria_evidence_missing"]
      },
      {"component_id":"evidence_consistency_gate","score":100,"reason_codes":[]},
      {"component_id":"score_calculation_gate","score":100,"reason_codes":[]},
      {"component_id":"provider_completion_gate","score":100,"reason_codes":[]},
      {"component_id":"safety_validation_gate","score":100,"reason_codes":[]}
    ],
    "reason_codes":["criteria_evidence_missing"],
    "policy_identity":{
      "policy_id":"resume-review-confidence",
      "policy_version":"1.0.0"
    }
  }'::jsonb,
  '{
    "schema_version":"1.0",
    "mode":"shadow",
    "score":88,
    "is_probability":false,
    "hard_failure":false,
    "threshold_applied":false,
    "review_required":true,
    "status":"review_required",
    "reason_codes":["criteria_evidence_missing"],
    "policy_identity":{
      "policy_id":"resume-review-confidence",
      "policy_version":"1.0.0"
    },
    "policy_sha256":"c83ba0b8261bd5d863feb154f9c816099efe49f7b222e50fe72a45689f611e53"
  }'::jsonb,
  '{
    "schema_version":"1.0",
    "policy_id":"resume-review-confidence",
    "policy_version":"1.0.0",
    "mode":"shadow",
    "status":"uncalibrated",
    "components":[
      {"component_id":"workflow_completion_gate","weight":0},
      {"component_id":"extraction_validation_gate","weight":0},
      {"component_id":"context_validation_gate","weight":0},
      {"component_id":"agent1_schema_gate","weight":0},
      {"component_id":"literal_grounding_gate","weight":0},
      {"component_id":"criteria_coverage","weight":100},
      {"component_id":"evidence_consistency_gate","weight":0},
      {"component_id":"score_calculation_gate","weight":0},
      {"component_id":"provider_completion_gate","weight":0},
      {"component_id":"safety_validation_gate","weight":0}
    ]
  }'::jsonb,
  '[
    {"component_id":"workflow_completion_gate","score":100,"hard_failure":false,"reason_codes":[]},
    {"component_id":"extraction_validation_gate","score":100,"hard_failure":false,"reason_codes":[]},
    {"component_id":"context_validation_gate","score":100,"hard_failure":false,"reason_codes":[]},
    {"component_id":"agent1_schema_gate","score":100,"hard_failure":false,"reason_codes":[]},
    {"component_id":"literal_grounding_gate","score":100,"hard_failure":false,"reason_codes":[]},
    {
      "component_id":"criteria_coverage",
      "score":88,
      "hard_failure":false,
      "reason_codes":["criteria_evidence_missing"]
    },
    {"component_id":"evidence_consistency_gate","score":100,"hard_failure":false,"reason_codes":[]},
    {"component_id":"score_calculation_gate","score":100,"hard_failure":false,"reason_codes":[]},
    {"component_id":"provider_completion_gate","score":100,"hard_failure":false,"reason_codes":[]},
    {"component_id":"safety_validation_gate","score":100,"hard_failure":false,"reason_codes":[]}
  ]'::jsonb,
  'c83ba0b8261bd5d863feb154f9c816099efe49f7b222e50fe72a45689f611e53',
  false,
  'review_required',
  true,
  '{
    "schema_version":"1.0",
    "ranked_roles":[{
      "role_id":"c1000000-0000-4000-8000-000000000001",
      "deterministic_score":80
    }],
    "recommended_role_id":"c1000000-0000-4000-8000-000000000001",
    "limitations":[]
  }'::jsonb,
  'skipped',
  null,
  '["human_approval_required"]'::jsonb
);

select lives_ok($sql$
  select * from teamflow_private.create_resume_review_workflow(
    'a1000000-0000-4000-8000-000000000001',
    '11000000-0000-4000-8000-000000000001',
    'f1000000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000001',
    'doc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'd1000000-0000-4000-8000-000000000001',
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    '["human_approval_required"]'::jsonb
  )
$sql$, 'manager creates the durable workflow');
select is(
  (select score_version from public.candidates
   where id = 'd1000000-0000-4000-8000-000000000001'),
  0::bigint,
  'workflow creation performs no pre-approval candidate write'
);
select ok(
  (select replayed from teamflow_private.create_resume_review_workflow(
    'a1000000-0000-4000-8000-000000000001',
    '11000000-0000-4000-8000-000000000001',
    'f1000000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000001',
    'doc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'd1000000-0000-4000-8000-000000000001',
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    '["human_approval_required"]'::jsonb
  )),
  'exact workflow replay is idempotent'
);
select matches(
  (select thread_id from public.resume_review_workflows
   where id = '11000000-0000-4000-8000-000000000001'),
  '^rrh-v1-[0-9a-f]{64}$',
  'thread ID is opaque, stable, and graph-versioned'
);
select lives_ok($sql$
  select * from teamflow_private.create_resume_review(
    '11000000-0000-4000-8000-000000000001',
    'f1000000-0000-4000-8000-000000000001',
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    'e1000000-0000-4000-8000-000000000001',
    '["human_approval_required"]'::jsonb
  )
$sql$, 'stored manager authority creates a pending review');
select is(
  (select status || ':' || version::text from public.resume_reviews
   where workflow_id = '11000000-0000-4000-8000-000000000001'),
  'pending:1',
  'new review starts at pending version 1'
);
select throws_ok($sql$
  select * from teamflow_private.create_resume_review_workflow(
    'a1000000-0000-4000-8000-000000000002',
    '11000000-0000-4000-8000-000000000009',
    'f1000000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000001',
    'doc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'd1000000-0000-4000-8000-000000000001',
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    '["human_approval_required"]'::jsonb
  )
$sql$, 'PT403', 'teamflow_manager_role_required',
  'reviewer cannot initiate a workflow');
select ok(
  not has_table_privilege('authenticated', 'public.resume_reviews', 'SELECT'),
  'safe inspect RPC is required instead of direct authenticated review reads'
);
select throws_ok(format($sql$
  select * from teamflow_private.decide_resume_review(
    'a1000000-0000-4000-8000-000000000002',
    '11000000-0000-4000-8000-000000000001',
    %L::uuid,
    '12000000-0000-4000-8000-000000000001',
    2, 0, 'approve', repeat('1', 64)
  )
$sql$, (select id from public.resume_reviews
        where workflow_id = '11000000-0000-4000-8000-000000000001')),
  'PT409', 'teamflow_stale_review_version',
  'stale review version is distinguishable');
select throws_ok(format($sql$
  select * from teamflow_private.decide_resume_review(
    'a1000000-0000-4000-8000-000000000002',
    '11000000-0000-4000-8000-000000000001',
    %L::uuid,
    '12000000-0000-4000-8000-000000000001',
    1, 1, 'approve', repeat('1', 64)
  )
$sql$, (select id from public.resume_reviews
        where workflow_id = '11000000-0000-4000-8000-000000000001')),
  'PT409', 'teamflow_stale_candidate_version',
  'stale candidate score version is distinguishable');
select lives_ok(format($sql$
  select * from teamflow_private.decide_resume_review(
    'a1000000-0000-4000-8000-000000000002',
    '11000000-0000-4000-8000-000000000001',
    %L::uuid,
    '12000000-0000-4000-8000-000000000001',
    1, 0, 'approve', repeat('1', 64)
  )
$sql$, (select id from public.resume_reviews
        where workflow_id = '11000000-0000-4000-8000-000000000001')),
  'reviewer records the first valid approval atomically');
select is(
  (select score_version from public.candidates
   where id = 'd1000000-0000-4000-8000-000000000001'),
  1::bigint,
  'approval advances candidate score version exactly once'
);
select is(
  (select fit_score from public.candidates
   where id = 'd1000000-0000-4000-8000-000000000001'),
  80,
  'approval applies the deterministic score'
);
select is(
  (select count(*) from public.candidate_score_revisions),
  1::bigint,
  'approval creates exactly one immutable score revision'
);
select ok(
  (select replayed from teamflow_private.decide_resume_review(
    'a1000000-0000-4000-8000-000000000002',
    '11000000-0000-4000-8000-000000000001',
    (select id from public.resume_reviews
     where workflow_id = '11000000-0000-4000-8000-000000000001'),
    '12000000-0000-4000-8000-000000000001',
    1, 0, 'approve', repeat('1', 64)
  )),
  'exact decision replay returns its original receipt'
);
select is(
  (select count(*) from public.resume_review_decisions),
  1::bigint,
  'decision replay does not duplicate the immutable decision'
);
select throws_ok(format($sql$
  select * from teamflow_private.decide_resume_review(
    'a1000000-0000-4000-8000-000000000002',
    '11000000-0000-4000-8000-000000000001',
    %L::uuid,
    '12000000-0000-4000-8000-000000000001',
    1, 0, 'reject', repeat('2', 64), null, null, null, 'manager_changed_decision'
  )
$sql$, (select id from public.resume_reviews
        where workflow_id = '11000000-0000-4000-8000-000000000001')),
  'PT409', 'teamflow_decision_id_conflict',
  'changed payload under the same decision ID conflicts');
select throws_ok(format($sql$
  select * from teamflow_private.decide_resume_review(
    'a1000000-0000-4000-8000-000000000002',
    '11000000-0000-4000-8000-000000000001',
    %L::uuid,
    '12000000-0000-4000-8000-000000000002',
    1, 0, 'approve', repeat('3', 64)
  )
$sql$, (select id from public.resume_reviews
        where workflow_id = '11000000-0000-4000-8000-000000000001')),
  'PT409', 'teamflow_review_already_decided',
  'a second decision loses the first-valid-decision race');
select throws_ok($sql$
  update public.candidates set fit_score = 12
  where id = 'd1000000-0000-4000-8000-000000000001'
$sql$, '55000', 'teamflow_candidate_score_revision_required',
  'direct candidate score mutation is rejected');
select throws_ok($sql$
  update public.resume_review_decisions set action = 'reject'
  where id = '12000000-0000-4000-8000-000000000001'
$sql$, '55000', 'teamflow_immutable_record_rejects_update',
  'decision records reject updates');
select lives_ok($sql$
  select * from teamflow_private.complete_resume_review_workflow(
    '11000000-0000-4000-8000-000000000001',
    '12000000-0000-4000-8000-000000000001',
    (select id from public.resume_reviews
     where workflow_id = '11000000-0000-4000-8000-000000000001'),
    1
  )
$sql$, 'graph reconciliation completes an approved workflow');
select is(
  (select status || ':' || version::text from public.resume_review_workflows
   where id = '11000000-0000-4000-8000-000000000001'),
  'completed:4',
  'approved workflow reconciles to completed version 4'
);
select ok(
  (select replayed from teamflow_private.complete_resume_review_workflow(
    '11000000-0000-4000-8000-000000000001',
    '12000000-0000-4000-8000-000000000001',
    (select id from public.resume_reviews
     where workflow_id = '11000000-0000-4000-8000-000000000001'),
    1
  )),
  'completion reconciliation is idempotent'
);
select is(
  (select array_agg(event_sequence order by event_sequence)
   from public.resume_review_events
   where workflow_id = '11000000-0000-4000-8000-000000000001'),
  array[1, 2, 3, 4, 5]::bigint[],
  'append-only events have a gap-free per-workflow order'
);
select lives_ok($sql$
  select * from teamflow_private.inspect_resume_review(
    'a1000000-0000-4000-8000-000000000001',
    '11000000-0000-4000-8000-000000000001'
  )
$sql$, 'authorized inspect returns only the explicit safe projection');

insert into public.resume_review_runs (
  id, schema_version, request_id, merchant_id, document_id, candidate_id,
  input_sha256, extraction_snapshot_sha256, policy_sha256,
  role_policy_snapshot, confidence_assessment, confidence_shadow_record,
  confidence_policy_snapshot, confidence_signal_snapshot,
  confidence_policy_sha256, confidence_threshold_applied,
  status, review_required, agent1_evaluation,
  questions_status, question_plan, reason_codes
) values (
  'e1000000-0000-4000-8000-000000000002', '1.0',
  'f1000000-0000-4000-8000-000000000002',
  'b1000000-0000-4000-8000-000000000001',
  'doc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'd1000000-0000-4000-8000-000000000001',
  'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  '[{"schema_version":"1.0"}]'::jsonb,
  (select confidence_assessment from public.resume_review_runs
   where id = 'e1000000-0000-4000-8000-000000000001'),
  (select confidence_shadow_record from public.resume_review_runs
   where id = 'e1000000-0000-4000-8000-000000000001'),
  (select confidence_policy_snapshot from public.resume_review_runs
   where id = 'e1000000-0000-4000-8000-000000000001'),
  (select confidence_signal_snapshot from public.resume_review_runs
   where id = 'e1000000-0000-4000-8000-000000000001'),
  (select confidence_policy_sha256 from public.resume_review_runs
   where id = 'e1000000-0000-4000-8000-000000000001'),
  false,
  'review_required', true,
  '{
    "schema_version":"1.0",
    "ranked_roles":[{
      "role_id":"c1000000-0000-4000-8000-000000000001",
      "deterministic_score":70
    }],
    "recommended_role_id":"c1000000-0000-4000-8000-000000000001",
    "limitations":[]
  }'::jsonb,
  'skipped', null, '["human_approval_required"]'::jsonb
);
select lives_ok($sql$
  select * from teamflow_private.create_resume_review_workflow(
    'a1000000-0000-4000-8000-000000000001',
    '11000000-0000-4000-8000-000000000002',
    'f1000000-0000-4000-8000-000000000002',
    'e1000000-0000-4000-8000-000000000002',
    'doc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'd1000000-0000-4000-8000-000000000001',
    'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    '["human_approval_required"]'::jsonb
  )
$sql$, 'second workflow captures candidate score version 1');
select lives_ok($sql$
  select * from teamflow_private.create_resume_review(
    '11000000-0000-4000-8000-000000000002',
    'f1000000-0000-4000-8000-000000000002',
    'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    'e1000000-0000-4000-8000-000000000002',
    '["human_approval_required"]'::jsonb
  )
$sql$, 'second workflow creates its pending review');
select lives_ok(format($sql$
  select * from teamflow_private.decide_resume_review(
    'a1000000-0000-4000-8000-000000000002',
    '11000000-0000-4000-8000-000000000002',
    %L::uuid,
    '12000000-0000-4000-8000-000000000003',
    1, 1, 'reject', repeat('4', 64), null, null, null,
    'insufficient_job_evidence'
  )
$sql$, (select id from public.resume_reviews
        where workflow_id = '11000000-0000-4000-8000-000000000002')),
  'rejection is recorded atomically');
select is(
  (select score_version from public.candidates
   where id = 'd1000000-0000-4000-8000-000000000001'),
  1::bigint,
  'rejection performs no candidate score write'
);
select is(
  (select count(*) from public.candidate_score_revisions),
  1::bigint,
  'rejection creates no candidate score revision'
);
select lives_ok($sql$
  select * from teamflow_private.complete_resume_review_workflow(
    '11000000-0000-4000-8000-000000000002',
    '12000000-0000-4000-8000-000000000003',
    (select id from public.resume_reviews
     where workflow_id = '11000000-0000-4000-8000-000000000002'),
    1
  )
$sql$, 'graph reconciliation terminalizes rejection');
select is(
  (select status from public.resume_review_workflows
   where id = '11000000-0000-4000-8000-000000000002'),
  'rejected',
  'rejected workflow reaches its distinct terminal state'
);

select set_config(
  'request.jwt.claim.sub',
  'a1000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;
select set_config(
  'teamflow.test.membership_count',
  (select count(*)::text from public.merchant_memberships),
  true
);
reset role;
select is(
  current_setting('teamflow.test.membership_count')::bigint, 1::bigint,
  'active user sees only its own active membership'
);
select set_config(
  'request.jwt.claim.sub',
  'a1000000-0000-4000-8000-000000000003',
  true
);
set local role authenticated;
select set_config(
  'teamflow.test.membership_count',
  (select count(*)::text from public.merchant_memberships),
  true
);
reset role;
select is(
  current_setting('teamflow.test.membership_count')::bigint, 0::bigint,
  'non-member sees no membership rows'
);
select ok(
  not has_table_privilege('anon', 'public.merchant_memberships', 'SELECT'),
  'anonymous role cannot read memberships'
);
select ok(
  not has_table_privilege('service_role', 'public.resume_review_decisions', 'INSERT'),
  'service role cannot bypass the atomic decision RPC with direct insert'
);

select * from finish();
rollback;
