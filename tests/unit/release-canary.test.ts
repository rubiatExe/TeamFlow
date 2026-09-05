import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function candidateIdentityCanary(path: string): string {
  const workflow = readFileSync(path, 'utf8');
  const canaryStart = workflow.indexOf('- name: Run candidate public identity canary');
  const authenticatedCanaryStart = workflow.indexOf('- name: Run candidate authenticated');

  assert.notEqual(canaryStart, -1, `${path} is missing its candidate canary`);
  assert.notEqual(authenticatedCanaryStart, -1, `${path} is missing its authenticated canary`);
  assert.ok(canaryStart < authenticatedCanaryStart, `${path} identity canary must run first`);
  return workflow.slice(canaryStart, authenticatedCanaryStart);
}

function candidateFunctionalCanary(path: string, name: string): string {
  const workflow = readFileSync(path, 'utf8');
  const canaryStart = workflow.indexOf(`- name: ${name}`);
  const promotionStart = workflow.indexOf('- name: Promote candidate revision');

  assert.notEqual(canaryStart, -1, `${path} is missing its authenticated canary`);
  assert.ok(canaryStart < promotionStart, `${path} authenticated canary must run before promotion`);
  return workflow.slice(canaryStart, promotionStart);
}

function releaseWorkflow(path: string): string {
  return readFileSync(path, 'utf8');
}

function candidateTagCleanup(path: string): string {
  const workflow = releaseWorkflow(path);
  const authenticatedCanaryStart = workflow.indexOf('- name: Run candidate authenticated');
  const cleanupStart = workflow.indexOf('- name: Remove and verify candidate traffic tag');
  const promotionStart = workflow.indexOf('- name: Promote candidate revision');

  assert.notEqual(authenticatedCanaryStart, -1, `${path} is missing its authenticated canary`);
  assert.notEqual(cleanupStart, -1, `${path} is missing candidate tag cleanup`);
  assert.notEqual(promotionStart, -1, `${path} is missing candidate promotion`);
  assert.ok(authenticatedCanaryStart < cleanupStart, `${path} must finish canaries before cleanup`);
  assert.ok(cleanupStart < promotionStart, `${path} must remove the direct tag before promotion`);
  assert.equal(
    workflow.match(/- name: Remove and verify candidate traffic tag/gu)?.length,
    1,
    `${path} must have exactly one pre-promotion cleanup step`,
  );
  assert.doesNotMatch(
    workflow.slice(promotionStart),
    /--remove-tags=/u,
    `${path} must not defer direct-tag cleanup until after promotion`,
  );
  const cleanup = workflow.slice(cleanupStart, promotionStart);
  assert.match(
    cleanup,
    /if:\s*\$\{\{\s*always\(\)\s*&&\s*steps\.deploy\.outcome == 'success'\s*\}\}/u,
    `${path} must clean the direct tag even when a canary or provenance check fails`,
  );
  const promotion = workflow.slice(
    promotionStart,
    workflow.indexOf('- name: Verify promoted readiness'),
  );
  assert.match(
    promotion,
    /if:\s*\$\{\{\s*success\(\)\s*&&\s*steps\.candidate_tag\.outcome == 'success'\s*\}\}/u,
    `${path} must not promote after a failed canary or cleanup`,
  );
  return cleanup;
}

test('document processor validates its public contract before receiving traffic', () => {
  const canary = candidateIdentityCanary('.github/workflows/deploy-python-service.yml');
  assert.match(canary, /\$CANDIDATE_URL\/health/);
  assert.match(canary, /teamflow-document-processor/);
  assert.doesNotMatch(canary, /OCR_SERVICE_TOKEN/);
});

test('hiring agent validates health and identity before receiving traffic', () => {
  const canary = candidateIdentityCanary('.github/workflows/deploy-hiring-agent.yml');
  assert.match(canary, /\$CANDIDATE_URL\/health/);
  assert.match(canary, /\$CANDIDATE_URL\/version/);
  assert.match(canary, /teamflow-hiring-agent/);
  assert.doesNotMatch(canary, /HIRING_AGENT_TOKEN/);
});

test('document processor exercises authenticated OCR and embedding before promotion', () => {
  const canary = candidateFunctionalCanary(
    '.github/workflows/deploy-python-service.yml',
    'Run candidate authenticated extraction canary',
  );
  assert.match(canary, /gcloud secrets versions access/u);
  assert.match(canary, /OCR_SERVICE_TOKEN_SECRET_VERSION/u);
  assert.match(canary, /\$CANDIDATE_URL\/extract/u);
  assert.match(canary, /scanned-resume\.pdf/u);
  assert.match(canary, /\.extraction_method == "gemini_vision"/u);
  assert.match(canary, /\.embedding \| length == 768/u);
  assert.doesNotMatch(canary, /versions access latest/u);
});

