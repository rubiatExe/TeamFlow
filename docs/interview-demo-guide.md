# 🎯 TeamFlow — Ultimate Interview Zoom Screen-Share Demo Guide

> **Target Audience**: Technical Recruiters, Engineering Managers, Staff/Principal Engineers  
> **Estimated Demo Duration**: 10–12 Minutes  
> **Key Objective**: Deliver an unforgettable live screen-share demonstrating production-grade software engineering, sequential multi-agent AI architecture, FastMCP tool servers, real-time Supabase Postgres with RLS, OpenTelemetry observability, and keyless GCP Workload Identity Federation (WIF).

---

## 📋 Pre-Call Setup (2 Minutes Before Zoom)

Ensure your desktop is organized cleanly with no personal notifications before starting screen-share.

### 1. Terminal Windows (Split Screen / 3 Tabs)
- **Terminal 1 (Next.js Core Web App)**: `npm run dev` running on `http://localhost:3000`
- **Terminal 2 (Python OCR Microservice)**: `uvicorn main:app --port 8000` (Agent 1)
- **Terminal 3 (FastMCP Tool Server)**: `python mcp_server.py` (Port 8001)

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
│  Act 2: Live Resume Upload & Multi-Agent Execution       (4 Mins)      │
│  Act 3: FastMCP Tool Server & Real-Time Supabase Sync    (3 Mins)      │
│  Act 4: Cloud Infrastructure & WIF CI/CD Pipeline        (2 Mins)      │
└────────────────────────────────────────────────────────────────────────┘
```

---

### 🎙️ Act 1: Executive Hook & Architecture Overview (2 Mins)

#### 💬 What to Say:
> *"Hi [Interviewer Name]! Today I want to demonstrate **TeamFlow** — an enterprise AI-powered hiring platform built specifically for high-turnover service businesses like specialty coffee shops and restaurants.*
> 
> *Instead of building a simple monolithic wrapper around an LLM API, I architected TeamFlow as a production **Sequential Multi-Agent System**:*
> - * **Agent 1**: High-throughput Python microservice dedicated to multimodal document extraction.*
> - * **Agent 2**: Next.js semantic reasoning engine evaluating candidates against job dealbreakers and essential skills.*
> - * **FastMCP**: Model Context Protocol tool server allowing the AI agent to query live database context via dynamic function calling.*
> - * **Infrastructure**: Live Supabase Postgres with RLS, OpenTelemetry observability, and keyless GCP Workload Identity Federation in CI/CD.*
> 
> *Let me share my screen and show you the pipeline running live in real-time."*

---

### 🚀 Act 2: Live Candidate Upload & Multi-Agent Execution (4 Mins)

#### 🖱️ Screen-Share Action:
1. Share screen showing **TeamFlow Web App** (`http://localhost:3000`).
2. Click **"Upload Resume"** (or drag & drop a sample Barista PDF resume into the hiring pipeline).
3. Switch your window layout so the **Terminal Logs** are visible alongside the browser.

#### 💬 What to Say while uploading:
> *"When a manager uploads a candidate resume, it triggers our two-stage **Sequential Multi-Agent Pipeline**:*
> 
> 1. **Agent 1 (OCR Extractor Microservice - Port 8000)**: Accepts raw document bytes, calls Gemini Vision AI, and performs OCR extraction to output clean markdown text.
> 2. **Agent 2 (Semantic Evaluation Engine - Port 3000)**: Receives the clean markdown (never touching raw PDF bytes), evaluates the candidate against role dealbreakers, essential skills, and commute logistics, and outputs a structured fit score (0–100).*
>
> *Let's look at our microservice logs in real-time:"*

#### 🔍 Point to Terminal Logs:
```text
[Pipeline] START — file: Alice_Barista_Resume.txt, role: Barista
[Pipeline] Agent 1 (OCR) complete. Mock=false, chars=436
[Pipeline] Agent 2 (Scorer) using model: gemini-2.0-flash
[Pipeline] Agent 2 (Scorer) tokens — input: 888, output: 268
[Pipeline] COMPLETE — 1114ms | candidate: Alice Barista | score: 78
```

