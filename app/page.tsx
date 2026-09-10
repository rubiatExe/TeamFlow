import {
  Activity,
  ArrowDown,
  ArrowRight,
  Braces,
  Database,
  ExternalLink,
  FileCheck2,
  Github,
  GitMerge,
  LockKeyhole,
  Network,
  ScanSearch,
  ShieldCheck,
  UserRoundCheck,
} from 'lucide-react';

import { RecruiterSemanticSearch } from '@/components/demo/recruiter-semantic-search';
import { Badge } from '@/components/ui/badge';

const repositoryUrl = 'https://github.com/rubiatExe/TeamFlow';
const deployedCommit = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
const sourceRef = deployedCommit && /^[0-9a-f]{40}$/u.test(deployedCommit)
  ? deployedCommit
  : 'codex/semantic-candidate-search';
const deployedSourceUrl = `${repositoryUrl}/tree/${sourceRef}`;

const implementationLinks = [
  {
    label: 'Public cited search',
    detail: 'Synthetic corpus, embedding provider, cosine ranking, literal citations, strict schemas, and safe fallback.',
    href: `${repositoryUrl}/tree/${sourceRef}/lib/demo`,
    icon: ScanSearch,
  },
  {
    label: 'LangGraph workflow',
    detail: 'Explicit nodes, conditional routing, bounded recovery, and human-review state.',
    href: `${repositoryUrl}/blob/${sourceRef}/services/hiring-agent/teamflow_hiring_agent/resume_review/graph/builder.py`,
    icon: GitMerge,
  },
  {
    label: 'FastMCP retrieval tool',
    detail: 'Read-only, validated, tenant-scoped semantic search capability.',
    href: `${repositoryUrl}/blob/${sourceRef}/services/hiring-agent/teamflow_hiring_agent/mcp/server.py`,
    icon: Network,
  },
  {
    label: 'pgvector boundary',
    detail: '768-dimensional cosine search with security-invoker and merchant isolation.',
    href: `${repositoryUrl}/blob/${sourceRef}/supabase/migrations/20260826211439_harden_hiring_data_api.sql`,
    icon: Database,
  },
  {
    label: 'Evaluation harness',
    detail: 'Golden-set diagnostics for groundedness, relevance, and consistency.',
    href: `${repositoryUrl}/tree/${sourceRef}/services/hiring-agent/teamflow_hiring_agent/evaluation`,
    icon: FileCheck2,
  },
  {
    label: 'OpenTelemetry',
    detail: 'Safe operational spans and trace-context-only propagation boundaries.',
    href: `${repositoryUrl}/blob/${sourceRef}/instrumentation.ts`,
    icon: Activity,
  },
  {
    label: 'Keyless release workflow',
    detail: 'Pinned GitHub Actions with OIDC/WIF configuration and canary promotion gates.',
    href: `${repositoryUrl}/blob/${sourceRef}/.github/workflows/deploy-hiring-agent.yml`,
    icon: LockKeyhole,
  },
] as const;

