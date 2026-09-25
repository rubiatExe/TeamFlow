'use client';

import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import {
  ArrowRight,
  FileText,
  LoaderCircle,
  MapPin,
  Quote,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

import { CandidateAvatar } from '@/components/candidates/candidate-avatar';
import { ScoreRing } from '@/components/candidates/score-ring';
import {
  DemoSemanticSearchErrorSchema,
  DemoSemanticSearchResponseSchema,
  type DemoSearchResult,
  type DemoSearchScope,
  type DemoSemanticSearchResponse,
} from '@/lib/contracts/demo-semantic-search';

const DEFAULT_QUERY = 'Weekend barista who knows latte art';
const EXAMPLE_QUERIES = [
  'Weekend barista',
  'Early-morning baker',
  'Shift supervisor with scheduling',
] as const;
const ROLE_EXAMPLES: Record<string, readonly string[]> = {
  barista: ['Weekend barista', 'Latte art and espresso', 'Customer service and POS'],
  baker: ['Early-morning baker', 'Sourdough and recipe scaling', 'Food safety and oven operations'],
  shift_lead: ['Shift supervisor with scheduling', 'Barista training and weekend openings', 'Inventory and team coaching'],
  cashier: ['Customer service and POS', 'Cash handling', 'Weekend availability'],
  line_cook: ['Grill and knife skills', 'Food prep and food safety', 'High-volume line cook'],
  prep_cook: ['Inventory and receiving', 'Food safety', 'Vendor coordination'],
};

type SearchViewState = {
  response: DemoSemanticSearchResponse | null;
  error: string | null;
  requestId: string | null;
  loading: boolean;
};

const INITIAL_STATE: SearchViewState = { response: null, error: null, requestId: null, loading: false };

function ResultCard({ result, debugMode }: { result: DemoSearchResult; debugMode: boolean }) {
  const [scoreOpen, setScoreOpen] = useState(false);
  const scorePopoverId = useId();

  return (
    <li>
      <article className="overflow-visible rounded-[var(--radius-lg)] border border-[var(--cocoa-100)] bg-white shadow-[var(--shadow-card)] transition-shadow hover:shadow-[var(--shadow-card-hover)]">
        <div className="grid md:grid-cols-[0.78fr_1.22fr]">
          <div className="relative p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <p className="cocoa-label">Search result {result.rank}</p>
              <div
                className="relative"
                onKeyDown={event => { if (event.key === 'Escape') setScoreOpen(false); }}
                onBlur={event => {
                  if (!event.currentTarget.contains(event.relatedTarget)) setScoreOpen(false);
                }}
              >
                <ScoreRing
                  score={result.query_match_score}
                  tone="query"
                  ariaLabel={`Query match: ${result.query_match_score} out of 100. Click to learn how it was scored.`}
                  expanded={scoreOpen}
                  controls={scorePopoverId}
                  onScoreClick={() => setScoreOpen(true)}
                  onScoreFocus={() => setScoreOpen(true)}
                />
                {scoreOpen ? (
                  <div id={scorePopoverId} role="tooltip" className="absolute right-0 top-[calc(100%+10px)] z-30 w-60 rounded-[var(--radius-md)] bg-[var(--cocoa-900)] p-3 text-xs leading-5 text-white shadow-[var(--shadow-modal)]">
                    <span aria-hidden="true" className="absolute -top-1.5 right-5 size-3 rotate-45 bg-[var(--cocoa-900)]" />
                    <strong className="block text-sm">Query match</strong>
                    This score is recomputed from the cited résumé evidence for each search. It measures relevance—not candidate quality or hireability.
                  </div>
                ) : null}
              </div>
            </div>

            <div className="mt-4 flex items-center gap-3">
              <CandidateAvatar name={result.display_name} />
              <div className="min-w-0">
                <h3 className="font-display text-xl font-semibold text-[var(--cocoa-900)]">{result.display_name}</h3>
                <p className="mt-0.5 text-sm font-semibold text-[var(--cocoa-700)]">{result.headline}</p>
              </div>
            </div>

            <dl className="mt-5 grid gap-2 text-sm text-[var(--cocoa-600)]">
              <div className="flex items-center gap-2"><MapPin className="size-4" aria-hidden="true" /><dt className="sr-only">Location</dt><dd>{result.location}</dd></div>
              <div className="flex items-center gap-2"><Sparkles className="size-4" aria-hidden="true" /><dt className="sr-only">Experience</dt><dd>{result.years_experience} {result.years_experience === 1 ? 'year' : 'years'} documented</dd></div>
            </dl>

            <p className="mt-5 text-xs font-semibold text-[var(--cocoa-700)]">Profile skills</p>
            <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Profile skills">
              {result.skills.map(skill => (
                <span key={skill} className="rounded-[var(--radius-sm)] bg-[var(--cocoa-100)] px-2.5 py-1 text-[11px] font-medium text-[var(--cocoa-700)]">{skill}</span>
              ))}
            </div>

            <div className="mt-5 rounded-[var(--radius-md)] bg-[var(--cocoa-50)] p-3">
              <p className="flex items-center gap-2 text-xs font-semibold text-[var(--cocoa-700)]"><ShieldCheck className="size-4" aria-hidden="true" /> Query match: {result.query_match_score}/100</p>
              <p className="mt-1 text-xs leading-5 text-[var(--cocoa-600)]">Evidence relevance only—never a fit score or hiring recommendation.</p>
              {debugMode ? <p className="mt-2 font-mono text-[10px] text-[var(--cocoa-500)]">similarity={result.weighted_evidence_similarity}</p> : null}
            </div>
          </div>

          <div className="border-t border-[var(--cocoa-100)] bg-[var(--cocoa-50)] p-5 sm:p-6 md:border-l md:border-t-0">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-white text-[var(--cocoa-700)] shadow-sm"><Quote className="size-4" aria-hidden="true" /></span>
              <div>
                <p className="font-display text-lg font-semibold text-[var(--cocoa-800)]">Why this result appeared</p>
                <p className="mt-0.5 text-xs text-[var(--cocoa-600)]">Quoted evidence selected for this search</p>
              </div>
            </div>
            <div className="mt-4 space-y-3">
              {result.citations.map(citation => (
                <figure key={citation.citation_id} id={citation.citation_id} className="rounded-[var(--radius-md)] border border-[var(--cocoa-100)] bg-white p-4">
                  <blockquote className="text-sm leading-6 text-[var(--cocoa-800)]">“{citation.exact_quote}”</blockquote>
                  <figcaption className="mt-3 flex items-center gap-1.5 border-t border-[var(--cocoa-100)] pt-3 text-xs text-[var(--cocoa-600)]">
                    <FileText className="size-3.5" aria-hidden="true" /> Résumé evidence · {citation.location}
                  </figcaption>
                </figure>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-2" aria-label="Evidence topics">
              {result.evidence_topics.map(topic => <span key={topic} className="rounded-full border border-[var(--cocoa-200)] bg-white px-2.5 py-1 text-xs font-medium text-[var(--cocoa-700)]">{topic}</span>)}
            </div>
          </div>
        </div>
      </article>
    </li>
  );
}

export function RecruiterSemanticSearch({ debugMode = false, roleId, candidateRefs }: DemoSearchScope & { debugMode?: boolean }) {
  const exampleQueries = (roleId && ROLE_EXAMPLES[roleId]) || EXAMPLE_QUERIES;
  const defaultQuery = !roleId || roleId === 'barista' ? DEFAULT_QUERY : exampleQueries[0];
  const [query, setQuery] = useState(defaultQuery);
  const [state, setState] = useState<SearchViewState>(INITIAL_STATE);
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);
  const requestControllerRef = useRef<AbortController | null>(null);

  const executeSearch = useCallback(async (nextQuery: string, focusResults: boolean) => {
    const normalizedQuery = nextQuery.trim().replace(/\s+/gu, ' ');
    if (normalizedQuery.length < 3) return;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setState({ response: null, loading: true, error: null, requestId: null });

    try {
      const response = await fetch('/api/demo/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: normalizedQuery, roleId, candidateRefs }),
        cache: 'no-store',
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) return;
      if (!response.ok) {
        const parsedError = DemoSemanticSearchErrorSchema.safeParse(payload);
        setState({
          response: null,
          loading: false,
          error: parsedError.success ? parsedError.data.error.message : 'Search returned an unexpected response.',
          requestId: parsedError.success ? parsedError.data.request_id : null,
        });
        return;
      }
      const parsed = DemoSemanticSearchResponseSchema.safeParse(payload);
      if (!parsed.success) {
        setState({ response: null, loading: false, error: 'Search results could not be verified.', requestId: null });
        return;
      }
      setState({ response: parsed.data, error: null, requestId: parsed.data.request_id, loading: false });
      if (focusResults) requestAnimationFrame(() => resultsHeadingRef.current?.focus());
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setState({ response: null, loading: false, error: 'The search service could not be reached. Please try again.', requestId: null });
    }
  }, [roleId, candidateRefs]);

  useEffect(() => () => requestControllerRef.current?.abort(), []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void executeSearch(query, true);
  };

  const chooseExample = (example: string) => {
    setQuery(example);
    void executeSearch(example, true);
  };

  return (
    <section aria-label="Semantic candidate search" className="min-w-0">
      <p className="mb-3 text-xs leading-5 text-[var(--cocoa-600)]">
        Demo · fictional profiles only. Search compares résumé wording; it does not recommend who to hire.
      </p>
      <div className="rounded-[var(--radius-lg)] border border-[var(--cocoa-100)] bg-white p-4 shadow-[var(--shadow-card)] sm:p-6">
        <form role="search" onSubmit={submit}>
          <label htmlFor="semantic-candidate-query" className="sr-only">Describe the candidate experience you need</label>
          <div className="relative flex min-h-14 items-center rounded-full border-[1.5px] border-[var(--cocoa-300)] bg-[var(--cream-50)] p-1.5 pl-4 transition focus-within:border-[var(--cocoa-600)] focus-within:shadow-[0_0_0_3px_var(--cocoa-100)]">
            <Search className="size-5 shrink-0 text-[var(--cocoa-600)]" aria-hidden="true" />
            <input
              id="semantic-candidate-query"
              value={query}
              onChange={event => setQuery(event.target.value)}
              aria-describedby="semantic-query-guidance"
              autoComplete="off"
              maxLength={280}
              placeholder="e.g. Weekend barista who knows latte art"
              className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-[var(--cocoa-900)] outline-none placeholder:text-[var(--cocoa-500)]"
            />
            <button
              type="submit"
              aria-label={state.loading ? 'Searching' : 'Search fictional profiles'}
              disabled={state.loading || query.trim().length < 3}
              className="flex min-h-11 shrink-0 items-center gap-2 rounded-full bg-[var(--cocoa-700)] px-4 text-sm font-semibold text-white transition hover:bg-[var(--cocoa-600)] disabled:cursor-not-allowed disabled:opacity-50 sm:px-5"
            >
              {state.loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Search className="size-4" aria-hidden="true" />}
              <span className="hidden sm:inline">{state.loading ? 'Searching…' : 'Search'}</span>
              {!state.loading ? <ArrowRight className="hidden size-4 sm:block" aria-hidden="true" /> : null}
            </button>
          </div>
          <p id="semantic-query-guidance" className="mt-3 text-xs leading-5 text-[var(--cocoa-600)]">Use job-related skills, schedule, and experience. Don’t paste personal contact details. When Google-powered matching is active, your search text is sent to Google.</p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-[var(--cocoa-600)]">Try:</span>
            {exampleQueries.map(example => (
              <button key={example} type="button" onClick={() => chooseExample(example)} disabled={state.loading} className="min-h-9 rounded-full bg-[var(--cocoa-100)] px-3 text-xs font-medium text-[var(--cocoa-700)] hover:bg-[var(--cocoa-200)] disabled:opacity-50">
                {example}
              </button>
            ))}
          </div>
        </form>
      </div>

      {state.loading ? (
        <div role="status" aria-live="polite" className="mt-6 flex min-h-48 flex-col items-center justify-center rounded-[var(--radius-lg)] border border-[var(--cocoa-100)] bg-white text-center">
          <LoaderCircle className="size-7 animate-spin text-[var(--cocoa-600)]" aria-hidden="true" />
          <p className="mt-3 font-display text-lg font-semibold text-[var(--cocoa-800)]">Finding the strongest evidence matches…</p>
          <p className="mt-1 text-xs text-[var(--cocoa-600)]">Each candidate is rescored for this exact query.</p>
        </div>
      ) : null}

      {state.error ? (
        <div role="alert" className="mt-6 rounded-[var(--radius-lg)] border border-red-200 bg-red-50 p-5 text-red-900">
          <p className="font-semibold">Search needs another try</p>
          <p className="mt-1 text-sm">{state.error}</p>
          <button type="button" onClick={() => void executeSearch(query, true)} className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-[var(--radius-md)] border border-red-300 bg-white px-4 text-sm font-semibold"><RotateCcw className="size-4" aria-hidden="true" /> Try again</button>
          {debugMode && state.requestId ? <p className="mt-2 font-mono text-[10px]">request {state.requestId}</p> : null}
        </div>
      ) : null}

      {state.response ? (
        <div className="mt-8">
          <div role="status" className="mb-5 rounded-[var(--radius-md)] border border-[var(--cocoa-200)] bg-white p-4 text-xs leading-5 text-[var(--cocoa-700)]">
            <p className="font-semibold">{state.response.retrieval.mode === 'live_embedding' ? 'Google-powered matching' : 'Built-in demo matching'} · Fictional profiles</p>
            <p className="mt-1">{state.response.warnings.find(warning => warning.startsWith('Google-powered matching')) ?? 'This request used Google-powered matching to search fictional résumé evidence.'}</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="cocoa-label">{state.response.result_count} results from {state.response.corpus_size} visible fictional profiles</p>
              <h2 ref={resultsHeadingRef} tabIndex={-1} className="mt-1 font-display text-2xl font-semibold text-[var(--cocoa-900)]">Results for “{state.response.query}”</h2>
            </div>
            <p className="max-w-sm text-xs leading-5 text-[var(--cocoa-600)]">Query match is rescored on the backend for this search. It is not a fit score or hiring recommendation.</p>
          </div>
          <ol className="mt-5 grid gap-5" aria-label="Smart Search results">
            {state.response.results.map(result => <ResultCard key={result.synthetic_candidate_ref} result={result} debugMode={debugMode} />)}
          </ol>
          {state.response.result_count === 0 ? (
            <p className="mt-5 rounded-[var(--radius-md)] bg-[var(--cocoa-50)] p-5 text-sm leading-6 text-[var(--cocoa-700)]">
              {state.response.corpus_size === 0
                ? 'No fictional profiles are visible in this role and filter selection. Adjust the board filters or choose another role.'
                : 'No supporting job-related wording was found in these fictional profiles. Try another skill or schedule, or change the board filters.'}
            </p>
          ) : null}
          {debugMode ? (
            <details className="mt-5 rounded-[var(--radius-md)] border border-[var(--cocoa-200)] bg-white p-4 text-xs text-[var(--cocoa-700)]">
              <summary className="cursor-pointer font-semibold">Debug search details</summary>
              <p className="mt-2">Mode: {state.response.retrieval.mode} · Model: {state.response.retrieval.model_id} · Request: {state.response.request_id}</p>
              <ul className="mt-2 list-disc pl-4">{state.response.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
