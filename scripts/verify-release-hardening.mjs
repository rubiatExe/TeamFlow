import { readFileSync } from "node:fs";

const failures = [];

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

const workflowPaths = [
  ".github/workflows/ci.yml",
  ".github/workflows/deploy-python-service.yml",
  ".github/workflows/deploy-hiring-agent.yml",
];

for (const path of workflowPaths) {
  const source = read(path);
  const externalUses = [...source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)]
    .map((match) => match[1])
    .filter((value) => !value.startsWith("./") && !value.startsWith("docker://"));

  for (const value of externalUses) {
    assert(
      /@[0-9a-f]{40}$/.test(value),
      `${path}: external action must use a full commit SHA (${value})`,
    );
  }

  assert(!source.includes("ubuntu-latest"), `${path}: runner OS must not use ubuntu-latest`);
  assert(!/:latest(?:\s|$)/m.test(source), `${path}: mutable :latest reference is forbidden`);
  assert(
    !source.includes("--allow-unauthenticated"),
    `${path}: deployment CI must not mutate Cloud Run invoker IAM`,
  );
}

for (const path of [
  ".github/workflows/deploy-python-service.yml",
  ".github/workflows/deploy-hiring-agent.yml",
]) {
  const source = read(path);
  for (const required of [
    "environment: production",
    "concurrency:",
    "cancel-in-progress: false",
    "queue: max",
    "no_traffic: true",
    "Capture current traffic",
    "Verify candidate provenance",
    "Probe candidate readiness",
    "Run candidate authenticated",
    "Promote candidate revision",
    "Rollback traffic",
    "Verify rollback readiness",
    "steps.rollback.outcome == 'success'",
    "Previous revision did not become ready after rollback",
    "requirements-dev.lock",
    "--require-hashes",
    "gcloud_version: '582.0.0'",
    "workflow_call:",
    "RUNTIME_SERVICE_ACCOUNT",
    "--service-account=${{ env.RUNTIME_SERVICE_ACCOUNT }}",
    "BUILD_SERVICE_ACCOUNT",
    "ARTIFACT_REPOSITORY",
    "Build, scan, and publish immutable image",
    "Verify provenance and generate SBOM",
    "gcloud artifacts sbom export",
    "--show-provenance --show-sbom-references",
    "Candidate digest does not match the scanned release artifact",
    "OTEL_PROPAGATORS=tracecontext",
    "Production service must be bootstrapped and verified before automated rollout",
    "gcloud run services get-iam-policy",
    "allUsers roles/run.invoker",
    "run.googleapis.com/ingress",
    "gcloud meta list-files-for-upload",
    "Cloud Build source archive includes an environment or generated OIDC credential file",
    "--cpu=1",
    "--min-instances=0",
    "--max-instances=10",
    "--port=8080",
    "--startup-probe=httpGet.path=/ready,httpGet.port=8080",
    "--liveness-probe=httpGet.path=/health,httpGet.port=8080",
    "Remove and verify candidate traffic tag",
    "Candidate tag cleanup failed",
    "gcloud secrets versions access",
    "steps.promote.outcome != 'success'",
    "steps.smoke.outcome != 'success'",
    "steps.candidate_tag.outcome == 'success'",
    "steps.promote.outcome != 'skipped'",
    "ruff format --check",
    "python -m pytest tests",
  ]) {
    assert(source.includes(required), `${path}: missing release gate marker ${required}`);
  }
  assert(
    /_SECRET_VERSION/.test(source),
    `${path}: Secret Manager references must use configured numeric versions`,
  );
  assert(!source.includes("source: ./services/"), `${path}: source deploy would rebuild an unverified artifact`);
  assert(!source.includes("print-identity-token"), `${path}: platform identity-token probe conflicts with the application-token client posture`);
  assert(!source.includes("tracecontext,baggage"), `${path}: cross-service baggage propagation is forbidden`);
  assert(!source.includes("continue-on-error:"), `${path}: release cleanup or verification failure must not be hidden`);

  const authenticatedCanary = source.indexOf("- name: Run candidate authenticated");
  const candidateTagCleanup = source.indexOf(
    "- name: Remove and verify candidate traffic tag",
  );
  const promotion = source.indexOf("- name: Promote candidate revision");
  assert(
    authenticatedCanary !== -1 &&
      candidateTagCleanup > authenticatedCanary &&
      promotion > candidateTagCleanup,
    `${path}: candidate tag must be removed after canaries and before promotion`,
  );
  const cleanupSection = source.slice(candidateTagCleanup, promotion);
  for (const marker of [
    '--remove-tags="$REVISION_TAG"',
    "if: ${{ always() && steps.deploy.outcome == 'success' }}",
    "gcloud run services describe",
    "select(.tag == $tag)",
    "candidate_percent",
    "previous_percent",
    '"$candidate_percent" != "0"',
    '"$previous_percent" != "100"',
  ]) {
    assert(
      cleanupSection.includes(marker),
      `${path}: pre-promotion candidate-tag verification is missing ${marker}`,
    );
  }
  assert(
    !source.slice(promotion).includes('--remove-tags="$REVISION_TAG"'),
    `${path}: candidate tag cleanup must not be deferred until after promotion`,
  );
  const promotionSection = source.slice(
    promotion,
    source.indexOf("- name: Verify promoted readiness", promotion),
  );
  assert(
    promotionSection.includes(
      "if: ${{ success() && steps.candidate_tag.outcome == 'success' }}",
    ),
    `${path}: promotion must remain gated on canaries and verified cleanup`,
  );
}

