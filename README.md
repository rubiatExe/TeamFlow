# 🌿 TeamFlow

**AI-Powered Hiring for Hourly Workers**

TeamFlow transforms the hourly hiring process with AI-powered resume parsing, intelligent candidate scoring, and a frictionless application experience. Built for busy hiring managers who need to make fast, informed decisions.

[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![Gemini](https://img.shields.io/badge/Gemini-3.1%20Pro-blue?logo=google)](https://ai.google.dev/)
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
| 🧠 **Smart Resume Parsing** | Drop a PDF, get structured data + fit score in seconds |
| 📊 **AI Fit Scoring** | Gemini analyzes each candidate against role-specific requirements |
| 📱 **Magic Link Invites** | One-click candidate invites via SMS — no login needed |
| 📋 **Rich Candidate Profiles** | Availability, skills, motivation — all in one place |
| 🎯 **Hiring Personas** | Define dealbreakers once, auto-filter forever |

---

## 📸 Screenshots

### Manager Experience

#### Dashboard — Kanban Board
Candidates organized by status with AI-generated fit scores. Drag-and-drop to move through the pipeline.

![Manager Dashboard](docs/screenshots/manager-dashboard.png)

#### Hiring Persona Settings
Define job requirements, dealbreakers, and nice-to-haves. The AI uses this to score every candidate.

![Hiring Settings](docs/screenshots/manager-settings.png)

---

### Candidate Experience

#### Knockout Questions
Quick yes/no questions filter for dealbreakers (age, work authorization, availability).

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
┌─────────────────────────────────────────────────────────────┐
│                      API ROUTES                             │
│  /api/parser (Orchestrator) │ /api/invite (Magic Links)     │
└─────────┬───────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│             PYTHON OCR MICROSERVICE (Cloud Run)             │
│  • PyMuPDF/Tesseract extraction                             │
└─────────┬───────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│                   GEMINI 3.1 PRO (Scorer)                   │
│  • Structured JSON parsing • Fit scoring • Skill matching   │
└─────────────────────────────────────────────────────────────┘
```

### Repository Tour

| Area | Where to Start |
|---|---|
| Manager dashboard | `app/page.tsx` and `components/candidates/` |
| Candidate application | `app/apply/page.tsx` and `components/candidate-application/` |
| API orchestration | `app/api/` |
| AI scoring | `lib/ai/` |
| Supabase access | `lib/db/` and `supabase/` |
| External integrations | `lib/integrations/` |
| Cloud Run service | `services/document-processor/` |
| CI/CD and WIF | `.github/workflows/` |

For the full runtime flow and integration contracts, see [`docs/architecture.md`](docs/architecture.md). For a guided walkthrough, see [`docs/demo-guide.md`](docs/demo-guide.md).

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

# Run the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — you're ready to hire!

### Test the Candidate Portal
Visit [http://localhost:3000/apply?token=test](http://localhost:3000/apply?token=test) to see the candidate experience.

### Verification

```bash
npm run typecheck
npm run lint
npm test
npm run verify:contracts
npm run build
```

`verify:contracts` protects the WIF, Cloud Run, OCR, and Supabase connection points from accidental path or configuration drift.

The scorer treats Gemini output as untrusted input: responses must satisfy a
structured-output schema and Zod validation, malformed output receives one
bounded retry, and a conservative deterministic fallback prevents a model
formatting error from failing the upload.

The implementation story, tradeoffs, and lessons learned are captured in
[journal.md](./journal.md) as an interview-ready development narrative.

For an optional end-to-end local trace that joins Next.js, Cloud Run, OCR,
embedding, scoring, and persistence in Google Cloud Trace, follow
[`ops/observability/README.md`](ops/observability/README.md). Trace export is
disabled by default.

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | Next.js 16 (App Router), React 19, Tailwind CSS 4 |
| **Microservice** | Python 3 with FastAPI, deployed on Google Cloud Run |
| **AI/ML** | Google Gemini for OCR, embeddings, and candidate scoring |
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
- [x] Python OCR pipeline for robust PDF extraction
- [x] Magic link invites
- [x] Multi-step candidate portal
- [ ] Calendar integration for scheduling
- [ ] Video/audio "Vibe Check" recording
- [ ] Bulk SMS campaigns

---

## 📄 License

MIT © 2024

---
