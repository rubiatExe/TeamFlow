import {
  BriefcaseBusiness,
  CircleCheck,
  Coffee,
  ExternalLink,
  Github,
  MapPin,
  ShieldCheck,
  UsersRound,
  Wheat,
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
    label: 'Search and citations',
    href: `${repositoryUrl}/tree/${sourceRef}/lib/demo`,
  },
  {
    label: 'LangGraph review workflow',
    href: `${repositoryUrl}/blob/${sourceRef}/services/hiring-agent/teamflow_hiring_agent/resume_review/graph/builder.py`,
  },
  {
    label: 'Evaluation checks',
    href: `${repositoryUrl}/tree/${sourceRef}/services/hiring-agent/teamflow_hiring_agent/evaluation`,
  },
  {
    label: 'Release workflow',
    href: `${repositoryUrl}/blob/${sourceRef}/.github/workflows/deploy-hiring-agent.yml`,
  },
] as const;

const ownerSteps = [
  {
    title: 'Say what you need',
    detail: 'Use normal words—include the role, shift, and useful experience.',
  },
  {
    title: 'Review the proof',
    detail: 'See the exact résumé lines that brought each person into the list.',
  },
  {
    title: 'Choose your next step',
    detail: 'You decide who to contact or interview. TeamFlow never decides for you.',
  },
] as const;

