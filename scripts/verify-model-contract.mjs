import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const contractPath = 'config/ai-model-contract.json';
const failures = [];

function fail(message) {
  failures.push(message);
}

function readSource(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    fail(`Cannot read ${file}: ${error.message}`);
    return '';
  }
}

function expectEqual(label, actual, expected) {
  if (actual !== expected) {
    fail(`${label}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
  }
}

function exactCapture(file, source, pattern, description) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const matches = [...source.matchAll(new RegExp(pattern.source, flags))];
  if (matches.length !== 1) {
    fail(`${file}: expected exactly one ${description}, found ${matches.length}`);
    return undefined;
  }
  return matches[0][1];
}

function requirePattern(file, source, pattern, description) {
  if (!pattern.test(source)) {
    fail(`${file}: missing ${description}`);
  }
}

function forbidPattern(file, source, pattern, description) {
  if (pattern.test(source)) {
    fail(`${file}: forbidden ${description}`);
  }
}

function parseAssignments(file, source) {
  const assignments = new Map();
  for (const match of source.matchAll(/^\s*([A-Z][A-Z0-9_]*)=([^\r\n]*)$/gm)) {
    const [, key, rawValue] = match;
    if (assignments.has(key)) {
      fail(`${file}: duplicate assignment for ${key}`);
      continue;
    }
    assignments.set(key, rawValue.trim());
  }
  return assignments;
}

function expectAssignment(file, assignments, key, expected) {
  if (!assignments.has(key)) {
    fail(`${file}: missing assignment for ${key}`);
    return;
  }
  expectEqual(`${file} ${key}`, assignments.get(key), expected);
}

function requireExactKeys(label, value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
    return;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} keys: expected ${expected.join(', ')}, found ${actual.join(', ')}`);
  }
}

function markdownFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...markdownFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(path);
    }
  }
  return files;
}

if (!existsSync(contractPath)) {
  console.error(`Missing canonical model contract: ${contractPath}`);
  process.exit(1);
}

let contract;
try {
  contract = JSON.parse(readSource(contractPath));
} catch (error) {
  console.error(`Invalid JSON in ${contractPath}: ${error.message}`);
  process.exit(1);
}

requireExactKeys('model contract', contract, [
  'schemaVersion',
  'documentOcr',
  'structuredScorer',
  'hiringAgent',
  'embedding',
]);
requireExactKeys('documentOcr', contract.documentOcr, ['models']);
requireExactKeys('structuredScorer', contract.structuredScorer, [
  'primary',
  'fallback',
]);
requireExactKeys('hiringAgent', contract.hiringAgent, ['primary', 'fallback']);
requireExactKeys('embedding', contract.embedding, [
  'apiModel',
  'dimensions',
  'documentTask',
  'queryTask',
]);

if (contract.schemaVersion !== 1) {
  fail('config/ai-model-contract.json must use schemaVersion 1');
}
if (!Array.isArray(contract.documentOcr?.models) || contract.documentOcr.models.length !== 1) {
  fail('documentOcr.models must contain exactly the one runtime OCR model');
}

const ocrModel = contract.documentOcr?.models?.[0];
const scorerModel = contract.structuredScorer?.primary;
const scorerFallbackModel = contract.structuredScorer?.fallback;
const hiringModel = contract.hiringAgent?.primary;
const hiringFallbackModel = contract.hiringAgent?.fallback;
const embeddingModel = contract.embedding?.apiModel;
const embeddingDimensions = contract.embedding?.dimensions;
const documentTask = contract.embedding?.documentTask;
const queryTask = contract.embedding?.queryTask;

for (const [name, value] of Object.entries({
  ocrModel,
  scorerModel,
  scorerFallbackModel,
  hiringModel,
  hiringFallbackModel,
  embeddingModel,
  documentTask,
  queryTask,
})) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`Model contract field ${name} must be a non-empty string`);
  }
}
if (!Number.isInteger(embeddingDimensions) || embeddingDimensions <= 0) {
  fail('Model contract embedding.dimensions must be a positive integer');
}

const files = {
  env: '.env.example',
  scorer: 'lib/ai/scorer.ts',
  legacyParser: 'lib/ai/gemini.ts',
  documentProcessor: 'services/document-processor/main.py',
  hiringConfig: 'services/hiring-agent/teamflow_hiring_agent/config.py',
  mcpServer: 'services/hiring-agent/teamflow_hiring_agent/mcp/server.py',
  documentDeploy: '.github/workflows/deploy-python-service.yml',
  hiringDeploy: '.github/workflows/deploy-hiring-agent.yml',
  schema: 'supabase/schema.sql',
  embeddingMigration: 'supabase/migrations/001_add_embedding_column.sql',
};
const sources = Object.fromEntries(
  Object.entries(files).map(([name, file]) => [name, readSource(file)]),
);

