import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nextBin = resolve(repositoryRoot, 'node_modules/next/dist/bin/next');
const testFile = resolve(
  repositoryRoot,
  'tests/smoke/legacy-demo-routes.test.mjs',
);
const modeArgument = process.argv.find((argument) => argument.startsWith('--mode='));
const mode = modeArgument?.slice('--mode='.length) ?? 'development';

if (!['development', 'production'].includes(mode)) {
  throw new Error('Smoke mode must be development or production');
}

function reservePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve a local smoke-test port'));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForServer(baseUrl, child, logs) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const existingServer = logs.value.match(
        /existing server at (https?:\/\/[^\s,]+)/i,
      );
      if (mode === 'development' && existingServer) {
        return new URL(existingServer[1]).origin;
      }
      throw new Error(`Next server exited before readiness:\n${logs.value}`);
    }
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(2_000) });
      if (response.status < 500) return baseUrl;
    } catch {
      // Compilation and socket startup are expected to race this probe.
    }
    await delay(250);
  }
  throw new Error(`Next server did not become ready within 45 seconds:\n${logs.value}`);
}

function runSmokeTests(baseUrl) {
  return new Promise((resolveTests, reject) => {
    const child = spawn(process.execPath, ['--test', testFile], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        TEAMFLOW_SMOKE_BASE_URL: baseUrl,
        TEAMFLOW_SMOKE_MODE: mode,
      },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveTests();
      else reject(new Error(`Journey smoke failed (${signal ?? `exit ${code}`})`));
    });
  });
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    delay(5_000),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function main() {
  const suppliedBaseUrl = process.env.TEAMFLOW_SMOKE_BASE_URL;
  if (suppliedBaseUrl) {
    const baseUrl = new URL(suppliedBaseUrl).origin;
    await runSmokeTests(baseUrl);
    return;
  }

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverEnvironment = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: '1',
    TEAMFLOW_OTEL_ENABLED: 'false',
  };
  delete serverEnvironment.NODE_ENV;
  if (mode === 'development') {
    serverEnvironment.TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES = 'true';
  } else {
    delete serverEnvironment.TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES;
  }

  const command = mode === 'development' ? 'dev' : 'start';
  const server = spawn(
    process.execPath,
    [nextBin, command, '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd: repositoryRoot,
      env: serverEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const logs = { value: '' };
  const capture = (chunk) => {
    logs.value = `${logs.value}${chunk}`.slice(-16_000);
  };
  server.stdout.on('data', capture);
  server.stderr.on('data', capture);

  try {
    const readyBaseUrl = await waitForServer(baseUrl, server, logs);
    await runSmokeTests(readyBaseUrl);
  } finally {
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