export default function HomePage() {
  return (
    <div className="min-h-screen bg-[#f5f0e7] text-stone-900">
      <a
        href="#main-content"
        className="sr-only z-50 rounded-md bg-white px-4 py-3 font-semibold text-stone-900 focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:ring-2 focus:ring-[#9f3f27]"
      >
        Skip to main content
      </a>

      <header className="border-b border-[#dfd3c3] bg-[#fffdf8]">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
          <a
            href="#main-content"
            className="flex min-h-11 items-center gap-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9f3f27]"
          >
            <span className="flex size-10 items-center justify-center rounded-xl bg-[#6d3a2b] text-[#fff8eb] shadow-sm">
              <Wheat className="size-5" aria-hidden="true" />
            </span>
            <span>
              <span className="block text-base font-bold leading-5 text-[#3d241c]">TeamFlow</span>
              <span className="block text-xs text-stone-500">Cocoa Bakery</span>
            </span>
          </a>

          <div className="flex items-center gap-3">
            <Badge variant="outline" className="border-[#dfd3c3] bg-white px-2.5 py-1 text-stone-600 sm:px-3">
              Demo · fictional applicants
            </Badge>
            <a
              href="#about-demo"
              className="hidden min-h-11 items-center rounded-lg px-2 text-sm font-semibold text-stone-600 hover:text-[#7c3020] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9f3f27] sm:inline-flex"
            >
              About this demo
            </a>
          </div>
        </div>
      </header>

      <main id="main-content">
        <section className="border-b border-[#e4d8c9] bg-[#fffaf1]">
          <div className="mx-auto grid max-w-6xl gap-7 px-4 py-8 sm:px-6 sm:py-11 lg:grid-cols-[1fr_22rem] lg:items-center lg:px-8">
            <div>
              <p className="flex items-center gap-2 text-sm font-semibold text-[#8d3925]">
                <BriefcaseBusiness className="size-4" aria-hidden="true" />
                Hiring workspace
              </p>
              <h1 className="mt-3 max-w-3xl text-3xl font-bold leading-tight tracking-[-0.035em] text-[#3d241c] sm:text-4xl lg:text-5xl">
                Let’s fill the shifts that keep Cocoa Bakery moving.
              </h1>
              <p className="mt-4 max-w-2xl text-base leading-7 text-stone-600 sm:text-lg">
                Tell TeamFlow what kind of help your bakery needs. You’ll get a short list with the résumé proof beside every person.
              </p>
              <div className="mt-5 flex flex-wrap gap-2 text-sm">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[#dfd3c3] bg-white px-3 py-1.5 font-medium text-stone-700">
                  <UsersRound className="size-4 text-[#8d3925]" aria-hidden="true" />
                  8 sample applicants ready
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[#d5dfcf] bg-[#f4f8f1] px-3 py-1.5 font-medium text-[#3e6040]">
                  <ShieldCheck className="size-4" aria-hidden="true" />
                  No automated hiring decisions
                </span>
              </div>
            </div>

            <aside className="rounded-2xl border border-[#dfd3c3] bg-white p-5 shadow-[0_12px_35px_rgba(76,46,32,0.08)]" aria-label="Open bakery roles">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.14em] text-stone-500">Open roles</p>
                  <h2 className="mt-2 text-xl font-bold text-[#3d241c]">3 roles to fill</h2>
                </div>
                <span className="flex size-10 items-center justify-center rounded-xl bg-[#f7e7d3] text-[#8d3925]">
                  <Coffee className="size-5" aria-hidden="true" />
                </span>
              </div>
              <ul className="mt-5 grid gap-2 text-sm text-stone-700" aria-label="Bakery roles currently hiring">
                <li className="rounded-lg bg-[#faf6ef] px-3 py-2 font-medium">Weekend barista</li>
                <li className="rounded-lg bg-[#faf6ef] px-3 py-2 font-medium">Early-morning baker</li>
                <li className="rounded-lg bg-[#faf6ef] px-3 py-2 font-medium">Shift supervisor</li>
              </ul>
              <p className="mt-4 flex items-center gap-2 border-t border-stone-100 pt-4 text-sm text-stone-500">
                <MapPin className="size-4" aria-hidden="true" />
                Jersey City, NJ
              </p>
            </aside>
          </div>
        </section>

        <div className="mx-auto grid max-w-6xl gap-6 px-4 py-7 sm:px-6 sm:py-9 lg:grid-cols-[17rem_minmax(0,1fr)] lg:items-start lg:px-8">
          <aside className="order-2 rounded-2xl border border-[#dfd3c3] bg-[#fffdf8] p-5 lg:sticky lg:top-5 lg:order-1" aria-labelledby="easy-steps-title">
            <p id="easy-steps-title" className="text-sm font-bold text-[#3d241c]">Three easy steps</p>
            <ol className="mt-5 space-y-5">
              {ownerSteps.map((step, index) => (
                <li key={step.title} className="flex gap-3">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[#f1ddca] text-xs font-bold text-[#7c3020]">
                    {index + 1}
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-stone-800">{step.title}</p>
                    <p className="mt-1 text-xs leading-5 text-stone-500">{step.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="mt-6 rounded-xl bg-[#edf4ea] p-4 text-sm leading-6 text-[#39583a]">
              <p className="flex items-center gap-2 font-bold">
                <CircleCheck className="size-4" aria-hidden="true" />
                Your call, always
              </p>
              <p className="mt-1 text-xs leading-5">The search finds relevant evidence. You review it and make the decision.</p>
            </div>
          </aside>

          <div className="order-1 min-w-0 lg:order-2">
            <RecruiterSemanticSearch />
          </div>
        </div>

        <section id="about-demo" className="scroll-mt-6 border-t border-[#dfd3c3] bg-[#fffdf8]">
          <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
            <details className="group rounded-2xl border border-[#dfd3c3] bg-white p-5">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 font-semibold text-[#3d241c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9f3f27]">
                About the demo, safety, and technical proof
                <span className="text-xl font-normal text-stone-400 transition group-open:rotate-45" aria-hidden="true">+</span>
              </summary>
              <div className="mt-5 grid gap-6 border-t border-stone-100 pt-5 text-sm leading-6 text-stone-600 md:grid-cols-2">
                <div>
                  <p className="font-semibold text-stone-900">What a bakery owner is trying here</p>
                  <p className="mt-2">This public page searches 8 fictional profiles and 24 synthetic résumé blocks. Synthetic data · read-only. No real applicant records, messages, or hiring statuses are used.</p>
                  <p className="mt-3">A hiring manager reviews evidence and owns every employment decision. The search retrieves; the manager decides.</p>
                </div>
                <div>
                  <p className="font-semibold text-stone-900">What the repository demonstrates</p>
                  <p className="mt-2">The private service includes LangGraph orchestration, FastMCP tools, merchant-scoped pgvector retrieval, evaluation checks, OpenTelemetry, and keyless deployment workflows. Those private-service paths are not executed by this public search page.</p>
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
                    {implementationLinks.map(link => (
                      <a key={link.label} href={link.href} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1.5 font-semibold text-[#7c3020] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9f3f27]">
                        {link.label}
                        <ExternalLink className="size-3.5" aria-hidden="true" />
                      </a>
                    ))}
                  </div>
                </div>
              </div>
            </details>
          </div>
        </section>
      </main>

      <footer className="border-t border-[#e5dacb] bg-[#f5f0e7]">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-6 text-sm text-stone-500 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <p>TeamFlow · Simple hiring help for small teams</p>
          <a href={deployedSourceUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-2 self-start font-medium text-stone-600 hover:text-[#7c3020] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9f3f27] sm:self-auto">
            <Github className="size-4" aria-hidden="true" />
            Technical source
          </a>
        </div>
      </footer>
    </div>
  );
}
