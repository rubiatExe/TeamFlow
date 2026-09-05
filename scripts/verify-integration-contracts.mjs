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
      'image: ${{ steps.artifact.outputs.image_ref }}',
      'no_traffic: true',
      'DOCUMENT_PROCESSOR_OTEL_SERVICE_NAME=teamflow-document-processor',
      'OTEL_SERVICE_NAME=teamflow-document-processor',
      'OTEL_PROPAGATORS=tracecontext',
      'OTEL_TRACES_SAMPLER=parentbased_traceidratio',
      'OCR_TIMEOUT_SECONDS=25',
      'EMBEDDING_TIMEOUT_SECONDS=10',
      'OCR_SERVICE_TOKEN=OCR_SERVICE_TOKEN:${{ env.OCR_SERVICE_TOKEN_SECRET_VERSION }}',
      'Run candidate authenticated extraction canary',
      '$CANDIDATE_URL/extract',
      '--cpu=1 --memory=1Gi --min-instances=0 --max-instances=10',
      '--port=8080 --timeout=60 --concurrency=2',
      '--startup-probe=httpGet.path=/ready,httpGet.port=8080',
      '--liveness-probe=httpGet.path=/health,httpGet.port=8080',
      'Verify provenance and generate SBOM',
      'node scripts/verify-model-contract.mjs',
    ],
    forbidden: ['source: ./services/document-processor', ':latest'],
  },
  {
    file: 'services/document-processor/main.py',
    required: [
      'retry_options=HttpRetryOptions(attempts=1)',
      'embedding_model_id=EMBEDDING_MODEL',
      'UploadBoundaryMiddleware',
    ],
  },
  {
    file: '.github/workflows/deploy-hiring-agent.yml',
    required: [
      'id-token: write',
      'secrets.WIF_PROVIDER',
      'secrets.WIF_SERVICE_ACCOUNT',
      'service: teamflow-hiring-agent',
      'image: ${{ steps.artifact.outputs.image_ref }}',
      'no_traffic: true',
      'GOOGLE_API_KEY=GOOGLE_API_KEY:${{ env.GOOGLE_API_KEY_SECRET_VERSION }}',
      'SUPABASE_URL=SUPABASE_URL:${{ env.SUPABASE_URL_SECRET_VERSION }}',
      'SUPABASE_TRUSTED_ORIGIN=SUPABASE_TRUSTED_ORIGIN:${{ env.SUPABASE_TRUSTED_ORIGIN_SECRET_VERSION }}',
      'SUPABASE_PUBLISHABLE_KEY=SUPABASE_PUBLISHABLE_KEY:${{ env.SUPABASE_PUBLISHABLE_KEY_SECRET_VERSION }}',
      'SUPABASE_HIRING_READER_TOKEN=SUPABASE_HIRING_READER_TOKEN:${{ env.SUPABASE_HIRING_READER_TOKEN_SECRET_VERSION }}',
      'HIRING_AGENT_TOKEN=HIRING_AGENT_TOKEN:${{ env.HIRING_AGENT_TOKEN_SECRET_VERSION }}',
      'Run candidate authenticated hiring canary',
      '$CANDIDATE_URL/invoke',
      'HIRING_AGENT_CANARY_MERCHANT_ID',
      'OTEL_SERVICE_NAME=teamflow-hiring-agent',
      'OTEL_PROPAGATORS=tracecontext',
      '--cpu=1 --memory=1Gi --min-instances=0 --max-instances=10',
      '--port=8080 --timeout=60 --concurrency=4',
      '--startup-probe=httpGet.path=/ready,httpGet.port=8080',
      '--liveness-probe=httpGet.path=/health,httpGet.port=8080',
      'Verify provenance and generate SBOM',
      'HIRING_AGENT_FALLBACK_MODEL=gemini-3.6-flash',
      'HIRING_AGENT_MAX_REQUEST_BYTES=65536',
      'TEAMFLOW_HITL_MAX_DECISION_REQUEST_BYTES=524288',
      'AGENT_ALLOW_WRITES=false',
      'node scripts/verify-model-contract.mjs',
    ],
    forbidden: [
      'source: ./services/hiring-agent',
      ':latest',
      'SUPABASE_SERVICE_KEY',
      'SUPABASE_REVIEW_WRITER_TOKEN',
    ],
  },
  {
    file: 'app/api/parser/route.ts',
    required: [
      "process.env.OCR_SERVICE_URL",
      "process.env.OCR_SERVICE_TOKEN",
      'requestDocumentExtraction',
      'DocumentProcessorError',
      'withTraceSpan',
      'ParserOutputSchema.parse',
      'saveCandidateToSupabase({',
      'saveResumeDocumentExtraction',
      "'Cache-Control': 'no-store'",
    ],
  },
  {
    file: 'instrumentation.ts',
    required: [
      "process.env.NEXT_RUNTIME !== 'nodejs'",
      "process.env.TEAMFLOW_OTEL_ENABLED !== 'true'",
      'registerOTel',
      "TEAMFLOW_OTEL_PROPAGATORS = ['tracecontext'] as const",
      "dontPropagateContextUrls: ['*']",
    ],
    forbidden: ["'baggage'"],
  },
  {
    file: '.env.example',
    required: [
      'TEAMFLOW_OTEL_ENABLED=false',
      'NEXT_OTEL_SERVICE_NAME=teamflow-next-api',
      'DOCUMENT_PROCESSOR_OTEL_SERVICE_NAME=teamflow-document-processor',
      'OCR_TIMEOUT_SECONDS=25',
      'EMBEDDING_TIMEOUT_SECONDS=10',
      'HIRING_AGENT_URL=http://localhost:8080',
      'HIRING_AGENT_TOKEN=',
      'HIRING_AGENT_ENABLED=false',
      'HIRING_AGENT_ROUTE_TOKEN=',
      'HIRING_AGENT_MAX_TOOL_ROUNDS=2',
      'HIRING_AGENT_TIMEOUT_SECONDS=45',
      'HIRING_AGENT_MAX_CONCURRENCY=4',
      'HIRING_AGENT_MAX_REQUEST_BYTES=65536',
      'TEAMFLOW_HITL_MAX_DECISION_REQUEST_BYTES=524288',
      'HIRING_AGENT_MOCK_TOOLS=false',
      'TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES=false',
      'RESUME_REVIEW_STORE_DOCUMENTS=false',
      'RESUME_REVIEW_PERSIST_RESULTS=false',
    ],
  },
  {
    file: 'app/api/parser/agent/route.ts',
    required: [
      'DEMO_MERCHANT_ID',
      'handleHiringAgentRequest',
      'return handleHiringAgentRequest(req, { merchantId: DEMO_MERCHANT_ID })',
    ],
  },
  {
    file: 'lib/http/bounded-json.ts',
    required: [
      'export function createDeadlineSignal(',
      'timer = setTimeout(() => controller.abort(), deadlineMs);',
      'clearTimeout(timer);',
      "parentSignal?.addEventListener('abort', abortFromParent, { once: true })",
      "parentSignal?.removeEventListener('abort', abortFromParent)",
    ],
    forbidden: ['AbortSignal.timeout('],
  },
  {
    file: 'lib/http/hiring-agent-route.ts',
    required: [
      'authorizeHiringAgentRoute',
      'createDeadlineSignal',
      'deadline.dispose();',
      'readBoundedJson',
      'HiringAgentRequestSchema.safeParse',
      'HiringAgentServiceRequestSchema.safeParse',
      'runLangGraphHiringAgent',
      'HiringAgentResponseSchema.safeParse',
      "request.headers.get('content-type') === 'application/json'",
      "'Cache-Control': 'no-store'",
    ],
  },
  {
    file: 'services/hiring-agent/teamflow_hiring_agent/graph/builder.py',
    required: [
      'StateGraph',
      'load_required_context',
      'execute_search_tools',
      'build_context_failure',
      'route_after_context',
      'error_handler=nodes["handle_model_failure"]',
      'timeout=model_timeout_seconds',
    ],
    forbidden: ['perform_explicit_write'],
  },
  {
    file: 'services/hiring-agent/requirements.txt',
    required: [
      'langgraph==',
      'langchain-google-genai==',
      'langchain-mcp-adapters==',
      'opentelemetry-exporter-gcp-trace==',
      'opentelemetry-instrumentation-fastapi==',
    ],
    forbidden: ['google-adk'],
  },
  {
    file: 'services/hiring-agent/teamflow_hiring_agent/http_api.py',
    required: [
      'class HiringHTTPBoundary',
      '_header_values(scope, b"x-agent-token")',
      'len(presented_tokens) == 1',
      'content_types[0] != b"application/json"',
      'if content_lengths and transfer_encodings:',
      '_MAX_BODY_FRAMES',
      'asyncio.timeout(float(self._settings.body_timeout_seconds))',
      'create_hiring_app',
      '@app.post("/invoke"',
    ],
    forbidden: ['setup_telemetry()', 'app = create_hiring_app()'],
  },
  {
    file: 'services/hiring-agent/main.py',
    required: [
      'MappingProxyType(snapshot)',
      'telemetry_initializer(snapshot)',
      'components = composition_factory(snapshot)',
      'http_settings_factory(snapshot)',
      'if __name__ == "__main__":',
    ],
    forbidden: ['app = build_app()', 'app = create_hiring_app()'],
  },
  {
    file: 'lib/http/resume-review-hitl-proxy.ts',
    required: [
      'const MAX_DECISION_REQUEST_BYTES = 524_288;',
      'const MAX_BODY_READ_MILLISECONDS = 5_000;',
      'const deadline = createDeadlineSignal(deadlineMs, request.signal);',
      'readBoundedJson(request, maxBytes, { signal: deadline.signal })',
      'deadline.dispose();',
      'error instanceof RequestBodyDeadlineError',
      'handleListPendingResumeReviews',
    ],
    forbidden: ['AbortSignal.timeout(deadlineMs)'],
  },
  {
    file: 'lib/ai/hiring-agent-client.ts',
    required: [
      'const deadline = createDeadlineSignal(timeoutMs);',
      'signal: deadline.signal',
      'deadline.dispose();',
    ],
    forbidden: ['AbortSignal.timeout('],
  },
  {
    file: 'lib/ai/resume-review-client.ts',
    required: [
      'const deadline = createDeadlineSignal(50_000);',
      'signal: deadline.signal',
      'deadline.dispose();',
      'error instanceof RequestBodyDeadlineError',
    ],
    forbidden: ['AbortSignal.timeout('],
  },
  {
    file: 'lib/ai/resume-review-hitl-client.ts',
    required: [
      'const MAX_SERVICE_RESPONSE_BYTES = 2_097_152;',
      'PendingResumeReviewQueueResponseSchema.safeParse',
      'ResumeReviewRunDetailResponseSchema',
    ],
  },
  {
    file: 'services/hiring-agent/teamflow_hiring_agent/runtime.py',
    required: [
      'HiringOperation.SEARCH_CANDIDATES',
      'GraphDependencyProvider',
      'async with self._dependency_provider.open(',
      'graph.ainvoke(',
      'asyncio.timeout(self._settings.workflow_timeout_seconds)',
    ],
  },
  {
    file: 'services/hiring-agent/teamflow_hiring_agent/providers.py',
    required: [
      '_SAFETY_SETTINGS',
      'retries=0',
      'FailoverRunnable',
      'GeminiGraphDependencyProvider',
      'primary.bind_tools(reasoning_tools)',
    ],
  },
  {
    file: 'services/hiring-agent/teamflow_hiring_agent/mcp/server.py',
    required: [
      'merchant_id=eq.',
      'Candidate score mutations and',
      'other writes are unavailable through this MCP boundary.',
      'mcp.run(transport="stdio"',
    ],
    forbidden: [
      'async def update_fit_score',
      'supabase_patch',
      'client.patch(',
    ],
  },
  {
    file: 'services/hiring-agent/teamflow_hiring_agent/graph/nodes.py',
    required: [
      'legacy_score_write_disabled',
      'Legacy automated score writes are disabled.',
      'async def build_context_failure',
    ],
    forbidden: [
      'WRITE_TOOL = "update_fit_score"',
      'async def perform_explicit_write',
    ],
  },
  {
    file: 'lib/http/legacy-demo-route.ts',
    required: [
      "environment.NODE_ENV === 'development' || environment.NODE_ENV === 'test'",
      "environment[LEGACY_DEMO_ROUTES_FLAG] === 'true'",
      "status: 404",
      "'Cache-Control': 'no-store'",
    ],
  },
  {
    file: 'lib/ai/hiring-agent-client.ts',
    required: [
      'runLangGraphHiringAgent',
      '/invoke',
      'JSON.stringify(body)',
    ],
    forbidden: ['AdkEvent', 'appName', 'sessionId'],
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
    file: 'lib/ai/document-processor-client.ts',
    required: [
      'DocumentExtractionResultSchema.safeParse',
      'deriveDocumentScoreability',
      'createOcrFetchOptions',
      'document_not_scoreable',
      'document_processor_timeout',
    ],
  },
  {
    file: 'services/document-processor/main.py',
    required: [
      'FastAPIInstrumentor.instrument_app(',
      'excluded_urls="health,ready"',
      'http_capture_headers_server_request=[]',
      'http_capture_headers_server_response=[]',
      'http_capture_headers_sanitize_fields=[',
      '"authorization"',
      '"x-agent-token"',
      '"x-ocr-token"',
      'teamflow.pipeline.stage',
      'ocr_extraction',
      'embedding_generation',
      'DocumentExtractionResult',
      'DocumentExtractionService',
      '_read_upload_limited',
    ],
    forbidden: [
      'span.set_attribute("file.name"',
      'MOCK_RESUME_MARKDOWN',
      'Alice Barista',
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
  {
    file: 'services/hiring-agent/teamflow_hiring_agent/resume_review/graph/builder.py',
    required: [
      'StateGraph(ResumeReviewState)',
      '"load_document"',
      '"extract_document"',
      '"validate_extraction"',
      '"load_active_roles"',
      '"agent1_evaluate"',
      '"validate_evidence"',
      '"calculate_scores"',
      '"assess_confidence"',
      '"agent2_generate_questions"',
      '"validate_questions"',
      '"guarded_persistence"',
    ],
  },
  {
    file: 'services/hiring-agent/teamflow_hiring_agent/resume_review/graph/nodes.py',
    required: [
      'asyncio.timeout(model_timeout_seconds)',
      'document_instruction_detected',
      'MAX_ACTIVE_ROLES = 5',
      'MAX_TOTAL_CRITERIA = 30',
      'candidate_id=request.candidate_id',
      'derive_confidence_signals',
      'confidence_threshold_applied',
    ],
  },
  {
    file: 'services/hiring-agent/teamflow_hiring_agent/resume_review/confidence.py',
    required: [
      'class ConfidencePolicy',
      'mode: Literal["shadow"]',
      'status: Literal["uncalibrated"]',
      'is_probability: Literal[False]',
      'threshold_applied: Literal[False]',
      'confidence_policy_sha256',
      'validate_confidence_assessment',
      'conflicting_evidence',
    ],
  },
  {
    file: 'services/hiring-agent/teamflow_hiring_agent/resume_review/confidence_policy_v1.json',
    required: [
      '"mode":"shadow"',
      '"policy_id":"resume-review-confidence"',
      '"policy_version":"1.0.0"',
      '"status":"uncalibrated"',
      '"component_id":"criteria_coverage","weight":100',
      '"component_id":"workflow_completion_gate","weight":0',
    ],
    forbidden: ['"threshold"', '"auto_accept"', '"auto_reject"'],
  },
  {
    file: 'services/hiring-agent/teamflow_hiring_agent/evaluation/risk_coverage.py',
    required: [
      'class ShadowConfidenceRunManifest',
      'class AutomaticAcceptanceLabelSetManifest',
      'safe_for_agent1_automatic_acceptance',
      'load_verified_validation_population',
      'assess_confidence(observation.signals, confidence_policy)',
      'label.agent1_result_fingerprint != observation.agent1_result_fingerprint',
      'point_kind="accept_none"',
      'unsafe_accept_rate_over_population',
      'threshold_selected: Literal[False]',
      'if not item.assessment.hard_failure',
      'while index < len(eligible) and eligible[index].assessment.score == cutoff',
    ],
    forbidden: ['recommended_threshold', 'selected_threshold'],
  },
  {
    file: 'services/hiring-agent/teamflow_hiring_agent/resume_review/runtime.py',
    required: [
      'Agent1ModelOutput',
      'Agent2QuestionPlan',
      'select_resume_review_tools',
      'async with self._tool_source.tools()',
      'FailoverRunnable',
      '"retries": 0',
      'primary.n = None',
      'fallback.n = None',
    ],
    forbidden: ['bind_tools(', 'temperature=', 'seed='],
  },
  {
    file: 'services/hiring-agent/teamflow_hiring_agent/mcp/server.py',
    required: [
      'get_resume_document',
      'load_active_role_policies',
      'merchant_id=eq.',
      'candidate_resume_documents',
      'is_active=eq.true',
      'limit={limit + 1}',
      'mcp.run(transport="stdio"',
    ],
    forbidden: ['update_fit_score'],
  },
  {
    file: 'app/api/parser/review/route.ts',
    required: [
      'ResumeReviewPublicRequestSchema.safeParse',
      'authorizeHiringAgentRoute',
      'createDeadlineSignal',
      'deadline.dispose();',
      'DEMO_MERCHANT_ID',
      'runResumeReview',
      'RESUME_REVIEW_PERSIST_RESULTS',
      'readBoundedJson',
      "'Cache-Control': 'no-store'",
    ],
  },
  {
    file: 'app/api/parser/route.ts',
    required: [
      'readBoundedJson',
      'RESUME_REVIEW_STORE_DOCUMENTS',
      'saveResumeDocumentExtraction',
      'linkResumeDocumentToCandidate',
    ],
  },
  {
    file: 'supabase/schema.sql',
    required: [
      'create table public.resume_documents (',
      'create table public.candidate_resume_documents (',
      'create table public.resume_review_runs (',
      'scoring_policy_version text',
      'primary key (merchant_id, document_id)',
      'unique (merchant_id, request_id)',
      'extraction_snapshot_sha256',
      'resume_review_runs_reject_mutation',
    ],
  },
  {
    file: 'supabase/seed.sql',
    required: [
      'barista-score-policy',
      'retail-score-policy',
      'scoring_policy_version',
      'scoring_criteria',
    ],
  },
  {
    file: 'supabase/schema.sql',
    required: [
      'revoke all on table public.merchants, public.jobs, public.candidates,',
      'from public, anon, authenticated, service_role, authenticator,',
      'grant select on table public.merchants, public.jobs to service_role;',
      'revoke all on function public.match_candidates(',
    ],
    forbidden: ['USING (true)', 'WITH CHECK (true)'],
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
    'Static WIF, Cloud Run, LangGraph, MCP, OCR, Supabase, parser reliability, and trace-propagation source contracts passed.',
  );
}