test('hiring agent exercises authenticated model and tenant reads before promotion', () => {
  const canary = candidateFunctionalCanary(
    '.github/workflows/deploy-hiring-agent.yml',
    'Run candidate authenticated hiring canary',
  );
  assert.match(canary, /gcloud secrets versions access/u);
  assert.match(canary, /HIRING_AGENT_TOKEN_SECRET_VERSION/u);
  assert.match(canary, /\$CANDIDATE_URL\/invoke/u);
  assert.match(canary, /HIRING_AGENT_CANARY_MERCHANT_ID/u);
  assert.match(canary, /index\("get_candidate"\)/u);
  assert.match(canary, /index\("get_job_requirements"\)/u);
  assert.doesNotMatch(canary, /versions access latest/u);
});

test('both services roll back whenever promotion or verification is not successful', () => {
  for (const path of [
    '.github/workflows/deploy-python-service.yml',
    '.github/workflows/deploy-hiring-agent.yml',
  ]) {
    const workflow = releaseWorkflow(path);
    assert.match(workflow, /steps\.promote\.outcome != 'success'/u);
    assert.match(workflow, /steps\.smoke\.outcome != 'success'/u);
    assert.match(workflow, /steps\.candidate_tag\.outcome == 'success'/u);
    assert.match(workflow, /steps\.promote\.outcome != 'skipped'/u);
    assert.doesNotMatch(workflow, /steps\.smoke\.outcome == 'failure'/u);
  }
});

test('both services remove and verify the zero-traffic candidate tag before promotion', () => {
  for (const path of [
    '.github/workflows/deploy-python-service.yml',
    '.github/workflows/deploy-hiring-agent.yml',
  ]) {
    const cleanup = candidateTagCleanup(path);
    assert.match(cleanup, /--remove-tags="\$REVISION_TAG"/u);
    assert.match(cleanup, /gcloud run services describe/u);
    assert.match(cleanup, /select\(\.tag == \$tag\)/u);
    assert.match(cleanup, /select\(\.revisionName == \$revision\)/u);
    assert.match(cleanup, /candidate_percent/u);
    assert.match(cleanup, /previous_percent/u);
    assert.match(cleanup, /"\$candidate_percent" != "0"/u);
    assert.match(cleanup, /"\$previous_percent" != "100"/u);
  }
});

test('every main release remains queued and deploys the complete tested snapshot', () => {
  const workflow = releaseWorkflow('.github/workflows/ci.yml');

  assert.match(workflow, /cancel-in-progress:\s*false/u);
  assert.match(workflow, /queue:\s*max/u);
  assert.doesNotMatch(workflow, /cancel-in-progress:\s*true/u);
  assert.doesNotMatch(workflow, /git diff --name-only/u);
  assert.match(
    workflow,
    /if \[\[ "\$GITHUB_EVENT_NAME" == "push" \]\]; then[\s\S]*document_processor=true[\s\S]*hiring_agent=true/u,
  );
});

test('service deployment groups preserve every pending serialized release', () => {
  for (const path of [
    '.github/workflows/deploy-python-service.yml',
    '.github/workflows/deploy-hiring-agent.yml',
  ]) {
    const workflow = releaseWorkflow(path);
    assert.match(workflow, /cancel-in-progress:\s*false/u);
    assert.match(workflow, /queue:\s*max/u);
  }
});

test('Supabase-only migration tests run in the pinned Supabase replay job', () => {
  const ci = releaseWorkflow('.github/workflows/ci.yml');
  const replay = ci.slice(
    ci.indexOf('supabase-migration-replay:'),
    ci.indexOf('container-builds:'),
  );
  const hiringChecks = ci.slice(
    ci.indexOf('hiring-agent-checks:'),
    ci.indexOf('supabase-migration-replay:'),
  );
  const hiringDeploy = releaseWorkflow('.github/workflows/deploy-hiring-agent.yml');

  for (const testFile of [
    'test_hiring_reader_migration_phase19.py',
    'test_supabase_migration_replay_phase8a.py',
  ]) {
    assert.match(replay, new RegExp(testFile, 'u'));
    assert.match(hiringChecks, new RegExp(`--ignore=tests/${testFile}`, 'u'));
    assert.match(hiringDeploy, new RegExp(`--ignore=tests/${testFile}`, 'u'));
  }
});