const exampleEnvironment = parseAssignments(files.env, sources.env);
expectAssignment(files.env, exampleEnvironment, 'SCORER_MODEL', scorerModel);
expectAssignment(
  files.env,
  exampleEnvironment,
  'SCORER_FALLBACK_MODEL',
  scorerFallbackModel,
);
expectAssignment(files.env, exampleEnvironment, 'HIRING_AGENT_MODEL', hiringModel);
expectAssignment(
  files.env,
  exampleEnvironment,
  'HIRING_AGENT_FALLBACK_MODEL',
  hiringFallbackModel,
);

expectEqual(
  `${files.scorer} DEFAULT_SCORER_MODEL`,
  exactCapture(
    files.scorer,
    sources.scorer,
    /^const DEFAULT_SCORER_MODEL = '([^']+)';$/m,
    'DEFAULT_SCORER_MODEL assignment',
  ),
  scorerModel,
);
requirePattern(
  files.scorer,
  sources.scorer,
  /const primary = process\.env\.SCORER_MODEL \|\| DEFAULT_SCORER_MODEL;/m,
  'SCORER_MODEL default wiring',
);
requirePattern(
  files.scorer,
  sources.scorer,
  /const fallback = process\.env\.SCORER_FALLBACK_MODEL \|\| primary;/m,
  'SCORER_FALLBACK_MODEL default wiring',
);
expectEqual(
  `${files.legacyParser} legacy scorer default`,
  exactCapture(
    files.legacyParser,
    sources.legacyParser,
    /^const legacyModelName = process\.env\.SCORER_MODEL \|\| '([^']+)';$/m,
    'SCORER_MODEL-backed legacy default',
  ),
  scorerModel,
);