const ci = read(".github/workflows/ci.yml");
assert(ci.includes("postgres:16.15-trixie@sha256:"), ".github/workflows/ci.yml: PostgreSQL image is not pinned");
assert(
  ci.includes("cancel-in-progress: false") && ci.includes("queue: max"),
  ".github/workflows/ci.yml: every pending release run must remain serialized",
);
assert(
  !ci.includes("git diff --name-only") &&
    /if \[\[ "\$GITHUB_EVENT_NAME" == "push" \]\]; then[\s\S]*document_processor=true[\s\S]*hiring_agent=true/.test(ci),
  ".github/workflows/ci.yml: every successful main snapshot must deploy both services",
);
assert(
  !ci.includes("cancel-in-progress: true"),
  ".github/workflows/ci.yml: unconditional cancellation can strand promoted traffic",
);
assert(ci.includes("npm ci --ignore-scripts"), ".github/workflows/ci.yml: npm lifecycle scripts are not disabled");
for (const marker of [
  "Resolve Deployment Scope",
  "needs.deployment-scope.outputs.document_processor",
  "needs.deployment-scope.outputs.hiring_agent",
  "uses: ./.github/workflows/deploy-python-service.yml",
  "uses: ./.github/workflows/deploy-hiring-agent.yml",
  "- nextjs-checks",
  "- document-processor-checks",
  "- hiring-agent-checks",
  "- supabase-migration-replay",
  "- container-builds",
  "npm run build",
  "npm audit --audit-level=high",
  "ruff format --check services/document-processor/ scripts/verify-models.py",
  "working-directory: services/document-processor",
  "working-directory: services/hiring-agent",
]) {
  assert(ci.includes(marker), `.github/workflows/ci.yml: deploy is not gated by the full CI graph (${marker})`);
}
assert(
  (ci.match(/ruff format --check/g) ?? []).length >= 2,
  ".github/workflows/ci.yml: both Python services must pass Ruff format checks",
);
for (const marker of [
  "Supabase — Fresh Migration Replay",
  "public.ecr.aws/supabase/postgres:17.6.1.054@sha256:982abcf1b97c2787f002327d0b30224f1bad819748a22bb1e979bb42dd701a48",
  "TEST_SUPABASE_POSTGRES_DSN",
  "test_hiring_reader_migration_phase19.py",
  "test_supabase_migration_replay_phase8a.py",
]) {
  assert(ci.includes(marker), `.github/workflows/ci.yml: missing fresh Supabase replay gate ${marker}`);
}
assert(
  (ci.match(/python -m pytest tests/g) ?? []).length >= 2,
  ".github/workflows/ci.yml: both Python suites must run with the service directory on Python's import path",
);

const workspaceVerifier = read("scripts/verify-workspace.mjs");
for (const testFile of [
  "test_hiring_reader_migration_phase19.py",
  "test_supabase_migration_replay_phase8a.py",
]) {
  assert(
    (workspaceVerifier.match(new RegExp(testFile, "g")) ?? []).length >= 2,
    `scripts/verify-workspace.mjs: ${testFile} must move from deterministic checks to the Supabase integration suite`,
  );
}

for (const path of [
  "services/document-processor/Dockerfile",
  "services/hiring-agent/Dockerfile",
]) {
  const source = read(path);
  assert(
    /^FROM\s+[^\s:]+(?::[^\s@]+)?@sha256:[0-9a-f]{64}$/m.test(source),
    `${path}: base image must include a tag and sha256 digest`,
  );
  assert(source.includes("--require-hashes"), `${path}: pip hashes are not enforced`);
  assert(source.includes("requirements.lock"), `${path}: runtime lock is not installed`);
  assert(source.includes("COPY --chown=10001:10001"), `${path}: source copy lacks fixed ownership`);
  assert(/^USER\s+10001:10001$/m.test(source), `${path}: runtime user must be numeric and non-root`);
  const hasJsonExecCommand = /^CMD\s+\[\s*"[^"\r\n]+"(?:\s*,\s*"[^"\r\n]+")*\s*\]\s*$/m.test(source);
  const hasShellExecCommand = /^CMD\s+.*\bexec\s+[^\r\n]+$/m.test(source);
  assert(
    hasJsonExecCommand || hasShellExecCommand,
    `${path}: runtime command must use JSON exec form or an explicit shell exec`,
  );
}

