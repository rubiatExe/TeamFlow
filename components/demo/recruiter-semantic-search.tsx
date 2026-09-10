'use client';

import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  FileText,
  LoaderCircle,
  MapPin,
  Quote,
  Search,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DemoSemanticSearchErrorSchema,
  DemoSemanticSearchResponseSchema,
  type DemoSemanticSearchResponse,
  type DemoSearchResult,
} from '@/lib/contracts/demo-semantic-search';

const DEFAULT_QUERY = 'Barista who can train new team members and open on weekends';
const EXAMPLE_QUERIES = [
  DEFAULT_QUERY,
  'Early-morning baker experienced in sourdough and recipe scaling',
  'Shift leader with scheduling, inventory, and high-volume service',
] as const;

type SearchViewState = {
  response: DemoSemanticSearchResponse | null;
  error: string | null;
  requestId: string | null;
  loading: boolean;
};

const INITIAL_STATE: SearchViewState = {
  response: null,
  error: null,
  requestId: null,
  loading: false,
};

function ResultCard({ result }: { result: DemoSearchResult }) {
  return (
    <li className="h-full">
      <article className="flex h-full flex-col overflow-hidden rounded-[1.5rem] border border-stone-200 bg-white shadow-[0_16px_50px_rgba(28,25,23,0.07)]">
        <div className="border-b border-stone-100 p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#173f32] text-sm font-semibold text-white">
                <span className="sr-only">Rank </span>
                {result.rank}
              </span>
              <div className="min-w-0">
                <h3 className="text-lg font-semibold text-stone-900 sm:text-xl">
                  {result.display_name}
                </h3>
                <p className="mt-1 text-sm font-medium text-stone-600">{result.headline}</p>
              </div>
            </div>
            <div className="shrink-0 text-right">
              <p className="font-mono text-lg font-semibold tabular-nums text-[#173f32]">
                {result.weighted_evidence_similarity.toFixed(3)}
              </p>
              <p className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-stone-500">
                weighted evidence similarity
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-sm text-stone-600">
            <span className="inline-flex items-center gap-1.5">
              <MapPin className="size-4" aria-hidden="true" />
              {result.location}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Clock3 className="size-4" aria-hidden="true" />
              {result.years_experience} {result.years_experience === 1 ? 'year' : 'years'} documented experience
            </span>
          </div>

          <div className="mt-4 flex flex-wrap gap-2" aria-label="Profile skills">
            {result.skills.map(skill => (
              <Badge
                key={skill}
                variant="secondary"
                className="border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs font-medium text-stone-700"
              >
                {skill}
              </Badge>
            ))}
          </div>
        </div>

        <div className="flex-1 bg-[#fbfaf7] p-5 sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-stone-900">
              <Quote className="size-4 text-emerald-700" aria-hidden="true" />
              Retrieved evidence
            </div>
            <span className="text-xs text-stone-500">Literal source blocks</span>
          </div>

          <div className="space-y-3">
            {result.citations.map(citation => (
              <figure
                key={citation.citation_id}
                id={citation.citation_id}
                className="rounded-xl border border-stone-200 bg-white p-4"
              >
                <blockquote className="text-sm leading-6 text-stone-700">
                  “{citation.exact_quote}”
                </blockquote>
                <figcaption className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-stone-100 pt-3 text-xs text-stone-500">
                  <span className="inline-flex items-center gap-1.5 font-medium text-stone-700">
                    <FileText className="size-3.5" aria-hidden="true" />
                    [{citation.citation_id}] {citation.document_label} · {citation.location}
                  </span>
                  <span className="font-mono tabular-nums">block similarity {citation.similarity.toFixed(3)}</span>
                </figcaption>
              </figure>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap gap-2" aria-label="Topics found in retrieved evidence">
            {result.evidence_topics.map(topic => (
              <span key={topic} className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800">
                {topic}
              </span>
            ))}
          </div>
        </div>
      </article>
    </li>
  );
}

export function RecruiterSemanticSearch() {
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [state, setState] = useState<SearchViewState>(INITIAL_STATE);
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);
  const requestControllerRef = useRef<AbortController | null>(null);

  const executeSearch = useCallback(async (nextQuery: string, focusResults: boolean) => {
    const normalizedQuery = nextQuery.trim().replace(/\s+/gu, ' ');
    if (!normalizedQuery) return;

    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setState({ response: null, loading: true, error: null, requestId: null });

    try {
      const response = await fetch('/api/demo/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: normalizedQuery }),
        cache: 'no-store',
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const parsedError = DemoSemanticSearchErrorSchema.safeParse(payload);
        setState(previous => ({
          ...previous,
          loading: false,
          error: parsedError.success
            ? parsedError.data.error.message
            : 'The search service returned an unexpected response.',
          requestId: parsedError.success ? parsedError.data.request_id : null,
        }));
        return;
      }

      const parsed = DemoSemanticSearchResponseSchema.safeParse(payload);
      if (!parsed.success) {
        setState(previous => ({
          ...previous,
          loading: false,
          error: 'The search response did not pass client-side validation.',
        }));
        return;
      }
      setState({ response: parsed.data, error: null, requestId: parsed.data.request_id, loading: false });
      if (focusResults) {
        requestAnimationFrame(() => resultsHeadingRef.current?.focus());
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setState(previous => ({
        ...previous,
        loading: false,
        error: 'The search service could not be reached. Please try again.',
      }));
    }
  }, []);

  useEffect(() => {
    return () => requestControllerRef.current?.abort();
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void executeSearch(query, true);
  };

  const chooseExample = (example: string) => {
    setQuery(example);
    void executeSearch(example, true);
  };

  const isLiveEmbedding = state.response?.retrieval.mode === 'live_embedding';

  return (
    <section id="search-demo" aria-labelledby="search-demo-title" className="scroll-mt-24">
      <div className="rounded-[1.75rem] border border-white/10 bg-[#10271f] p-5 shadow-[0_30px_90px_rgba(12,27,22,0.25)] sm:p-7 lg:p-9">
        <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
          <div>
            <Badge className="border border-emerald-300/20 bg-emerald-300/10 px-3 py-1 text-emerald-100">
              <Sparkles className="size-3.5" aria-hidden="true" />
              Interactive recruiter demo
            </Badge>
            <h2 id="search-demo-title" className="mt-5 max-w-xl text-3xl font-semibold tracking-[-0.04em] !text-white sm:text-4xl">
              Search résumé evidence in natural language.
            </h2>
            <p className="mt-4 max-w-lg text-base leading-7 text-emerald-50/70">
              Describe the job-relevant experience you need. TeamFlow embeds the query, ranks an isolated synthetic corpus, and returns the exact résumé blocks behind each result.
            </p>
          </div>

          <form role="search" onSubmit={handleSubmit} className="rounded-2xl bg-white p-4 shadow-2xl sm:p-5">
            <label htmlFor="semantic-candidate-query" className="text-sm font-semibold text-stone-900">
              What kind of candidate are you looking for?
            </label>
            <p id="semantic-query-guidance" className="mt-1 text-xs leading-5 text-stone-500">
              Use job criteria only—never applicant data. If live mode is enabled, query text is sent to Google for embedding.
            </p>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2 text-stone-400" aria-hidden="true" />
                <input
                  id="semantic-candidate-query"
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  aria-describedby="semantic-query-guidance"
                  autoComplete="off"
                  maxLength={280}
                  className="min-h-12 w-full rounded-xl border border-stone-300 bg-stone-50 py-3 pl-11 pr-4 text-sm text-stone-900 outline-none transition focus:border-emerald-700 focus:bg-white focus:ring-4 focus:ring-emerald-100"
                />
              </div>
              <Button
                type="submit"
                disabled={state.loading || query.trim().length < 3}
                className="min-h-12 rounded-xl bg-[#196447] px-5 font-semibold text-white hover:bg-[#104d36]"
              >
                {state.loading ? (
                  <>
                    <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                    Searching
                  </>
                ) : (
                  <>
                    Search profiles
                    <ArrowRight className="size-4" aria-hidden="true" />
                  </>
                )}
              </Button>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-stone-500">Try an example:</span>
              {EXAMPLE_QUERIES.map((example, index) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => chooseExample(example)}
                  disabled={state.loading}
                  aria-label={`Use example query: ${example}`}
                  className="min-h-11 rounded-full border border-stone-200 bg-white px-3 text-left text-xs font-medium text-stone-700 transition hover:border-emerald-300 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 disabled:opacity-50"
                >
                  {index === 0 ? 'Trainer + weekends' : index === 1 ? 'Early baker' : 'Shift leader'}
                </button>
              ))}
            </div>
          </form>
        </div>
      </div>

      <div className="mt-6 min-h-8" aria-live="polite" aria-atomic="true">
        {state.loading && (
          <p role="status" className="inline-flex items-center gap-2 text-sm font-medium text-stone-600">
            <LoaderCircle className="size-4 animate-spin text-emerald-700" aria-hidden="true" />
            Embedding the query and retrieving source evidence…
          </p>
        )}
        {state.error && (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <p className="font-semibold">Search not completed</p>
            <p className="mt-1">{state.error}</p>
            {state.requestId && <p className="mt-2 font-mono text-xs">Request {state.requestId}</p>}
          </div>
        )}
      </div>

      {!state.response && !state.loading && !state.error && (
        <div className="mt-3 grid gap-3 rounded-2xl border border-dashed border-stone-300 bg-white/60 p-5 text-sm text-stone-600 sm:grid-cols-3" role="note">
          <p><strong className="block text-stone-900">8 fictional profiles</strong> Isolated from every private candidate record.</p>
          <p><strong className="block text-stone-900">24 evidence blocks</strong> Available as literal, visible citations.</p>
          <p><strong className="block text-stone-900">One click to verify</strong> Run the prepared query or choose another example.</p>
        </div>
      )}

      {state.response && (
        <div className="mt-3">
          <div className="flex flex-col gap-4 rounded-2xl border border-stone-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
            <div>
              <h2
                ref={resultsHeadingRef}
                tabIndex={-1}
                className="text-xl font-semibold text-stone-900 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 sm:text-2xl"
              >
                {state.response.result_count} profiles ranked by semantic relevance
              </h2>
              <p className="mt-1 text-sm text-stone-500">
                Query: “{state.response.query}”
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge className={isLiveEmbedding
                ? 'border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-emerald-800'
                : 'border border-amber-200 bg-amber-50 px-3 py-1.5 text-amber-900'}
              >
                {isLiveEmbedding ? <CheckCircle2 className="size-3.5" aria-hidden="true" /> : <ShieldCheck className="size-3.5" aria-hidden="true" />}
                {isLiveEmbedding ? 'Live Gemini embeddings' : 'Deterministic fallback'}
              </Badge>
              <span
                aria-label={`${state.response.retrieval.dimensions} dimensions; ${state.response.latency_ms} milliseconds response latency`}
                className="rounded-full bg-stone-100 px-3 py-1.5 font-mono text-stone-600"
              >
                {state.response.retrieval.dimensions}d · {state.response.latency_ms}ms
              </span>
              <span
                aria-label={`Request ID ${state.response.request_id}`}
                className="rounded-full bg-stone-100 px-3 py-1.5 font-mono text-stone-600"
              >
                {state.response.request_id.slice(0, 8)}
              </span>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm leading-6 text-sky-950" role="note">
            Similarity is a retrieval signal—not a fit score, confidence estimate, or hiring recommendation. No cutoff is applied; a manager must interpret the cited evidence.
          </div>

          <ul className="mt-3 grid gap-2 text-xs leading-5 text-stone-600 sm:grid-cols-3" aria-label="Search response safeguards">
            {state.response.warnings.map(warning => (
              <li key={warning} className="rounded-lg border border-stone-200 bg-white px-3 py-2">
                {warning}
              </li>
            ))}
          </ul>

          <ol className="mt-5 grid gap-5 lg:grid-cols-2" aria-label="Semantically ranked synthetic candidate profiles">
            {state.response.results.map(result => (
              <ResultCard key={result.synthetic_candidate_ref} result={result} />
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