expectEqual(
  `${files.documentProcessor} DEFAULT_OCR_MODEL`,
  exactCapture(
    files.documentProcessor,
    sources.documentProcessor,
    /^DEFAULT_OCR_MODEL = "([^"]+)"$/m,
    'DEFAULT_OCR_MODEL assignment',
  ),
  ocrModel,
);
expectEqual(
  `${files.documentProcessor} DEFAULT_EMBEDDING_MODEL`,
  exactCapture(
    files.documentProcessor,
    sources.documentProcessor,
    /^DEFAULT_EMBEDDING_MODEL = "([^"]+)"$/m,
    'DEFAULT_EMBEDDING_MODEL assignment',
  ),
  embeddingModel,
);
requirePattern(
  files.documentProcessor,
  sources.documentProcessor,
  /OCR_MODEL_CANDIDATES\s*=\s*\[\s*DEFAULT_OCR_MODEL,\s*\]/m,
  'OCR candidates derived from DEFAULT_OCR_MODEL',
);
requirePattern(
  files.documentProcessor,
  sources.documentProcessor,
  /for m_name in OCR_MODEL_CANDIDATES:/m,
  'OCR call loop wired to OCR_MODEL_CANDIDATES',
);
requirePattern(
  files.documentProcessor,
  sources.documentProcessor,
  /^EMBEDDING_MODEL = DEFAULT_EMBEDDING_MODEL$/m,
  'fixed document embedding assignment',
);
requirePattern(
  files.documentProcessor,
  sources.documentProcessor,
  /models\.embed_content\(\s*model=EMBEDDING_MODEL,\s*contents=/m,
  'document embedding call wired to EMBEDDING_MODEL',
);

expectEqual(
  `${files.hiringConfig} DEFAULT_HIRING_AGENT_MODEL`,
  exactCapture(
    files.hiringConfig,
    sources.hiringConfig,
    /^DEFAULT_HIRING_AGENT_MODEL = "([^"]+)"$/m,
    'DEFAULT_HIRING_AGENT_MODEL assignment',
  ),
  hiringModel,
);
expectEqual(
  `${files.hiringConfig} DEFAULT_HIRING_AGENT_FALLBACK_MODEL`,
  exactCapture(
    files.hiringConfig,
    sources.hiringConfig,
    /^DEFAULT_HIRING_AGENT_FALLBACK_MODEL = "([^"]+)"$/m,
    'DEFAULT_HIRING_AGENT_FALLBACK_MODEL assignment',
  ),
  hiringFallbackModel,
);
requirePattern(
  files.hiringConfig,
  sources.hiringConfig,
  /environment\.get\("HIRING_AGENT_MODEL", DEFAULT_HIRING_AGENT_MODEL\)/m,
  'HIRING_AGENT_MODEL default wiring',
);
requirePattern(
  files.hiringConfig,
  sources.hiringConfig,
  /"HIRING_AGENT_FALLBACK_MODEL",\s*DEFAULT_HIRING_AGENT_FALLBACK_MODEL,/m,
  'HIRING_AGENT_FALLBACK_MODEL default wiring',
);
expectEqual(
  `${files.mcpServer} _EMBEDDING_MODEL`,
  exactCapture(
    files.mcpServer,
    sources.mcpServer,
    /^_EMBEDDING_MODEL = "([^"]+)"$/m,
    '_EMBEDDING_MODEL assignment',
  ),
  embeddingModel,
);
requirePattern(
  files.mcpServer,
  sources.mcpServer,
  /embed_content\(\s*model=_EMBEDDING_MODEL,\s*contents=/m,
  'MCP embedding call wired to its fixed private model constant',
);
forbidPattern(
  files.mcpServer,
  sources.mcpServer,
  /^EMBEDDING_MODEL\s*=/m,
  'environment-overridable MCP embedding model assignment',
);

expectEqual(
  `${files.documentProcessor} embedding task`,
  exactCapture(
    files.documentProcessor,
    sources.documentProcessor,
    /task_type="([A-Z_]+)"/m,
    'embedding task_type',
  ),
  documentTask,
);
expectEqual(
  `${files.documentProcessor} embedding dimensions`,
  Number(
    exactCapture(
      files.documentProcessor,
      sources.documentProcessor,
      /output_dimensionality=(\d+)/m,
      'embedding output_dimensionality',
    ),
  ),
  embeddingDimensions,
);
expectEqual(
  `${files.mcpServer} embedding task`,
  exactCapture(
    files.mcpServer,
    sources.mcpServer,
    /task_type="([A-Z_]+)"/m,
    'embedding task_type',
  ),
  queryTask,
);
expectEqual(
  `${files.mcpServer} embedding dimensions`,
  Number(
    exactCapture(
      files.mcpServer,
      sources.mcpServer,
      /output_dimensionality=(\d+)/m,
      'embedding output_dimensionality',
    ),
  ),
  embeddingDimensions,
);

const documentDeployment = parseAssignments(files.documentDeploy, sources.documentDeploy);
const hiringDeployment = parseAssignments(files.hiringDeploy, sources.hiringDeploy);
expectAssignment(files.hiringDeploy, hiringDeployment, 'HIRING_AGENT_MODEL', hiringModel);
expectAssignment(
  files.hiringDeploy,
  hiringDeployment,
  'HIRING_AGENT_FALLBACK_MODEL',
  hiringFallbackModel,
);
if (documentDeployment.has('OCR_MODEL') || documentDeployment.has('EMBEDDING_MODEL')) {
  fail(`${files.documentDeploy}: fixed processor models must not be overridden at deployment`);
}
if (hiringDeployment.has('EMBEDDING_MODEL')) {
  fail(`${files.hiringDeploy}: fixed embedding model must not be overridden at deployment`);
}

for (const [file, source] of [
  [files.schema, sources.schema],
  [files.embeddingMigration, sources.embeddingMigration],
]) {
  expectEqual(
    `${file} candidate embedding dimensions`,
    Number(
      exactCapture(
        file,
        source,
        /(?<!_)embedding vector\((\d+)\)/m,
        'candidate embedding vector declaration',
      ),
    ),
    embeddingDimensions,
  );
  expectEqual(
    `${file} query embedding dimensions`,
    Number(
      exactCapture(
        file,
        source,
        /query_embedding vector\((\d+)\)/m,
        'query embedding vector declaration',
      ),
    ),
    embeddingDimensions,
  );
}

const documentationExpectations = [
  ['docs/demo-guide.md', [ocrModel, hiringModel, hiringFallbackModel, contractPath]],
  [
    'docs/resume-technology-guide.md',
    [ocrModel, hiringModel, hiringFallbackModel, 'gemini-embedding-001', contractPath],
  ],
  [
    'docs/resume-claim-evidence.md',
    [ocrModel, hiringModel, hiringFallbackModel, embeddingModel, contractPath],
  ],
  ['docs/architecture.md', [contractPath]],
  ['services/document-processor/README.md', [contractPath]],
  ['services/hiring-agent/README.md', [contractPath]],
];
for (const [file, expectedValues] of documentationExpectations) {
  const source = readSource(file);
  for (const expected of expectedValues) {
    if (!source.includes(expected)) {
      fail(`${file}: missing current model-contract reference ${expected}`);
    }
  }
}

const retiredIdentifiers = [
  'text-embedding-004',
  'gemini-1.5-pro',
  'gemini-2.0-flash',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
];
const activeFiles = [
  'README.md',
  ...markdownFiles('docs'),
  files.scorer,
  files.legacyParser,
  files.documentProcessor,
  files.hiringConfig,
  files.mcpServer,
  files.schema,
];
for (const file of activeFiles) {
  const source = readSource(file);
  for (const retiredIdentifier of retiredIdentifiers) {
    if (source.includes(retiredIdentifier)) {
      fail(`${file}: retired active identifier ${retiredIdentifier}`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `Static model contract v${contract.schemaVersion} matches working-tree defaults, ` +
    'embedding compatibility, deployment configuration, schema, and named active docs.',
);