for (const path of [
  "services/document-processor/cloudbuild.release.yaml",
  "services/hiring-agent/cloudbuild.release.yaml",
]) {
  const source = read(path);
  const builderImages = [...source.matchAll(/^\s*name:\s*(\S+)$/gm)].map((match) => match[1]);
  assert(builderImages.length >= 2, `${path}: expected pinned build and scanner images`);
  for (const image of builderImages) {
    assert(/@sha256:[0-9a-f]{64}$/.test(image), `${path}: builder image is not digest-pinned (${image})`);
  }
  for (const marker of [
    "docker images scan",
    "docker images list-vulnerabilities",
    "HIGH|CRITICAL",
    "images:",
    "CLOUD_LOGGING_ONLY",
    "requestedVerifyOption: VERIFIED",
    "timeout: 1800s",
  ]) {
    assert(source.includes(marker), `${path}: missing Cloud Build supply-chain gate ${marker}`);
  }
  assert(
    /list-vulnerabilities[\s\S]{0,300}>\s*\/workspace\/vulnerabilities\.txt/.test(source),
    `${path}: vulnerability query must complete successfully before severity filtering`,
  );
  assert(
    !/if\s+gcloud artifacts docker images list-vulnerabilities/.test(source),
    `${path}: scanner command inside an if condition can fail open`,
  );
  assert(!/docker push/.test(source), `${path}: explicit push disables Cloud Build provenance`);
}

const compose = read("ops/observability/docker-compose.yml");
assert(/image:\s*\S+@sha256:[0-9a-f]{64}/.test(compose), "observability image is not digest-pinned");
for (const marker of ["read_only: true", "no-new-privileges:true", "cap_drop:", "- ALL"]) {
  assert(compose.includes(marker), `observability collector missing container hardening: ${marker}`);
}

function normalizePackage(name) {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function directPins(path) {
  return read(path)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("-r "))
    .map((line) => {
      const match = /^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?==([^\s;]+)(?:\s*;.*)?$/.exec(line);
      assert(Boolean(match), `${path}: direct dependency is not exactly pinned (${line})`);
      return match ? `${normalizePackage(match[1])}==${match[2]}` : "";
    })
    .filter(Boolean);
}

function lockedPins(path) {
  const source = read(path);
  assert(!/^\s*(?:--index-url|--extra-index-url|git\+|https?:\/\/)/m.test(source), `${path}: unapproved dependency source`);
  const starts = [...source.matchAll(/^([A-Za-z0-9_.-]+)==([^\s;\\]+)(?:\s*;[^\\]+)?\s*\\$/gm)];
  assert(starts.length > 0, `${path}: no locked dependencies found`);

  const pins = new Set();
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1]?.index ?? source.length;
    const block = source.slice(start.index, end);
    assert(block.includes("--hash=sha256:"), `${path}: ${start[1]}==${start[2]} has no sha256 hash`);
    pins.add(`${normalizePackage(start[1])}==${start[2]}`);
  }
  return pins;
}

for (const service of ["services/document-processor", "services/hiring-agent"]) {
  const runtimeLock = lockedPins(`${service}/requirements.lock`);
  const devLock = lockedPins(`${service}/requirements-dev.lock`);
  for (const pin of directPins(`${service}/requirements.txt`)) {
    assert(runtimeLock.has(pin), `${service}/requirements.lock: missing direct pin ${pin}`);
    assert(devLock.has(pin), `${service}/requirements-dev.lock: missing runtime pin ${pin}`);
  }
  for (const pin of directPins(`${service}/requirements-dev.txt`)) {
    assert(devLock.has(pin), `${service}/requirements-dev.lock: missing direct pin ${pin}`);
  }

  for (const dockerignore of [read(`${service}/.dockerignore`)]) {
    assert(dockerignore.includes("gha-creds-*.json"), `${service}/.dockerignore: generated OIDC credentials are not excluded`);
    assert(dockerignore.includes(".env*"), `${service}/.dockerignore: environment files are not excluded`);
    assert(dockerignore.includes("cloudbuild*.yaml"), `${service}/.dockerignore: release control file enters runtime image`);
  }

  const gcloudignore = read(`${service}/.gcloudignore`);
  for (const marker of [".env*", "gha-creds-*.json", "tests/", "requirements-dev.lock"]) {
    assert(gcloudignore.includes(marker), `${service}/.gcloudignore: Cloud Build upload exclusion is missing ${marker}`);
  }
}

