# 🌿 TeamFlow

**AI-Powered Hiring for Hourly Workers**

TeamFlow transforms the hourly hiring process with AI-powered resume parsing, intelligent candidate scoring, and a frictionless application experience. Built for busy hiring managers who need to make fast, informed decisions.

**Live bakery-owner demo:** [team-floww.vercel.app](https://team-floww.vercel.app/) — a
sample hiring workspace for the fictional Cocoa Bakery. The candidate board and Smart
Search share eight fictional profiles. An owner can describe an open shift in everyday
language and search the selected role's visible sample profiles.
Every result includes literal citations to its synthetic résumé blocks. The backend
returns up to five profiles, with a query-specific 0–100 blend of visible
job-concept coverage and retrieval relevance. The score is uncalibrated relevance, not
candidate fitness; the active retrieval mode is visible, and no hiring decision is automated. See the
[`public semantic-search demo guide`](docs/public-semantic-search-demo.md) for the exact
runtime and evidence boundary.

Sample pipeline changes and hiring preferences are saved in this browser only; simulated
invites never send messages. Preferences update the displayed criteria but do not rescore
profiles. Public uploads and real applicant mutations remain disabled until an authorized
production workflow is available. Local connected workflows require the explicit demo opt-in.

[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![Gemini](https://img.shields.io/badge/Gemini-AI-blue?logo=google)](https://ai.google.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-4.0-38B2AC?logo=tailwind-css)](https://tailwindcss.com/)

---

## 🎯 The Problem

Hiring hourly workers is broken:
- **Managers are buried** in unstructured resumes
- **Candidates drop off** because applications are too long
- **No intelligent filtering** — just gut feelings
- **Manual screening** wastes hours every week

## 💡 The Solution

TeamFlow uses AI to solve this:

| Feature | How It Helps |
|---------|-------------|
| 🔎 **Evidence-Grounded Search Demo** | A manager describes job-related needs and receives up to five fictional profiles with quoted evidence, visible matching mode, and no fit score or hiring recommendation |
| 🧠 **Smart Resume Parsing** | Drop a PDF and get validated structured data plus a fit score |
| 📊 **AI Fit Scoring** | Gemini analyzes each candidate against role-specific requirements |
| 📱 **Magic Link Invite Demo** | Prototype invite and candidate flow; production token verification and route authorization remain open |
| 📋 **Rich Candidate Profiles** | Availability, skills, motivation — all in one place |
| 🎯 **Hiring Personas** | Configure job-related criteria for consistent human review |

---

## 📸 Screenshots

### Manager Experience

#### Dashboard — Kanban Board
Candidates organized by status. The public workspace uses clearly labelled fictional
profiles and simulated pipeline actions; sample cards do not present invented fit scores.

![Manager Dashboard](docs/screenshots/manager-dashboard.png)

#### Hiring Persona Settings
Define job requirements, dealbreakers, and nice-to-haves. In the public demo these are
browser-local preferences for the displayed role; saving them does not invoke AI scoring.

![Hiring Settings](docs/screenshots/manager-settings.png)

---

### Candidate Experience

#### Knockout Questions
Quick yes/no questions clarify job-related eligibility and availability requirements.

![Knockout Questions](docs/screenshots/candidate-knockout.png)

#### Availability & Profile
Candidates share their preferred shifts, transportation, and contact preferences.

![Profile Form](docs/screenshots/candidate-profile.png)

#### Skills Self-Assessment
Experience level, relevant skills, certifications, and languages — all collected seamlessly.

![Skills Form](docs/screenshots/candidate-skills.png)

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      NEXT.JS FRONTEND                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  Drop Zone  │  │ Kanban Board│  │  Candidate Portal   │  │
│  │ (Resume)    │  │ (Manager)   │  │  (Magic Link)       │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
└─────────┼────────────────┼───────────────────┼──────────────┘
          │                │                   │
          ▼                ▼                   ▼
┌────────────────────────────┐  ┌──────────────────────────────┐
│ /api/parser                │  │ /api/parser/review           │
│ Extraction + legacy score  │  │ Two-agent review adapter     │
└─────────────┬──────────────┘  └──────────────┬───────────────┘
              ▼                                ▼
┌────────────────────────────┐  ┌──────────────────────────────┐
│ DOCUMENT PROCESSOR         │  │ LANGGRAPH RÉSUMÉ REVIEW      │
│ Cloud Run target/config    │  │ Separate Cloud Run target    │
│ • extraction • embeddings  │  │ • Agent 1 classifications   │
└─────────────┬──────────────┘  │ • deterministic score math  │
              │                 │ • Agent 2 gap questions      │
              │                 │ • read-only private MCP      │
              ▼                 └──────────────┬───────────────┘
┌────────────────────────────┐                 │
│ STRUCTURED SCORER          │                 │
│ • schema validation        │                 │
│ • bounded retry/fallback   │                 │
└─────────────┬──────────────┘                 │
              └───────────────┬────────────────┘
                              ▼
                 ┌────────────────────────────┐
                 │ SUPABASE                   │
                 │ Candidate + optional       │
                 │ review-run persistence     │
                 └────────────────────────────┘
```

### Repository Tour

| Area | Where to Start |
|---|---|
| Manager dashboard | `app/page.tsx` and `components/candidates/` |
| Public semantic-search demo | `components/demo/`, `app/api/demo/search/`, and `lib/demo/` |
| Candidate application | `app/apply/page.tsx` and `components/candidate-application/` |
| API orchestration | `app/api/` |
| AI scoring | `lib/ai/` |
| Supabase access | `lib/db/` and `supabase/` |
| External integrations | `lib/integrations/` |
| Cloud Run service | `services/document-processor/` |
| LangGraph + MCP hiring workflow | `services/hiring-agent/` |
| LLM security and reliability runbook | `docs/llm-security-reliability.md` |
| CI/CD and WIF | `.github/workflows/` |

For the full runtime flow and integration contracts, see [`docs/architecture.md`](docs/architecture.md). For a guided walkthrough, see [`docs/demo-guide.md`](docs/demo-guide.md). Résumé claims and their exact evidence level are tracked in [`docs/resume-claim-evidence.md`](docs/resume-claim-evidence.md).

---

## 🚀 Quick Start

### Prerequisites
- Node.js 22+
- Google AI API Key ([Get one free](https://aistudio.google.com/apikey))
- Supabase Project URL and Anon Key

### Installation

```bash
# Clone the repo
git clone https://github.com/rubiatExe/TeamFlow.git
cd TeamFlow

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env.local
# Add your GOOGLE_API_KEY, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, and OCR_SERVICE_URL
# For the unauthenticated local UI demo only, set TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES=true

# Run the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to inspect the local UI. External
services, database bootstrap, and production authorization require the setup described
in the repository docs.

### Test the Candidate Portal
Visit [http://localhost:3000/apply?token=test](http://localhost:3000/apply?token=test) to see the candidate experience.

### Verification

```bash
npm run typecheck
npm run lint
npm test
npm audit --audit-level=high
npm run verify:contracts
npm run build
node scripts/verify-production-styles.mjs --url=https://team-floww.vercel.app
```

`verify:contracts` checks static WIF, Cloud Run, LangGraph, MCP, OCR, Supabase, and
model-compatibility wiring for accidental source drift. It does not verify live cloud,
database, IAM, provider, or deployment state.

`npm run build` also checks that the generated homepage links the current Cocoa theme
and matching font definitions. Production journey checks repeat this against the served
CSS. Use the URL command above after deployment to detect stale compiled assets; a 200
response alone does not establish visual correctness.

The scorer treats Gemini output as untrusted input: responses must satisfy a
structured-output schema and Zod validation, malformed output receives one
bounded retry, and a conservative deterministic fallback prevents a model
formatting error from failing the upload.

Historical implementation stories, tradeoffs, and lessons learned are captured in
[journal.md](./journal.md). Use the evidence ledger—not the journal alone—for current
interview claims.

For an optional end-to-end local trace that joins Next.js, Cloud Run, OCR,
embedding, scoring, and persistence in Google Cloud Trace, follow
[`ops/observability/README.md`](ops/observability/README.md). Trace export is
disabled by default.

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | Next.js 16 (App Router), React 19, Tailwind CSS 4 |
| **Microservices** | Python 3, FastAPI, LangGraph, LangChain, and FastMCP, targeting Cloud Run |
| **AI/ML** | Google Gemini for scanned/image transcription, embeddings, and structured analysis |
| **UI Components** | shadcn/ui, Lucide Icons |
| **Database** | Supabase (PostgreSQL) |
| **SMS** | Twilio (for magic links) |
| **Design** | Scandinavian Warmth design system |


---

## 🔮 Roadmap

- [x] Resume parsing with Gemini
- [x] AI fit scoring
- [x] Kanban candidate management
- [x] Supabase integration for candidate persistence
- [x] Deterministic PDF-first extraction with typed, fail-closed provenance
- [x] Synthetic digital/scanned PDF routing and field-survival regression fixtures
- [x] Locally tested Agent 1 → deterministic scoring → Agent 2 LangGraph review API
- [x] Least-privilege two-tool review selection from a shared six-tool FastMCP boundary,
  plus insert-only review contracts
- [x] Versioned shadow-only known-criterion coverage plus explicit integrity/safety gates
- [x] Manifest/hash-bound validation-only risk/coverage tooling (fixture-only; no producer attestation)
- [ ] Human-approved labels, a measured curve, and a separately governed routing threshold
- [x] Feature-gated authenticated v2 human-review backend with PostgreSQL
  checkpoint/restart, tenant-derived queue/detail, and idempotent decisions (locally
  integration-tested; no reviewer UI, claim lease, or deployment evidence)
- [x] Offline diagnostic judge and comparable semantic-regression tooling with
  immutable, content-free artifacts (locally fixture/test-transport tested; no live call)
- [x] Phase 8A repository release hardening: scoped tenant-bound Supabase capabilities,
  killable PDF isolation, hash-locked dependencies, a passing high-severity npm audit
  gate (one moderate `@humanfs/node` advisory remains), fresh migration replay, non-root
  images, and staged exact-digest Cloud Run workflows (locally tested; no live deployment,
  IAM/WAF, provider canary, alert, backup, or rollback evidence)
- [ ] Independent human review of the 30-case validation split and measured live-judge
  agreement, kappa, false-accept, false-reject, and error rates
- [ ] A calibrated narrow judge and separately governed production policy; the diagnostic
  judge currently has no hiring, scoring, routing, persistence, or database authority
- [ ] Live Gemini OCR accuracy, CER/WER, and field-survival quality measurements
- [ ] Production-secure magic link invites (the demo flow is not an authorization boundary)
- [x] Multi-step candidate portal
- [ ] Calendar integration for scheduling
- [ ] Video/audio "Vibe Check" recording
- [ ] Bulk SMS campaigns

---

## 📄 License

MIT © 2024

---
