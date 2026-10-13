import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import nextEnvironment from '@next/env';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Explicitly permit only the credentials/configuration needed by this service.
// Never inherit Supabase, hiring-agent, admin, deployment, or shell hook secrets.
const SERVICE_ENVIRONMENT_KEYS = [
  'GOOGLE_API_KEY', 'OCR_SERVICE_TOKEN', 'OCR_PROVIDER',
  'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_QUOTA_PROJECT',
  'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_CONFIG',
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  'ENVIRONMENT', 'MOCK_MODE', 'OTEL_CONSOLE_EXPORT_ENABLED',
  'OCR_TIMEOUT_SECONDS', 'EMBEDDING_TIMEOUT_SECONDS',
];

/** Load the same root files, expansion rules, and precedence as `next dev`. */
export function loadDocumentProcessorEnvironment(projectRoot = repositoryRoot) {
  // This is a development launcher even if a calling shell sets NODE_ENV=test.
  // NODE_ENV is not forwarded to Python. Explicit service variables still win.
  process.env.NODE_ENV = 'development';
  const { combinedEnv } = nextEnvironment.loadEnvConfig(projectRoot, true, {
    info() {},
    error() {
      throw new Error('Could not load root .env files. Check their syntax and read permissions.');
    },
  }, true);
  return { ...combinedEnv };
}

/**
 * Construct launch arguments without starting a process or exposing secrets.
 * @param {{ projectRoot?: string, environment?: Record<string, string | undefined>, checkExecutable?: (path: string) => void }} options
 */
export function buildDocumentProcessorLaunch(options = {}) {
  const projectRoot = options.projectRoot ?? repositoryRoot;
  const environment = options.environment ?? process.env;
  const serviceRoot = resolve(projectRoot, 'services/document-processor');
  const command = resolve(serviceRoot, '.venv/bin/python');
  const checkExecutable = options.checkExecutable ?? (path => accessSync(path, constants.X_OK));
  try {
    checkExecutable(command);
  } catch {
    throw new Error(
      'Document processor Python environment is missing or not executable. '
      + 'Create services/document-processor/.venv with Python 3.11, then install '
      + 'services/document-processor/requirements-dev.lock with --require-hashes. '
      + 'See services/document-processor/README.md, then retry npm run dev:documents.',
    );
  }
  /** @type {Record<string, string | undefined>} */
  const env = {
    ENVIRONMENT: 'development',
    MOCK_MODE: 'false',
    OCR_PROVIDER: 'google_cloud_vision',
    OTEL_CONSOLE_EXPORT_ENABLED: 'false',
  };
  for (const key of SERVICE_ENVIRONMENT_KEYS) {
    if (typeof environment[key] === 'string') env[key] = environment[key];
  }
  return {
    command,
    args: ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8000'],
    options: { cwd: serviceRoot, env, stdio: 'inherit', shell: false },
  };
}

export async function main() {
  const launch = buildDocumentProcessorLaunch({ environment: loadDocumentProcessorEnvironment() });
  console.info('Starting document processor at http://127.0.0.1:8000 (Ctrl+C to stop).');
  const child = spawn(launch.command, launch.args, {
    ...launch.options,
    stdio: 'inherit',
  });
  return await new Promise((resolveExit, reject) => {
    const interrupt = () => { if (!child.killed) child.kill('SIGINT'); };
    const terminate = () => { if (!child.killed) child.kill('SIGTERM'); };
    const cleanup = () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    child.once('error', () => {
      cleanup();
      reject(new Error('Could not start the document processor. Check its .venv installation and that local port 8000 is available.'));
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolveExit(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1));
    });
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then(code => { process.exitCode = Number(code); }).catch(error => {
    console.error(error instanceof Error ? error.message : 'Document processor launch failed.');
    process.exitCode = 1;
  });
}
