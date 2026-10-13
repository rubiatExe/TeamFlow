import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildDocumentProcessorLaunch, loadDocumentProcessorEnvironment } from '../../scripts/run-document-processor.mjs';

test('document launcher uses only the service venv and a fixed loopback listener', () => {
  const inspected: string[] = [];
  const launch = buildDocumentProcessorLaunch({
    projectRoot: '/synthetic/teamflow workspace', environment: {},
    checkExecutable: path => { inspected.push(path); },
  });
  assert.deepEqual(inspected, ['/synthetic/teamflow workspace/services/document-processor/.venv/bin/python']);
  assert.equal(launch.command, inspected[0]);
  assert.deepEqual(launch.args, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8000']);
  assert.equal(launch.options.cwd, '/synthetic/teamflow workspace/services/document-processor');
  assert.equal(launch.options.shell, false);
  assert.equal(launch.options.stdio, 'inherit');
  assert.deepEqual(launch.options.env, {
    ENVIRONMENT: 'development', MOCK_MODE: 'false', OCR_PROVIDER: 'google_cloud_vision', OTEL_CONSOLE_EXPORT_ENABLED: 'false',
  });
});

test('document launcher forwards only required service credentials and safe runtime settings', () => {
  const launch = buildDocumentProcessorLaunch({ checkExecutable() {}, environment: {
    GOOGLE_API_KEY: 'synthetic-gemini', OCR_SERVICE_TOKEN: 'synthetic-ocr',
    GOOGLE_CLOUD_PROJECT: 'test-project', GOOGLE_CLOUD_QUOTA_PROJECT: 'quota-project',
    GOOGLE_APPLICATION_CREDENTIALS: '/synthetic/adc.json', CLOUDSDK_CONFIG: '/synthetic/gcloud',
    PATH: '/synthetic/bin', HOME: '/synthetic/home', LANG: 'en_US.UTF-8', TMPDIR: '/synthetic/tmp',
    SSL_CERT_FILE: '/synthetic/ca.pem', OCR_TIMEOUT_SECONDS: '20', EMBEDDING_TIMEOUT_SECONDS: '8',
    SUPABASE_SERVICE_ROLE_KEY: 'do-not-forward', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'do-not-forward',
    HIRING_AGENT_TOKEN: 'do-not-forward', VERCEL_OIDC_TOKEN: 'do-not-forward', GOOGLE_ACCESS_TOKEN: 'do-not-forward',
    ADMIN_PASSWORD: 'do-not-forward', NODE_OPTIONS: '--require=untrusted', PYTHONPATH: '/untrusted',
    PYTHONSTARTUP: '/untrusted', LD_PRELOAD: '/untrusted', DYLD_INSERT_LIBRARIES: '/untrusted',
    HTTP_PROXY: 'http://untrusted.invalid', HTTPS_PROXY: 'http://untrusted.invalid',
    OCR_SERVICE_URL: 'https://do-not-forward.invalid', HOST: '0.0.0.0', PORT: '80',
  } });
  assert.equal(launch.options.env.GOOGLE_API_KEY, 'synthetic-gemini');
  assert.equal(launch.options.env.OCR_SERVICE_TOKEN, 'synthetic-ocr');
  assert.equal(launch.options.env.GOOGLE_APPLICATION_CREDENTIALS, '/synthetic/adc.json');
  assert.equal(launch.options.env.HOME, '/synthetic/home');
  assert.equal(launch.options.env.OCR_TIMEOUT_SECONDS, '20');
  assert.equal(launch.options.env.SSL_CERT_FILE, '/synthetic/ca.pem');
  for (const key of ['SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'HIRING_AGENT_TOKEN',
    'VERCEL_OIDC_TOKEN', 'GOOGLE_ACCESS_TOKEN', 'ADMIN_PASSWORD', 'NODE_OPTIONS', 'PYTHONPATH',
    'PYTHONSTARTUP', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'HTTP_PROXY', 'HTTPS_PROXY', 'OCR_SERVICE_URL', 'HOST', 'PORT']) {
    assert.equal(launch.options.env[key], undefined, key);
  }
});

test('document launcher preserves explicit service settings without mutating the source environment', () => {
  const environment = { OCR_PROVIDER: 'gemini', MOCK_MODE: 'true', ENVIRONMENT: 'test', OTEL_CONSOLE_EXPORT_ENABLED: 'true' };
  const original = { ...environment };
  const launch = buildDocumentProcessorLaunch({ environment, checkExecutable() {} });
  assert.deepEqual(launch.options.env, environment);
  assert.deepEqual(environment, original);
});

test('missing venv errors are actionable and do not expose environment values', () => {
  assert.throws(() => buildDocumentProcessorLaunch({
    environment: { GOOGLE_API_KEY: 'PRIVATE_KEY' }, checkExecutable() { throw new Error('PRIVATE_INTERNAL_ERROR'); },
  }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Python 3\.11/);
    assert.match(error.message, /requirements-dev\.lock/);
    assert.match(error.message, /--require-hashes/);
    assert.match(error.message, /npm run dev:documents/);
    assert.doesNotMatch(error.message, /PRIVATE/);
    return true;
  });
});

test('root dotenv loading follows Next development precedence with explicit process variables first', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'teamflow-document-launcher-'));
  const originalEnvironment = { ...process.env };
  try {
    for (const key of ['GOOGLE_API_KEY', 'OCR_PROVIDER', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_QUOTA_PROJECT']) delete process.env[key];
    Object.assign(process.env, { NODE_ENV: 'test' });
    process.env.OCR_SERVICE_TOKEN = 'explicit-process-token';
    writeFileSync(join(fixtureRoot, '.env'), 'GOOGLE_CLOUD_PROJECT=base\nGOOGLE_API_KEY=base-key\nOCR_PROVIDER=gemini\n');
    writeFileSync(join(fixtureRoot, '.env.development'), 'GOOGLE_CLOUD_PROJECT=development\nGOOGLE_API_KEY=development-key\n');
    writeFileSync(join(fixtureRoot, '.env.local'), 'GOOGLE_CLOUD_PROJECT=local\nGOOGLE_API_KEY=local-key\n');
    writeFileSync(join(fixtureRoot, '.env.development.local'), 'GOOGLE_CLOUD_PROJECT=development-local\nOCR_SERVICE_TOKEN=file-token\nGOOGLE_CLOUD_QUOTA_PROJECT=$GOOGLE_CLOUD_PROJECT\n');
    writeFileSync(join(fixtureRoot, '.env.test'), 'GOOGLE_CLOUD_PROJECT=wrong-test\n');
    writeFileSync(join(fixtureRoot, '.env.production.local'), 'GOOGLE_CLOUD_PROJECT=wrong-production\n');
    const loaded = loadDocumentProcessorEnvironment(fixtureRoot);
    assert.equal(loaded.GOOGLE_CLOUD_PROJECT, 'development-local');
    assert.equal(loaded.GOOGLE_CLOUD_QUOTA_PROJECT, 'development-local');
    assert.equal(loaded.GOOGLE_API_KEY, 'local-key');
    assert.equal(loaded.OCR_PROVIDER, 'gemini');
    assert.equal(loaded.OCR_SERVICE_TOKEN, 'explicit-process-token');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('npm exposes the standalone local document service without changing next dev', () => {
  const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8'));
  assert.equal(manifest.scripts.dev, 'next dev');
  assert.equal(manifest.scripts['dev:documents'], 'node scripts/run-document-processor.mjs');
});
