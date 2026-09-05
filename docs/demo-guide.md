# 🎯 TeamFlow — Ultimate Interview Zoom Screen-Share Demo Guide

> **Target Audience**: Technical Recruiters, Engineering Managers, Staff/Principal Engineers  
> **Estimated Demo Duration**: 10–12 Minutes  
> **Key Objective**: Demonstrate a production-minded hybrid AI architecture: a reliable deterministic resume pipeline, an optional LangGraph hiring workflow with MCP tools, Supabase Postgres integration, OpenTelemetry instrumentation, and keyless GCP Workload Identity Federation (WIF) configuration.
>
> **Evidence rule:** Treat every checklist item below as something to verify in the
> current environment. Repository configuration alone is not proof of a live database,
> cloud trace, IAM binding, or deployed revision. See
> [`resume-claim-evidence.md`](resume-claim-evidence.md) and the checked-in
> [`config/ai-model-contract.json`](../config/ai-model-contract.json) before using this
> script.

---

## 📋 Pre-Call Setup (2 Minutes Before Zoom)

Ensure your desktop is organized cleanly with no personal notifications before starting screen-share.

### 1. Terminal Windows (Split Screen / 3 Tabs)
- **Terminal 1 (Next.js Core Web App)**: set
  `TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES=true` in local `.env.local`, then run
  `npm run dev` on `http://localhost:3000`
- **Terminal 2 (Document Processor)**: `cd services/document-processor && uvicorn main:app --port 8000`
- **Terminal 3 (LangGraph Hiring Workflow)**: `cd services/hiring-agent && HIRING_AGENT_TOKEN=local-dev-token AGENT_ALLOW_WRITES=false uvicorn main:app --port 8080`

