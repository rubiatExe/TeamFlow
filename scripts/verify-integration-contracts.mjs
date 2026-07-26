import { readFileSync } from 'node:fs';

const checks = [
  {
    file: '.github/workflows/deploy-python-service.yml',
    required: [
      'id-token: write',
      'secrets.WIF_PROVIDER',
      'secrets.WIF_SERVICE_ACCOUNT',
      'service: teamflow-python-service',
      'region: us-central1',
      'source: ./services/document-processor',
      'OTEL_PROPAGATORS=tracecontext,baggage',
      'OTEL_TRACES_SAMPLER=parentbased_traceidratio',
    ],
  },
  {
    file: 'app/api/parser/route.ts',
    required: [
      "process.env.OCR_SERVICE_URL",
      "process.env.OCR_SERVICE_TOKEN",
      "`${OCR_SERVICE_URL}/extract`",
      'createOcrFetchOptions',
      'withTraceSpan',
      'ParserOutputSchema.parse',
      'saveCandidateToSupabase({',
    ],
  },
  {
    file: 'instrumentation.ts',
    required: [
      "process.env.NEXT_RUNTIME !== 'nodejs'",
      "process.env.TEAMFLOW_OTEL_ENABLED !== 'true'",
      'registerOTel',
      "propagators: ['tracecontext', 'baggage']",
      "dontPropagateContextUrls: ['*']",
    ],
  },
  {
    file: '.env.example',
    required: [
      'TEAMFLOW_OTEL_ENABLED=false',
      'NEXT_OTEL_SERVICE_NAME=teamflow-next-api',
      'DOCUMENT_PROCESSOR_OTEL_SERVICE_NAME=teamflow-document-processor',
    ],
  },
  {
    file: 'lib/observability/ocr-fetch.ts',
    required: [
      'propagateContext: true',
      "spanName: 'ocr_agent.extract'",
      "'X-OCR-Token': token",
    ],
  },
  {
    file: 'services/document-processor/main.py',
    required: [
      'FastAPIInstrumentor.instrument_app(app)',
      'teamflow.pipeline.stage',
      'ocr_extraction',
      'embedding_generation',
    ],
    forbidden: [
      'span.set_attribute("file.name"',
    ],
  },
  {
    file: 'lib/ai/scorer.ts',
    required: [
      "responseMimeType: 'application/json'",
      'responseSchema: PARSER_OUTPUT_RESPONSE_SCHEMA',
      'runScorerWithFallback',
      'SCORER_MAX_ATTEMPTS',
      'createEmergencyFallback',
    ],
  },
  {
    file: 'lib/ai/scorer-response.ts',
    required: [
      "finishReason !== 'STOP'",
      'JSON.parse',
      'ParserOutputSchema.safeParse',
    ],
  },
  {
    file: 'lib/db/supabase.ts',
    required: [
      'process.env.NEXT_PUBLIC_SUPABASE_URL',
      'process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'process.env.SUPABASE_SERVICE_ROLE_KEY',
      "typeof window === 'undefined'",
    ],
  },
];

let failed = false;

for (const check of checks) {
  const source = readFileSync(check.file, 'utf8');

  for (const contract of check.required) {
    if (!source.includes(contract)) {
      failed = true;
      console.error(`Missing integration contract in ${check.file}: ${contract}`);
    }
  }

  for (const forbidden of check.forbidden ?? []) {
    if (source.includes(forbidden)) {
      failed = true;
      console.error(
        `Forbidden integration pattern in ${check.file}: ${forbidden}`,
      );
    }
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log(
    'WIF, Cloud Run, OCR, Supabase, parser reliability, and trace propagation contracts are intact.',
  );
}