const packageLock = JSON.parse(read("package-lock.json"));
assert(packageLock.lockfileVersion >= 3, "package-lock.json: lockfileVersion must be at least 3");
for (const [path, entry] of Object.entries(packageLock.packages ?? {})) {
  if (!path || entry.link || !entry.resolved) continue;
  assert(
    entry.resolved.startsWith("https://registry.npmjs.org/"),
    `package-lock.json: ${path} uses an unapproved source (${entry.resolved})`,
  );
  assert(/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity ?? ""), `package-lock.json: ${path} lacks sha512 integrity`);
}

assert(read(".gitignore").includes("gha-creds-*.json"), ".gitignore: generated OIDC credentials are not excluded");

const envExample = read(".env.example");
assert(
  /^OTEL_PROPAGATORS=tracecontext$/m.test(envExample) &&
    !envExample.includes("OTEL_PROPAGATORS=tracecontext,baggage"),
  ".env.example: cross-service OpenTelemetry propagation must exclude baggage",
);
for (const name of [
  "OCR_SERVICE_TRUSTED_ORIGIN",
  "HIRING_AGENT_TRUSTED_ORIGIN",
  "SUPABASE_TRUSTED_ORIGIN",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_HIRING_READER_TOKEN",
]) {
  assert(envExample.includes(`${name}=`), `.env.example: missing production trusted origin ${name}`);
}
assert(
  (envExample.match(/Production: independent CSPRNG token with >=256 bits of entropy; 32-512 printable/g) ?? []).length === 2 &&
    (envExample.match(/Format validation does not attest entropy\./g) ?? []).length === 2,
  ".env.example: both production service-token boundaries must document format and entropy separately",
);

const serviceTokenPolicies = [
  {
    path: "services/document-processor/main.py",
    markers: [
      "len(token) <= 512",
      "len(token) >= 32",
      "token.isascii()",
      "token.isprintable()",
      "character.isspace()",
    ],
  },
  {
    path: "services/hiring-agent/teamflow_hiring_agent/http_api.py",
    markers: [
      "1 <= len(self.service_token) <= 512",
      "len(self.service_token) < 32",
      "self.service_token.isascii()",
      "self.service_token.isprintable()",
      "character.isspace()",
    ],
  },
];
for (const { path, markers } of serviceTokenPolicies) {
  const source = read(path);
  for (const marker of markers) {
    assert(source.includes(marker), `${path}: service-token policy is missing ${marker}`);
  }
}

const nextServiceToken = read("lib/http/service-token.ts");
for (const marker of [
  "token.length > 512",
  "token.length >= 32",
  String.raw`/^[\u0021-\u007e]+$/u`,
]) {
  assert(nextServiceToken.includes(marker), `lib/http/service-token.ts: client token policy is missing ${marker}`);
}
for (const path of ["lib/ai/document-processor-client.ts", "lib/ai/hiring-agent-client.ts"]) {
  assert(read(path).includes("isValidServiceToken"), `${path}: outbound client does not enforce the shared service-token policy`);
}

const hiringDeploy = read(".github/workflows/deploy-hiring-agent.yml");
for (const disabledAuthority of ["AGENT_ALLOW_WRITES=false", "TEAMFLOW_HITL_ENABLED=false"]) {
  assert(hiringDeploy.includes(disabledAuthority), `.github/workflows/deploy-hiring-agent.yml: unsafe authority gate (${disabledAuthority})`);
}
for (const marker of [
  "SUPABASE_TRUSTED_ORIGIN_SECRET_VERSION",
  "SUPABASE_PUBLISHABLE_KEY_SECRET_VERSION",
  "SUPABASE_HIRING_READER_TOKEN_SECRET_VERSION",
  "SUPABASE_TRUSTED_ORIGIN=SUPABASE_TRUSTED_ORIGIN:",
  "SUPABASE_PUBLISHABLE_KEY=SUPABASE_PUBLISHABLE_KEY:",
  "SUPABASE_HIRING_READER_TOKEN=SUPABASE_HIRING_READER_TOKEN:",
]) {
  assert(hiringDeploy.includes(marker), `.github/workflows/deploy-hiring-agent.yml: missing scoped Supabase reader secret ${marker}`);
}
for (const forbidden of ["SUPABASE_SERVICE_KEY", "SUPABASE_REVIEW_WRITER_TOKEN"]) {
  assert(!hiringDeploy.includes(forbidden), `.github/workflows/deploy-hiring-agent.yml: forbidden Supabase authority ${forbidden}`);
}

if (failures.length) {
  console.error("Release hardening verification failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Release hardening verification passed.");
