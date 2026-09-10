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
  ChevronDown,
  Clock3,
  FileText,
  LoaderCircle,
  MapPin,
  Quote,
  RotateCcw,
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
    <li>
      <article className="overflow-hidden rounded-2xl border border-[#ded4c8] bg-white shadow-[0_8px_28px_rgba(76,46,32,0.06)]">
        <div className="grid md:grid-cols-[0.78fr_1.22fr]">
          <div className="p-5 sm:p-6">
            <p className="text-xs font-bold uppercase tracking-[0.13em] text-[#9a422b]">
              Search result {result.rank}
            </p>
            <h3 className="mt-2 text-xl font-bold text-[#3d241c] sm:text-2xl">
              {result.display_name}
            </h3>
            <p className="mt-1 text-sm font-semibold leading-6 text-stone-600">
              {result.headline}
            </p>

            <div className="mt-4 grid gap-2 text-sm text-stone-600">
              <span className="inline-flex items-center gap-2">
                <MapPin className="size-4 shrink-0 text-stone-400" aria-hidden="true" />
                {result.location}
              </span>
              <span className="inline-flex items-center gap-2">
                <Clock3 className="size-4 shrink-0 text-stone-400" aria-hidden="true" />
                {result.years_experience} {result.years_experience === 1 ? 'year' : 'years'} of documented experience
              </span>
            </div>

            <p className="mt-5 text-xs font-bold uppercase tracking-[0.12em] text-stone-500">Profile skills</p>
            <div className="mt-2 flex flex-wrap gap-2" aria-label="Profile skills">
              {result.skills.map(skill => (
                <Badge
                  key={skill}
                  variant="secondary"
                  className="border border-[#e4d8cb] bg-[#faf6ef] px-2.5 py-1 text-xs font-medium text-stone-700"
                >
                  {skill}
                </Badge>
              ))}
            </div>
          </div>

          <div className="border-t border-[#e7ded3] bg-[#fdfaf5] p-5 sm:p-6 md:border-l md:border-t-0">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#eaf2e6] text-[#466447]">
                <Quote className="size-4" aria-hidden="true" />
              </span>
              <div>
                <p className="font-bold text-[#3d241c]">Why this result appeared</p>
                <p className="mt-0.5 text-xs text-stone-500">Exact lines from this fictional résumé</p>
              </div>
            </div>

            <div className="mt-4 space-y-3">
              {result.citations.map(citation => (
                <figure
                  key={citation.citation_id}
                  id={citation.citation_id}
                  className="rounded-xl border border-[#e5dbcf] bg-white p-4"
                >
                  <blockquote className="text-sm leading-6 text-stone-700">
                    “{citation.exact_quote}”
                  </blockquote>
                  <figcaption className="mt-3 flex items-center gap-1.5 border-t border-stone-100 pt-3 text-xs leading-5 text-stone-500">
                    <FileText className="size-3.5 shrink-0" aria-hidden="true" />
                    {citation.document_label} · {citation.location} · [{citation.citation_id}]
                  </figcaption>
                </figure>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap gap-2" aria-label="Topics found in retrieved evidence">
              <span className="py-1 text-xs font-semibold text-stone-500">Evidence mentions:</span>
              {result.evidence_topics.map(topic => (
                <span key={topic} className="rounded-full bg-[#eaf2e6] px-2.5 py-1 text-xs font-medium text-[#39583a]">
                  {topic}
                </span>
              ))}
            </div>
          </div>
        </div>

        <details className="group border-t border-[#e7ded3] bg-white px-5 py-3 sm:px-6">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-xs font-semibold text-stone-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9f3f27]">
            Technical search numbers
            <ChevronDown className="size-4 transition group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="pb-3 text-xs leading-5 text-stone-500">
            <p>
              Weighted evidence similarity: {result.weighted_evidence_similarity.toFixed(3)}. This compares the search with the two quoted résumé passages. It is not a fit score, confidence estimate, or hiring recommendation.
            </p>
            <ul className="mt-2 space-y-1" aria-label="Citation similarity values">
              {result.citations.map(citation => (
                <li key={citation.citation_id} className="font-mono">
                  [{citation.citation_id}] block similarity {citation.similarity.toFixed(3)}
                </li>
              ))}
            </ul>
          </div>
        </details>
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
    <section id="search-demo" aria-labelledby="search-demo-title" className="min-w-0 scroll-mt-6">
      <div className="rounded-2xl border border-[#ded4c8] bg-white p-5 shadow-[0_12px_38px_rgba(76,46,32,0.07)] sm:p-7">
        <Badge variant="outline" className="border-[#e0d3c4] bg-[#fff9f0] px-3 py-1 text-[#8d3925]">
          <Sparkles className="size-3.5" aria-hidden="true" />
          Candidate search
        </Badge>
        <h2 id="search-demo-title" className="mt-4 text-2xl font-bold tracking-[-0.025em] text-[#3d241c] sm:text-3xl">
          What do you need help covering?
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600 sm:text-base">
          Write it the way you’d explain it to a manager—include the job, shift, and experience that matter.
        </p>

        <form role="search" onSubmit={handleSubmit} className="mt-6">
          <label htmlFor="semantic-candidate-query" className="text-sm font-bold text-stone-800">
            Describe the person you need
          </label>
          <p id="semantic-query-guidance" className="mt-1 text-xs leading-5 text-stone-500">
            Search by job-related skills, experience, certifications, or schedule. Don’t enter real applicant data. If live mode is enabled, query text is sent to Google for embedding.
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
                placeholder="Example: Weekend opener who can train baristas"
                className="min-h-12 w-full rounded-xl border border-[#d7cabd] bg-[#fffdf9] py-3 pl-11 pr-4 text-sm text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-[#9f3f27] focus:bg-white focus:ring-4 focus:ring-[#f4ddd5]"
              />
            </div>

            <Button
              type="submit"
              disabled={state.loading || query.trim().length < 3}
              className="min-h-12 rounded-xl bg-[#8d3925] px-5 font-bold text-white shadow-sm hover:bg-[#712c1d] focus-visible:ring-[#9f3f27]"
            >
              {state.loading ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                  Searching résumés…
                </>
              ) : (
                <>
                  Find candidates
                  <ArrowRight className="size-4" aria-hidden="true" />
                </>
              )}
            </Button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-stone-500">Quick examples:</span>
            {EXAMPLE_QUERIES.map((example, index) => (
              <button
                key={example}
                type="button"
                onClick={() => chooseExample(example)}
                disabled={state.loading}
                aria-label={`Use example query: ${example}`}
                className="min-h-11 rounded-full border border-[#ded4c8] bg-[#fffdf9] px-3 text-left text-xs font-semibold text-stone-700 transition hover:border-[#b9715c] hover:bg-[#fff4e8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9f3f27] disabled:opacity-50"
              >
                {index === 0 ? 'Weekend opener + training' : index === 1 ? 'Early baker + sourdough' : 'Shift lead + inventory'}
              </button>
            ))}
          </div>
        </form>
      </div>

      <div className="min-h-7" aria-live="polite" aria-atomic="true">
        {state.loading && (
          <p role="status" className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-stone-600">
            <LoaderCircle className="size-4 animate-spin text-[#8d3925]" aria-hidden="true" />
            Looking through 24 fictional résumé sections…
          </p>
        )}
        {state.error && (
          <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <p className="font-bold">We couldn’t run that search</p>
            <p className="mt-1">{state.error}</p>
            <Button
              type="button"
              variant="outline"
              onClick={() => { void executeSearch(query, true); }}
              className="mt-3 min-h-11 border-red-200 bg-white text-red-800 hover:bg-red-100"
            >
              <RotateCcw className="size-4" aria-hidden="true" />
              Try again
            </Button>
            {state.requestId && (
              <details className="mt-3 text-xs">
                <summary className="cursor-pointer font-semibold">Technical details</summary>
                <p className="mt-1 font-mono">Request {state.requestId}</p>
              </details>
            )}
          </div>
        )}
      </div>

      {!state.response && !state.loading && !state.error && (
        <div className="mt-2 rounded-2xl border border-dashed border-[#d7cabd] bg-[#fffaf3] p-5" role="note">
          <p className="font-bold text-[#3d241c]">Ready when you are</p>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            Try the prepared weekend-barista search or choose a quick example. A role plus one or two must-haves works well.
          </p>
        </div>
      )}

      {state.response && (
        <div className="mt-2" aria-busy={state.loading}>
          <div className="rounded-2xl border border-[#ded4c8] bg-white p-5 sm:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2
                  ref={resultsHeadingRef}
                  tabIndex={-1}
                  className="text-xl font-bold text-[#3d241c] outline-none focus-visible:ring-2 focus-visible:ring-[#9f3f27] sm:text-2xl"
                >
                  {state.response.result_count} résumé matches to review
                </h2>
                <p className="mt-1 text-sm text-stone-500">
                  For “{state.response.query}”
                </p>
              </div>
              <Badge className={isLiveEmbedding
                ? 'border border-[#cadfc7] bg-[#edf6e9] px-3 py-1.5 text-[#365a38]'
                : 'border border-[#e7d1a8] bg-[#fff7df] px-3 py-1.5 text-[#76531e]'}
              >
                {isLiveEmbedding ? <CheckCircle2 className="size-3.5" aria-hidden="true" /> : <ShieldCheck className="size-3.5" aria-hidden="true" />}
                {isLiveEmbedding ? 'Live Gemini embeddings' : 'Demo matching · Deterministic fallback'}
              </Badge>
            </div>

            <div className="mt-4 rounded-xl border border-[#ead9b7] bg-[#fff8e8] px-4 py-3 text-sm leading-6 text-[#674b20]" role="note">
              Ordered by how closely the quoted résumé passages relate to your search—not by applicant quality. There is no pass line or hiring recommendation.
            </div>
            <p className="mt-3 flex items-start gap-2 text-sm leading-6 text-stone-600">
              <ShieldCheck className="mt-1 size-4 shrink-0 text-[#466447]" aria-hidden="true" />
              Your check: read the quoted lines and verify the same job-related requirements with every applicant.
            </p>

            <details className="group mt-4 border-t border-stone-100 pt-3 text-xs text-stone-500">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9f3f27]">
                Search details and safeguards
                <ChevronDown className="size-4 transition group-open:rotate-180" aria-hidden="true" />
              </summary>
              <div className="pb-2 leading-5">
                <p>
                  {state.response.retrieval.dimensions} dimensions · {state.response.latency_ms}ms · request {state.response.request_id}
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-5" aria-label="Search response safeguards">
                  {state.response.warnings.map(warning => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            </details>
          </div>

          <ol className="mt-5 grid gap-4" aria-label="Semantically ranked synthetic candidate profiles">
            {state.response.results.map(result => (
              <ResultCard key={result.synthetic_candidate_ref} result={result} />
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
