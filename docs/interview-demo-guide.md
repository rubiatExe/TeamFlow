# 🎯 TeamFlow — Interviewer Zoom Screen-Share Demo Guide

> **Target Audience**: Technical Recruiters, Engineering Managers, Principal Engineers  
> **Estimated Demo Duration**: 10–12 Minutes  
> **Key Objective**: Wow the interviewer by demonstrating production-grade software engineering, sequential multi-agent AI architecture, live database interactions, Model Context Protocol (MCP), and enterprise GCP CI/CD.

---

## 📋 Pre-Call Preparation Checklist (2 Minutes Before Zoom)

Make sure you have the following open and ready before sharing your screen:

### 1. Terminal Windows (Arranged Side-by-Side or Tabs)
- **Terminal 1 (Next.js App)**: `npm run dev` running on `http://localhost:3000`
- **Terminal 2 (Python Service)**: `uvicorn main:app --port 8000` (Agent 1: OCR)
- **Terminal 3 (FastMCP Server)**: `python mcp_server.py` (Port 8001)

### 2. Browser Tabs (Left-to-Right Order)
1. 🌐 **TeamFlow Web App**: `http://localhost:3000` (Dashboard / Candidate Upload)
2. 🗄️ **Supabase Dashboard**: Table Editor (`candidates` & `applications` tables)
3. 🐙 **GitHub Repository**: [rubiatExe/TeamFlow](https://github.com/rubiatExe/TeamFlow) (Actions tab & `.github/workflows/deploy-python-service.yml`)
4. ☁️ **Google Cloud Console**: Secret Manager & Workload Identity Federation page

---

## 🎬 Step-by-Step Live Demo Script

```
   ┌────────────────────────────────────────────────────────────────────────┐
   │                        THE 4-ACT DEMO STRUCTURE                        │
   │  Act 1: Executive Elevator Pitch & Architecture Overview (2 mins)      │
   │  Act 2: Live Candidate Upload & Multi-Agent Execution (4 mins)         │
   │  Act 3: FastMCP Tool Server & Real-Time Supabase Sync (3 mins)         │
   │  Act 4: Cloud Infrastructure & WIF CI/CD Pipeline (2 mins)            │
   └────────────────────────────────────────────────────────────────────────┘
```

---

### 🎙️ Act 1: Executive Elevator Pitch & Architecture (2 Mins)

#### 💬 What to Say:
> *"Hi [Interviewer Name]! Today I want to walk you through **TeamFlow** — an enterprise AI-powered hiring platform designed for high-turnover service businesses like specialty coffee shops and restaurants.*
> 
> *Rather than building a monolithic LLM wrapper, I engineered TeamFlow using a **Sequential Multi-Agent Architecture** with **FastMCP** for dynamic context retrieval, connected to a live **Supabase Postgres** backend with **OpenTelemetry** observability, and automated via **GCP Workload Identity Federation** in CI/CD.*
> 
> *Let me share my screen and show you how it works in real-time."*

---

### 🚀 Act 2: Live Candidate Upload & Multi-Agent Execution (4 Mins)

#### 🖱️ Screen-Share Action:
1. Share screen showing **TeamFlow Web App** (`http://localhost:3000`).
2. Click **"Upload Resume"** or drag & drop a sample PDF/resume into the Barista hiring queue.
3. Keep your terminal logs visible on the side (or switch to terminal right after uploading).

#### 💬 What to Say while uploading:
> *"When a manager uploads a candidate resume, it triggers our two-stage **Sequential Multi-Agent Pipeline**:*
> 
> 1. **Agent 1 (OCR Extractor Microservice)**: A high-throughput Python FastAPI service running on port 8000. It accepts raw document bytes and calls Gemini Vision AI to perform OCR, returning clean, un-evaluated markdown.
> 2. **Agent 2 (Semantic Evaluation Engine)**: Receives only the clean text from Agent 1 (never touching raw PDF bytes), evaluates the candidate against specific job dealbreakers, essential skills, and commute logistics, and generates a structured fit score.*
>
> *Let's look at the terminal logs in real-time:"*

#### 🔍 Point to Terminal Logs:
```text
[Pipeline] START — file: Alice_Barista_Resume.txt, role: Barista
[Pipeline] Agent 1 (OCR) complete. Mock=false, chars=436
[Pipeline] Agent 2 (Scorer) using model: gemini-2.5-pro
[Pipeline] Agent 2 (Scorer) tokens — input: 888, output: 268
[Pipeline] COMPLETE — 9263ms | candidate: Alice Barista | score: 88
```


#### 💡 Key Highlight to Stress:
> *"Notice the clear separation of concerns: Agent 1 does zero scoring—it purely extracts structured text. Agent 2 does zero OCR—it receives clean text and focuses 100% of its context window on semantic reasoning and scoring. This multi-agent split dramatically reduces hallucination rates and optimizes token costs."*

---

### ⚡ Act 3: FastMCP Tool Access & Real-Time Supabase Sync (3 Mins)

#### 🖱️ Screen-Share Action:
1. Switch to your **Supabase Dashboard** tab (or run candidate status update in the app).
2. Show the newly inserted candidate row in the `candidates` table.
3. Point to the **FastMCP Server** running in Terminal 3 (Port 8001).

#### 💬 What to Say:
> *"Now let's look at how the LLM interacts with our database using **FastMCP (Model Context Protocol)** on port 8001.*
> 
> *Instead of hardcoding huge database dumps directly into prompt strings, TeamFlow exposes secure Supabase tools to the LLM agent via MCP:*
> - `get_job_requirements(role_id)`
> - `get_candidate(candidate_id)`
> - `update_fit_score(candidate_id, score, analysis)`
> 
> *The AI dynamically decides which database tool to invoke at runtime. Furthermore, all database operations are secured via Supabase Row-Level Security (RLS) policies, enforcing multi-tenant isolation across merchants."*

---

### 🛡️ Act 4: Enterprise GCP Infrastructure & WIF CI/CD (2 Mins)

#### 🖱️ Screen-Share Action:
1. Switch to **GitHub Actions tab** (`deploy-python-service.yml`).
2. Briefly open **Google Cloud Console** (Secret Manager / Workload Identity Pools).

#### 💬 What to Say:
> *"Finally, let's talk production deployment and security infrastructure.*
> 
> *In traditional CI/CD pipelines, engineers store long-lived GCP service account JSON key files inside GitHub secrets—which is a major security risk if leaked. In TeamFlow, I implemented **Keyless Workload Identity Federation (WIF)**.*
> 
> *GitHub Actions requests a short-lived OIDC token from `token.actions.githubusercontent.com`. Google Cloud's `teamflow-pool` verifies the token's cryptographic signature and repository identity (`rubiatExe/TeamFlow`), impersonating `teamflow-deployer` service account to pull secrets from Google Secret Manager and deploy to Cloud Run automatically—with **zero long-lived credentials stored anywhere**."*

---

## 🏆 Interviewer Q&A Cheat Sheet (Prepared Responses)

### Q1: "Why use Python for Agent 1 and Next.js for Agent 2?"
> **Answer**: *"Python is the industry standard for document parsing, PDF handling, and vision models (FastAPI + `google-genai`). Next.js with React Server Components provides an ultra-fast full-stack web UI with low latency API routes. Keeping Agent 1 as an independent microservice allows us to scale OCR workers independently on Cloud Run based on upload volume."*

### Q2: "How do you handle API rate limits or LLM downtime?"
> **Answer**: *"We built multi-tier model fallbacks (`gemini-3.6-flash` → `gemini-2.5-flash` → `gemini-2.0-flash`) and graceful fallback evaluations. If a model hits a 429 quota, the pipeline seamlessly degrades without throwing a 500 error to the end user."*

### Q3: "How is observability handled across microservices?"
> **Answer**: *"We instrumented both microservices with **OpenTelemetry (OTel) GenAI Semantic Conventions**. Every extraction span tracks `gen_ai.system`, `gen_ai.operation.name`, and token usage counters (`gen_ai.client.token.usage`), which can be exported directly to Google Cloud Trace and Monitoring."*

---

## 🎯 Summary Checklist

- [x] Web App Running (`http://localhost:3000`)
- [x] Agent 1 OCR Running (`http://localhost:8000`)
- [x] FastMCP Server Running (`http://localhost:8001`)
- [x] Live Supabase Database Connected & RLS Enabled
- [x] Keyless WIF Secrets & CI/CD Configured in GitHub