### 2. Browser Tabs (Arranged Left-to-Right)
1. 🌐 **TeamFlow Web App**: `http://localhost:3000` (Dashboard & Hiring Funnel)
2. 🗄️ **Supabase Dashboard**: Table Editor (`candidates`, `applications`, `merchants`)
3. 🐙 **GitHub Repository**: [rubiatExe/TeamFlow](https://github.com/rubiatExe/TeamFlow) (Actions tab & `.github/workflows/deploy-python-service.yml`)
4. ☁️ **Google Cloud Console**: Secret Manager & Workload Identity Federation page

---

## 🎬 Live Demo Script — The 4-Act Structure

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        THE 4-ACT DEMO STRUCTURE                        │
│                                                                        │
│  Act 1: Executive Hook & Architecture Overview           (2 Mins)      │
│  Act 2: Live Resume Upload & Reliable Pipeline           (4 Mins)      │
│  Act 3: LangGraph, MCP Tools & Supabase Context          (3 Mins)      │
│  Act 4: Cloud Infrastructure & WIF CI/CD Pipeline        (2 Mins)      │
└────────────────────────────────────────────────────────────────────────┘
```

---

### 🎙️ Act 1: Executive Hook & Architecture Overview (2 Mins)

#### 💬 What to Say:
> *"Hi [Interviewer Name]! Today I want to demonstrate **TeamFlow** — an enterprise AI-powered hiring platform built specifically for high-turnover service businesses like specialty coffee shops and restaurants.*
> 
> *Instead of putting every responsibility behind one prompt, I built a hybrid architecture:*
> - *A deterministic upload pipeline separates document extraction, structured scoring, and persistence so the core workflow remains predictable.*
> - *A separate LangGraph service handles optional conversational hiring analysis through explicit, inspectable nodes.*
> - *LangChain connects the graph to Gemini and a private FastMCP process exposing narrowly scoped Supabase tools.*
> - * **Infrastructure**: Supabase Postgres integration, OpenTelemetry instrumentation, and keyless GCP Workload Identity Federation configuration in CI/CD.*
> 
> *Let me share my screen and verify the parts of the pipeline running in this environment."*

---

### 🚀 Act 2: Live Candidate Upload & Reliable Pipeline (4 Mins)

#### 🖱️ Screen-Share Action:
1. Share screen showing **TeamFlow Web App** (`http://localhost:3000`).
2. Click **"Upload Resume"** (or drag & drop a sample Barista PDF resume into the hiring pipeline).
3. Switch your window layout so the **Terminal Logs** are visible alongside the browser.

#### 💬 What to Say while uploading:
> *"When a manager uploads a candidate resume, it triggers a deterministic three-stage pipeline:*
> 
> 1. **Document processor (port 8000)** accepts raw document bytes, performs extraction, and returns clean text plus an embedding when available, with explicit degraded provenance otherwise.
> 2. **Structured scorer (Next.js)** evaluates that text against role dealbreakers and essential skills, returning a validated fit score and analysis.
> 3. **Server-side persistence** writes the validated candidate through Supabase without exposing its service-role credential.*
>
> *Let's look at our microservice logs in real-time:"*

#### 🔍 Point to Terminal Logs:

Use the actual logs from the current run. The following shows the fields to explain;
the identifiers, timing, candidate, and score are illustrative rather than claimed
observed values.

```text
[Pipeline] started — inputType: inline, roleId: barista, requestId: <uuid>
[DocumentProcessor] extractionStatus: complete|degraded, method: pdf_text|gemini_vision
[Scorer] token_usage — inputTokens: <observed>, outputTokens: <observed>
[Pipeline] completed — elapsedMs: <observed>, score: <validated score>
```

#### 💡 Key Architectural Highlight to Stress:
> *"The core path intentionally is not autonomous. Extraction, scoring, validation, and persistence have explicit boundaries, so failures are observable and the application can reject malformed model output before it reaches the database. The agent is a separate enhancement, not a dependency of resume processing."*

---

### ⚡ Act 3: LangGraph, MCP Boundaries & Supabase Context (3 Mins)

#### 🖱️ Screen-Share Action:
1. Switch to your **Supabase Dashboard** tab.
2. Open the `candidates` table and show the newly inserted candidate record.
3. Point to **Terminal 3 (the separate LangGraph service on port 8080)**.

#### 💬 What to Say:
> *"The hiring service contains two deliberately separate contracts. The legacy
> generic `/invoke` path supports conversational review and search. The Phase 4
> `/v1/resume-reviews` path is the narrower two-agent design: Agent 1 classifies
> configured criteria with literal source references, application code owns score
> math and ranking, and Agent 2 receives only validated unknown gaps.*
> 
> *Instead of dumping database schemas into prompts, the legacy path exposes four
> read-only operations:*
> - `get_job_requirements(role_id, merchant_id)`
> - `get_candidate(candidate_id, merchant_id)`
> - `list_candidates(merchant_id, status_filter, limit)`
> - `semantic_search_candidates(query, merchant_id, top_k, threshold)`
>
> *Candidate score mutation is deliberately absent from FastMCP. Legacy explicit-write
> requests fail closed; only an authenticated Phase 6 human decision may change a
> durable candidate score.*
> 
> *The Phase 4 path uses a separate read-only MCP surface with only
> `get_resume_document` and `load_active_role_policies`. Neither model receives a
> tool, and optional review persistence happens deterministically after validation.
> Agent 1 failure returns review-required; Agent 2 failure preserves Agent 1 with
> degraded questions. These behaviors are locally tested with scripted models and
> HTTP mocks. I do not present a live Supabase/model run unless I have verified it in
> this environment, and literal quote membership is not semantic entailment."*

---

### 🛡️ Act 4: Enterprise GCP Infrastructure & WIF CI/CD (2 Mins)

#### 🖱️ Screen-Share Action:
1. Switch to the **GitHub Actions tab** (`deploy-python-service.yml`).
2. Briefly open **Google Cloud Console** (Secret Manager & Workload Identity Pools).

#### 💬 What to Say:
> *"Finally, let's look at our cloud infrastructure and deployment security.*
> 
> *In traditional CI/CD pipelines, teams may store static GCP service-account key files inside GitHub secrets. TeamFlow's workflows instead request short-lived credentials through **Workload Identity Federation (WIF)**.*
> 
> *The checked-in workflows request a GitHub OIDC token and are configured to exchange it through the WIF provider and service account stored as repository secrets before deploying to Cloud Run. The YAML proves the intended keyless design; I verify the provider trust, IAM bindings, secrets, and successful revision in the Google and GitHub consoles before calling the deployment live."*

---

## 🏆 Interviewer Q&A Cheat Sheet (Prepared Responses)

### Q1: "Why separate the processor from the LangGraph workflow?"
> **Answer**: *"They have different reliability and scaling needs. Resume processing is a bounded request pipeline that should remain available if conversational analysis is unhealthy. The LangGraph service is an optional capability with explicit tool and recovery boundaries. Next.js keeps a small validated adapter contract between the browser and that service."*

### Q2: "Which Gemini models are used and how do you handle rate limits?"
> **Answer**: *"Complete digital PDFs are extracted deterministically with pinned `pypdf`; scanned, mixed, and image inputs use the document processor's `gemini-3.1-pro-preview` transcription model. The structured scorer defaults to the same Gemini model. The separate LangGraph service defaults to `gemini-3.7-flash`, with `gemini-3.6-flash` as a bounded fallback for transient provider failures. Extraction and scoring cross separate typed validation boundaries, and the repository defaults plus embedding contract are checked by a static drift gate. The local scanned tests prove routing and failure behavior, not live OCR accuracy."*

### Q3: "How is observability handled across microservices?"
> **Answer**: *"The code is instrumented to propagate W3C trace context from the Next.js API into the document processor and to add spans around scoring and persistence. Local tests verify the Next.js-to-OCR propagation boundary. Spans use safe operational metadata rather than résumé text, contact details, prompts, or model responses. I only describe a complete Cloud Trace waterfall as verified after observing it in the deployed environment."*

---

## 🎯 Pre-Demo Checklist

- [ ] Next.js Web App Active (`http://localhost:3000`)
- [ ] Python Document Processor Active (`http://localhost:8000`)
- [ ] LangGraph Hiring Workflow Active (`http://localhost:8080`, when demonstrating the optional agent path)
- [ ] Supabase connection, schema, grants, and tenant behavior verified
- [ ] WIF provider, IAM bindings, secrets, workflow, and deployed revision verified
