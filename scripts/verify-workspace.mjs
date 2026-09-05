import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const pythonCommand =
  process.env.TEAMFLOW_PYTHON_BIN ||
  (process.platform === 'win32' ? 'python' : 'python3');
const pytestGate = resolve(repositoryRoot, 'scripts/pytest-no-skips.py');

function run(label, command, args, options = {}) {
  console.log(`\n[verify] ${label}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: { ...process.env, ...options.env },
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function npmRun(script) {
  run(`npm run ${script}`, npmCommand, ['run', script]);
}

function runPytest(label, serviceDirectory, args) {
  run(label, pythonCommand, [pytestGate, '-q', '-rs', ...args], {
    cwd: resolve(repositoryRoot, serviceDirectory),
  });
}

function enabled(value) {
  return value === '1' || value?.toLowerCase() === 'true';
}

function runEnvGatedPytest({ label, environmentVariable, serviceDirectory, args }) {
  if (process.env[environmentVariable]) {
    runPytest(label, serviceDirectory, args);
    return 'ran';
  }

  const message = `${label} requires ${environmentVariable}`;
  if (enabled(process.env.CI) || enabled(process.env.TEAMFLOW_REQUIRE_INTEGRATION)) {
    throw new Error(`${message}; integration skips are forbidden in this environment`);
  }

  console.log(`\n[verify][env-gated skip] ${message}`);
  return 'skipped';
}

function verifyQuick() {
  npmRun('typecheck');
  npmRun('lint');
  npmRun('verify:contracts');
  npmRun('test');
}

function verifyAll() {
  verifyQuick();
  npmRun('test:journeys:development');
  npmRun('build');
  npmRun('test:journeys:production');

  run(
    'document processor Ruff checks',
    pythonCommand,
    [
      '-m',
      'ruff',
      'check',
      'services/document-processor/',
      'scripts/verify-models.py',
      'scripts/pytest-no-skips.py',
    ],
  );
  run(
    'document processor Ruff format check',
    pythonCommand,
    [
      '-m',
      'ruff',
      'format',
      '--check',
      'services/document-processor/',
      'scripts/verify-models.py',
      'scripts/pytest-no-skips.py',
    ],
  );
  runPytest('document processor tests (no skips)', 'services/document-processor', [
    'tests',
  ]);

  run(
    'hiring agent Ruff checks',
    pythonCommand,
    ['-m', 'ruff', 'check', '.'],
    { cwd: resolve(repositoryRoot, 'services/hiring-agent') },
  );
  run(
    'hiring agent Ruff format check',
    pythonCommand,
    ['-m', 'ruff', 'format', '--check', '.'],
    { cwd: resolve(repositoryRoot, 'services/hiring-agent') },
  );
  run(
    'hiring agent offline evaluation corpus',
    pythonCommand,
    [
      '-m',
      'teamflow_hiring_agent.evaluation',
      'verify',
      '--dataset',
      'evals/resume_review_v1',
    ],
    { cwd: resolve(repositoryRoot, 'services/hiring-agent') },
  );
  runPytest('hiring agent deterministic tests (no skips)', 'services/hiring-agent', [
    'tests',
    '--ignore=tests/test_hiring_reader_migration_phase19.py',
    '--ignore=tests/test_hitl_postgres_repository_phase6.py',
    '--ignore=tests/test_hitl_postgres_restart_phase6.py',
    '--ignore=tests/test_supabase_migration_replay_phase8a.py',
  ]);

  const integrationResults = [
    runEnvGatedPytest({
      label: 'hiring agent PostgreSQL integration tests',
      environmentVariable: 'TEST_POSTGRES_DSN',
      serviceDirectory: 'services/hiring-agent',
      args: [
        'tests/test_hitl_postgres_repository_phase6.py',
        'tests/test_hitl_postgres_restart_phase6.py',
      ],
    }),
    runEnvGatedPytest({
      label: 'Supabase migration replay',
      environmentVariable: 'TEST_SUPABASE_POSTGRES_DSN',
      serviceDirectory: 'services/hiring-agent',
      args: [
        'tests/test_hiring_reader_migration_phase19.py',
        'tests/test_supabase_migration_replay_phase8a.py',
      ],
    }),
  ];

  const skipped = integrationResults.filter((result) => result === 'skipped').length;
  console.log(
    skipped === 0
      ? '\n[verify] all repository and env-gated checks passed'
      : `\n[verify] repository checks passed; ${skipped} env-gated integration suite(s) were explicitly skipped`,
  );
}

const mode = process.argv[2];

try {
  if (mode === 'quick') verifyQuick();
  else if (mode === 'all') verifyAll();
  else throw new Error('Usage: node scripts/verify-workspace.mjs <quick|all>');
} catch (error) {
  console.error(`\n[verify] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