export default function HomePage() {
  return (
    <div className="min-h-screen bg-[#f7f6f1] text-stone-900">
      <a href="#main-content" className="sr-only z-50 rounded-md bg-white px-4 py-3 font-semibold text-stone-900 focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:ring-2 focus:ring-emerald-700">
        Skip to main content
      </a>
      <header className="sticky top-0 z-40 border-b border-stone-200/80 bg-[#f7f6f1]/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
          <a href="#main-content" className="flex min-h-11 items-center gap-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700">
            <span className="flex size-9 items-center justify-center rounded-xl bg-[#173f32] text-sm font-bold text-white shadow-sm">TF</span>
            <span>
              <span className="block text-sm font-semibold leading-4 text-stone-900">TeamFlow</span>
              <span className="hidden whitespace-nowrap text-[0.68rem] font-medium uppercase tracking-[0.14em] text-stone-500 min-[460px]:block">Evidence-first hiring AI</span>
            </span>
          </a>

          <nav aria-label="Primary navigation" className="flex items-center gap-1 sm:gap-3">
            <a href="#architecture" className="hidden min-h-11 items-center rounded-lg px-3 text-sm font-medium text-stone-600 hover:bg-white hover:text-stone-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 sm:inline-flex">
              Architecture
            </a>
            <a
              href={deployedSourceUrl}
              target="_blank"
              rel="noreferrer"
              aria-label="View TeamFlow source code on GitHub"
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-stone-300 bg-white px-3.5 text-sm font-semibold text-stone-800 shadow-sm transition hover:border-stone-400 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"
            >
              <Github className="size-4" aria-hidden="true" />
              <span className="hidden whitespace-nowrap sm:inline">View code</span>
              <ExternalLink className="size-3.5 text-stone-400" aria-hidden="true" />
            </a>
          </nav>
        </div>
      </header>

      <main id="main-content">
        <section className="relative">
          <div className="pointer-events-none absolute inset-x-0 top-0 -z-0 h-[38rem] bg-[radial-gradient(circle_at_78%_18%,rgba(80,150,111,0.19),transparent_31%),radial-gradient(circle_at_14%_12%,rgba(215,180,95,0.15),transparent_27%)]" />
          <div className="relative mx-auto max-w-[1400px] px-4 pb-14 pt-16 sm:px-6 sm:pb-20 sm:pt-24 lg:px-8 lg:pt-28">
            <div className="grid gap-12 lg:grid-cols-[1.15fr_0.85fr] lg:items-end">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="border border-emerald-200 bg-emerald-50 px-3 py-1 text-emerald-800">
                    <ShieldCheck className="size-3.5" aria-hidden="true" />
                    Public production demo
                  </Badge>
                  <Badge variant="outline" className="border-stone-300 bg-white/70 px-3 py-1 text-stone-600">
                    Synthetic data · read-only
                  </Badge>
                </div>

                <h1 className="mt-7 max-w-4xl text-5xl font-semibold leading-[0.98] tracking-[-0.055em] text-stone-950 sm:text-6xl lg:text-7xl">
                  Describe the person you need. See the evidence behind every match.
                </h1>
                <p className="mt-7 max-w-2xl text-lg leading-8 text-stone-600 sm:text-xl">
                  TeamFlow turns a hiring manager’s natural-language request into an evidence-grounded candidate list—without presenting retrieval similarity as a hiring decision.
                </p>

                <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                  <a href="#search-demo" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-[#173f32] px-5 text-sm font-semibold text-white shadow-lg shadow-emerald-950/10 transition hover:bg-[#0f3025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2">
                    Try semantic search
                    <ArrowDown className="size-4" aria-hidden="true" />
                  </a>
                  <a href="#architecture" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-stone-300 bg-white px-5 text-sm font-semibold text-stone-800 shadow-sm transition hover:border-stone-400 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2">
                    Inspect the architecture
                    <ArrowRight className="size-4" aria-hidden="true" />
                  </a>
                </div>
              </div>

              <aside className="rounded-[1.75rem] border border-stone-200 bg-white/85 p-6 shadow-[0_24px_80px_rgba(28,25,23,0.08)] backdrop-blur sm:p-8" aria-label="Demo guarantees">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-800">What this page guarantees</p>
                <dl className="mt-6 grid grid-cols-3 gap-3">
                  <div>
                    <dt className="text-3xl font-semibold tracking-tight text-stone-950">8</dt>
                    <dd className="mt-1 text-xs leading-5 text-stone-500">fictional profiles</dd>
                  </div>
                  <div>
                    <dt className="text-3xl font-semibold tracking-tight text-stone-950">24</dt>
                    <dd className="mt-1 text-xs leading-5 text-stone-500">citable source blocks</dd>
                  </div>
                  <div>
                    <dt className="text-3xl font-semibold tracking-tight text-stone-950">0</dt>
                    <dd className="mt-1 text-xs leading-5 text-stone-500">automated decisions</dd>
                  </div>
                </dl>
                <div className="mt-7 space-y-3 border-t border-stone-200 pt-6 text-sm text-stone-600">
                  <p className="flex items-start gap-2.5">
                    <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-700" aria-hidden="true" />
                    Common direct sensitive-trait, contact, credential, and decision-seeking terms are blocked before retrieval.
                  </p>
                  <p className="flex items-start gap-2.5">
                    <UserRoundCheck className="mt-0.5 size-4 shrink-0 text-emerald-700" aria-hidden="true" />
                    A hiring manager reviews evidence; the platform owner operates policy, access, and telemetry.
                  </p>
                </div>
              </aside>
            </div>
          </div>
        </section>

        <div className="mx-auto max-w-[1400px] px-4 pb-20 sm:px-6 lg:px-8">
          <RecruiterSemanticSearch />
        </div>

        <section id="architecture" className="border-y border-stone-200 bg-white py-20 sm:py-24">
          <div className="mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8">
            <div className="max-w-3xl">
              <Badge variant="outline" className="border-stone-300 bg-stone-50 px-3 py-1 text-stone-600">Execution path</Badge>
              <h2 className="mt-5 text-3xl font-semibold tracking-[-0.04em] text-stone-950 sm:text-5xl">A bounded retrieval workflow, end to end.</h2>
              <p className="mt-5 text-lg leading-8 text-stone-600">
                The public page executes retrieval over synthetic evidence. It does not call the decision workflow or expose the private tenant-scoped candidate store.
              </p>
            </div>

            <ol className="mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="Semantic retrieval workflow">
              {[
                { number: '01', title: 'Validate query', text: 'Bound length and bytes; block common direct sensitive, contact, credential, and hiring-decision terms.', icon: ShieldCheck },
                { number: '02', title: 'Create vector', text: 'Use a 768d Gemini retrieval-query embedding, with a visibly labeled deterministic vector fallback.', icon: Braces },
                { number: '03', title: 'Rank evidence', text: 'Compare the query with canonical synthetic résumé blocks using cosine similarity; apply no cutoff.', icon: ScanSearch },
                { number: '04', title: 'Return citations', text: 'Project only synthetic profile fields and literal source quotations through a strict response schema.', icon: FileCheck2 },
              ].map(step => (
                <li key={step.number} className="rounded-2xl border border-stone-200 bg-[#faf9f5] p-6">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-semibold text-stone-400">{step.number}</span>
                    <step.icon className="size-5 text-emerald-700" aria-hidden="true" />
                  </div>
                  <h3 className="mt-8 text-lg font-semibold text-stone-900">{step.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-stone-600">{step.text}</p>
                </li>
              ))}
            </ol>

            <div className="mt-12 grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
              <div className="rounded-[1.75rem] bg-[#10271f] p-6 text-white sm:p-8">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-200">Truthful system boundary</p>
                <h3 className="mt-4 text-2xl font-semibold !text-white">The demo and private agent are related, but not conflated.</h3>
                <div className="mt-7 space-y-5 text-sm leading-6 text-emerald-50/75">
                  <div className="border-l-2 border-emerald-400 pl-4">
                    <p className="font-semibold text-white">Executed on this public page</p>
                    <p className="mt-1">Synthetic-only embedding retrieval, cosine ranking, literal citations, schema validation, bounded failure handling, and telemetry-safe operational spans.</p>
                  </div>
                  <div className="border-l-2 border-amber-300 pl-4">
                    <p className="font-semibold text-white">Implemented in the private service</p>
                    <p className="mt-1">LangGraph orchestration, FastMCP tools, merchant-scoped pgvector retrieval, confidence routing, and durable human-review controls.</p>
                  </div>
                  <div className="border-l-2 border-stone-500 pl-4">
                    <p className="font-semibold text-white">Deliberately excluded here</p>
                    <p className="mt-1">Real résumés, applicant contact data, status changes, invitations, automated rejection, and public access to private hiring tools.</p>
                  </div>
                </div>
              </div>

              <div className="rounded-[1.75rem] border border-stone-200 bg-[#faf9f5] p-6 sm:p-8">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">Human accountability</p>
                <h3 className="mt-4 text-2xl font-semibold text-stone-950">AI retrieves. The manager decides.</h3>
                <div className="mt-7 space-y-5">
                  <div className="flex gap-4">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-sm font-semibold text-emerald-900">1</span>
                    <div>
                      <p className="font-semibold text-stone-900">Hiring manager</p>
                      <p className="mt-1 text-sm leading-6 text-stone-600">Reviews the original evidence, confirms job relevance, interviews consistently, and owns the employment decision.</p>
                    </div>
                  </div>
                  <div className="flex gap-4">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-sm font-semibold text-amber-900">2</span>
                    <div>
                      <p className="font-semibold text-stone-900">Platform owner</p>
                      <p className="mt-1 text-sm leading-6 text-stone-600">Owns access control, approved criteria, model and prompt versions, evaluation gates, telemetry, incident response, and rollback.</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="py-20 sm:py-24">
          <div className="mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
              <div className="max-w-3xl">
                <Badge variant="outline" className="border-stone-300 bg-white px-3 py-1 text-stone-600">Repository evidence</Badge>
                <h2 className="mt-5 text-3xl font-semibold tracking-[-0.04em] text-stone-950 sm:text-5xl">Inspect the implementation behind the claims.</h2>
              </div>
              <a href={deployedSourceUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-2 self-start rounded-lg text-sm font-semibold text-emerald-800 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 sm:self-auto">
                Open deployed source
                <ExternalLink className="size-4" aria-hidden="true" />
              </a>
            </div>

            <div className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {implementationLinks.map(item => (
                <a
                  key={item.label}
                  href={item.href}
                  target="_blank"
                  rel="noreferrer"
                  className="group rounded-2xl border border-stone-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-emerald-300 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"
                >
                  <div className="flex items-center justify-between">
                    <span className="flex size-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-800">
                      <item.icon className="size-5" aria-hidden="true" />
                    </span>
                    <ExternalLink className="size-4 text-stone-300 transition group-hover:text-emerald-700" aria-hidden="true" />
                  </div>
                  <h3 className="mt-7 text-lg font-semibold text-stone-900">{item.label}</h3>
                  <p className="mt-2 text-sm leading-6 text-stone-600">{item.detail}</p>
                </a>
              ))}
            </div>

            <div className="mt-10 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm leading-6 text-amber-950" role="note">
              <ShieldCheck className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
              <p><strong>Evidence discipline:</strong> checked-in code demonstrates implementation; it does not, by itself, prove a currently healthy Cloud Run revision, Supabase project, trace export, or evaluation quality threshold. The live search badge above is set by the API response, not marketing copy.</p>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-stone-200 bg-white">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 py-8 text-sm text-stone-500 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <p>TeamFlow · Evidence-grounded candidate discovery · Synthetic portfolio demonstration</p>
          <a href={repositoryUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-2 self-start font-medium text-stone-700 hover:text-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 sm:self-auto">
            <Github className="size-4" aria-hidden="true" />
            github.com/rubiatExe/TeamFlow
          </a>
        </div>
      </footer>
    </div>
  );
}