#### 💡 Key Architectural Highlight to Stress:
> *"Notice the strict separation of concerns: Agent 1 does zero scoring—it purely extracts raw text. Agent 2 does zero OCR—it receives clean markdown and focuses 100% of its context window on semantic reasoning and scoring. This multi-agent split dramatically reduces hallucination rates and optimizes token costs."*

---

### ⚡ Act 3: FastMCP Tool Server & Real-Time Supabase Sync (3 Mins)

#### 🖱️ Screen-Share Action:
1. Switch to your **Supabase Dashboard** tab.
2. Open the `candidates` table and show the newly inserted candidate record.
3. Point to **Terminal 3 (FastMCP Server running on port 8001)**.

#### 💬 What to Say:
> *"Now let's look at how our AI agent interacts with the live database using **FastMCP (Model Context Protocol)** on port 8001.*
> 
> *Instead of dumping large database schemas directly into prompt strings, TeamFlow exposes secure Supabase tools to the agent via MCP:*
> - `get_job_requirements(role_id)`
> - `get_candidate(candidate_id)`
> - `update_fit_score(candidate_id, score, analysis)`
> 
> *The AI agent dynamically decides which tool to invoke at runtime. Furthermore, all database operations are secured via Supabase Row-Level Security (RLS) policies, enforcing multi-tenant isolation across merchants."*

---

### 🛡️ Act 4: Enterprise GCP Infrastructure & WIF CI/CD (2 Mins)

#### 🖱️ Screen-Share Action:
1. Switch to the **GitHub Actions tab** (`deploy-python-service.yml`).
2. Briefly open **Google Cloud Console** (Secret Manager & Workload Identity Pools).

#### 💬 What to Say:
> *"Finally, let's look at our cloud infrastructure and deployment security.*
> 
> *In traditional CI/CD pipelines, teams store static GCP service account JSON key files inside GitHub secrets—which creates a major security vulnerability if compromised. In TeamFlow, I implemented **Keyless Workload Identity Federation (WIF)**.*
> 
> *GitHub Actions requests a short-lived OIDC token from GitHub (`token.actions.githubusercontent.com`). Google Cloud's `teamflow-pool` verifies the token's cryptographic signature and repository identity (`rubiatExe/TeamFlow`), impersonating `teamflow-deployer` service account to pull secrets from Google Secret Manager and deploy to Cloud Run automatically—with **zero long-lived credentials stored anywhere**."*

---

## 🏆 Interviewer Q&A Cheat Sheet (Prepared Responses)

### Q1: "Why use Python for Agent 1 and Next.js for Agent 2?"
> **Answer**: *"Python is the industry standard for document parsing and vision models (FastAPI + `google-genai`). Next.js with React Server Components provides an ultra-fast full-stack web UI with low latency API routes. Keeping Agent 1 as an independent microservice allows us to scale OCR workers independently on Cloud Run based on upload volume."*

### Q2: "Which Gemini models are used and how do you handle rate limits?"
> **Answer**: *"We target `gemini-2.0-flash` / `gemini-2.5-flash` for low-latency scoring and support `gemini-2.5-pro` for deep reasoning. We built a multi-tier fallback system with graceful degradation—if an API quota limit occurs (429), TeamFlow seamlessly falls back to structured evaluation without throwing a 500 error to the end user."*

### Q3: "How is observability handled across microservices?"
> **Answer**: *"We instrumented both microservices with **OpenTelemetry (OTel) GenAI Semantic Conventions**. Every extraction span tracks `gen_ai.system`, `gen_ai.operation.name`, and token usage counters (`gen_ai.client.token.usage`), which can be exported directly to Google Cloud Trace and Monitoring."*

---

## 🎯 Pre-Demo Checklist

- [x] Next.js Web App Active (`http://localhost:3000`)
- [x] Python Agent 1 OCR Active (`http://localhost:8000`)
- [x] FastMCP Server Active (`http://localhost:8001`)
- [x] Supabase Live Database Connected & RLS Enabled
- [x] Keyless WIF Secrets & GitHub Actions CI/CD Configured
