# Resume Technology Guide

This guide explains every major technology and technical concept named in
Rubiat Bin Faisal's supplied resume, then shows how those technologies work
together within each project and professional experience.

## Quick stack map

| Area | Technologies and concepts |
|---|---|
| AI systems | Generative AI, large language models, Gemini APIs, OpenAI API, multi-agent systems, sequential pipelines |
| Retrieval and evaluation | RAG, embeddings, pgvector, LLM-as-a-judge, context relevance, groundedness, golden datasets, low-temperature generation |
| Agent integration | Model Context Protocol, FastMCP |
| Backend | Python, FastAPI, microservices, background services |
| Frontend and full stack | TypeScript, React, Next.js, Mantine, state management |
| Data | PostgreSQL, Google Cloud SQL, Prisma ORM, SQL, structured JSON |
| Cloud and delivery | Google Cloud, Vercel, GitHub, GitHub Actions, CI/CD, Workload Identity Federation, OIDC |
| Observability | OpenTelemetry, GenAI Semantic Conventions, Google Cloud Trace |
| Interfaces and documents | Slack, Slack Block Kit, LaTeX |
| Development assistance | Claude Code, Antigravity |

## Master glossary

### Generative AI

Generative AI describes models that create new content such as text, code,
images, summaries, classifications, or structured data. In the resume's
projects, generative models interpret application material, generate structured
evaluations, tailor documents, and support contextual retrieval.

### Large language model

A large language model, or LLM, is a neural model trained on large text and code
datasets. It predicts and generates language based on instructions and context.
Gemini and the models accessed through the OpenAI API are LLMs.

An LLM is probabilistic, so application code must validate its output rather
than treating it like a deterministic database query.

### Gemini model roles

Gemini is Google's family of multimodal generative models. Multimodal means a
model can work with more than plain text, including document and image inputs.

Within TeamFlow, the document processor and structured scorer default to
`gemini-3.1-pro-preview`. The separate LangGraph service defaults to
`gemini-3.7-flash` with a bounded `gemini-3.6-flash` fallback. Embeddings use
`gemini-embedding-001`. The machine-readable working-tree contract is
`config/ai-model-contract.json`; deployed environment overrides must be verified
separately.

### OpenAI API

The OpenAI API provides programmatic access to OpenAI language models. The
Mentessa experience used it to add contextual knowledge retrieval to a
corporate Slack workflow.

### Multi-agent system

A multi-agent system divides a larger AI task among specialized agents. Each
agent has a narrower responsibility, instructions, tools, and output contract.

For the TeamFlow interview scenario:

- Agent 1 classifies résumé evidence across configured roles; deterministic application
  code scores, ranks, and selects the best-supported position.
- Agent 2 reads Agent 1's validated gaps and generates targeted follow-up
  questions.

### Sequential pipeline

A sequential pipeline executes stages in a required order. The next stage does
not run until the preceding stage completes and its output passes validation.

Example:

```text
OCR extraction
-> Agent 1 evaluation
-> deterministic validation
-> Agent 2 question generation
-> versioned API response (no Phase 4 UI caller yet)
```

This is easier to test and audit than allowing an LLM to choose an arbitrary
execution order.

### Neural OCR and document extraction

Optical character recognition converts text in images or scanned documents into
machine-readable text. A neural or multimodal extraction layer uses a learned
vision model to interpret document content and layout.

In TeamFlow, document extraction is intentionally separated from semantic
evaluation. Extraction answers "what does the resume contain?" while the
evaluation layer answers "how does this evidence relate to a role?"

### Model Context Protocol

Model Context Protocol, or MCP, is a standard way for AI clients and agents to
discover and invoke tools, resources, and external capabilities.

Instead of giving an agent direct database access, an MCP server can expose
narrow operations such as:

- Get configured job requirements.
- Retrieve a candidate.
- Search candidates semantically.
- Update a score only when writes are explicitly enabled.

### FastMCP

FastMCP is a Python framework for building MCP servers. Typed Python functions
become discoverable agent tools with named parameters and structured results.

TeamFlow uses a custom FastMCP server rather than a general Supabase MCP server.
That design keeps database credentials and arbitrary SQL away from the agent
and exposes only TeamFlow-specific business operations.

### Retrieval-Augmented Generation

Retrieval-Augmented Generation, or RAG, retrieves relevant information from an
external knowledge source before asking an LLM to answer. The retrieved
evidence is added to the model context so the answer is grounded in current,
domain-specific data.

A typical flow is:

```text
User query
-> query embedding
-> vector and keyword retrieval
-> relevant evidence
-> LLM response grounded in that evidence
```

### Embedding

An embedding is a numeric vector representing the semantic meaning of text.
Texts with similar meanings should produce vectors that are close in the
embedding space.

Embeddings are useful for retrieval and ranking; they are not themselves an
explanation or a hiring decision.

### pgvector

pgvector is a PostgreSQL extension for storing embeddings and calculating
vector similarity. It enables semantic search inside PostgreSQL.

TeamFlow stores resume embeddings in pgvector and uses cosine similarity to
find candidates whose resumes are semantically related to a search query.

### LLM-as-a-judge

LLM-as-a-judge uses one language-model call to evaluate another generated
output against a rubric.

The Managify project uses this approach to score outputs for context relevance
and groundedness. It is more flexible than exact string matching, but it is
still probabilistic and should be calibrated against human-reviewed examples.

### Context relevance

Context relevance measures whether the retrieved or supplied context actually
helps answer the request. Irrelevant context increases prompt size and can
distract the model.

### Groundedness

Groundedness measures whether a generated claim is supported by the supplied
evidence. A grounded response should not invent facts that are absent from its
context.

### Golden dataset

A golden dataset is a curated collection of inputs and trusted expected
behaviors or outputs. It is used to detect regressions and compare prompts,
models, retrieval strategies, and system versions.

### Low-temperature model configuration

Temperature controls randomness in model generation. A low temperature makes
responses more consistent and is useful for evaluation, extraction, scoring,
and structured JSON.

Low temperature improves repeatability but does not guarantee truth or
fairness.

### OpenTelemetry

OpenTelemetry is an open standard and SDK ecosystem for collecting traces,
metrics, and logs from distributed systems.

In an AI workflow it can show the complete request path across document
processing, model calls, agent runs, MCP tools, and database operations.

### OpenTelemetry GenAI Semantic Conventions

GenAI Semantic Conventions define consistent names for AI-related telemetry
such as:

- Model provider and model name.
- Operation name.
- Input and output token usage.
- Duration.
- Error status.

They make AI telemetry easier to query across services and model providers.

### Google Cloud Trace

Google Cloud Trace collects and visualizes distributed traces. A trace shows
how one request moves through multiple services and where latency or failure
occurs.

TeamFlow configures OpenTelemetry exporters for Google Cloud Trace so document
processing and model operations can appear in a request waterfall. A live export
and complete waterfall still require environment-level verification.

### Workload Identity Federation

Workload Identity Federation, or WIF, allows an external workload such as
GitHub Actions to authenticate to Google Cloud without storing a permanent
Google service-account key.

GitHub presents a short-lived identity token. Google verifies its issuer and
repository claims, then permits narrowly scoped service-account impersonation.

### OpenID Connect

OpenID Connect, or OIDC, is an identity layer built on OAuth 2.0. GitHub Actions
uses OIDC to issue a signed, short-lived token containing workflow identity
claims.

In TeamFlow, OIDC is the credential GitHub exchanges through Google Workload
Identity Federation.

### GitHub Actions

GitHub Actions is GitHub's workflow automation and CI/CD system. Workflows can
test, build, and deploy code after repository events such as a push or pull
request.

### CI/CD

Continuous integration and continuous delivery automate code validation and
deployment. CI runs checks such as tests and builds. CD promotes validated
software to a runtime such as Google Cloud Run or Vercel.

### Service-account JSON key

A service-account JSON key is a long-lived private credential for a Google
Cloud identity. If copied or leaked, it can remain usable until revoked.

The TeamFlow deployment design replaces these files with short-lived
OIDC/WIF credentials.

### Google Cloud

Google Cloud is a cloud-computing platform providing compute, networking,
managed databases, identity, observability, and AI services.

The resume specifically mentions Google Cloud Trace and Google Cloud SQL.

### Google Cloud SQL

Google Cloud SQL is a managed relational-database service. Google handles
infrastructure tasks such as provisioning, backups, patching, and availability
while the application uses a standard database engine.

Managify uses Google Cloud SQL to host its relational application state.

### PostgreSQL

PostgreSQL is an open-source relational database. It supports transactions,
constraints, joins, indexes, SQL, and extensions such as pgvector.

Both TeamFlow and Managify use PostgreSQL-related technology for durable,
queryable state.

### SQL

Structured Query Language is used to retrieve and modify relational data.
Optimized SQL reduces unnecessary work, improves latency, and helps enforce
correct tenant filtering.

### Prisma ORM

Prisma is a TypeScript object-relational mapper and database toolkit. It
generates a typed client from a schema, allowing a TypeScript application to
work with database records through typed methods instead of manually composing
every SQL query.

Prisma does not replace the database. It sits between application code and
PostgreSQL.

### Python

Python is a general-purpose programming language with a strong AI, data,
automation, and backend ecosystem.

The resume uses Python for AI services, FastAPI/FastMCP servers, background
processing, and LaTeX compilation.

### FastAPI

FastAPI is a Python web framework for building typed HTTP APIs. It supports
asynchronous endpoints, request validation, file uploads, authentication
dependencies, error responses, and automatic OpenAPI documentation.

In the TeamFlow architecture, FastAPI is the HTTP boundary for Python
microservices. FastMCP is a different boundary: it exposes tools to agents.

### Microservice

A microservice is a separately deployable service with a focused
responsibility. Separating heavy or specialized work from the frontend allows
independent deployment, scaling, failure handling, and observability.

### Background service

A background service handles work outside the interactive frontend request
path. Managify uses a Python background service for LaTeX compilation so the
Next.js interface does not perform heavy document processing.

### TypeScript

TypeScript adds static types to JavaScript. It helps catch incorrect data shapes
during development and improves editor tooling and refactoring safety.

The resume uses TypeScript in React and Next.js applications and for consuming
structured backend or LLM responses.

### React

React is a component-based JavaScript UI library. It represents interfaces as
reusable components whose rendering responds to state and properties.

### Next.js

Next.js is a React framework that adds routing, server rendering, API routes,
server components, bundling, and deployment conventions.

In Managify, Next.js provides the product interface and TypeScript application
layer around AI workflows and relational data.

### State management

State management controls data that changes while an application runs, such as
form values, server data, loading states, and UI selections.

Custom state management provides exact control but requires more code.
Off-the-shelf libraries provide tested patterns but introduce dependencies and
framework constraints.

### Mantine

Mantine is a React component library and hooks ecosystem. It provides reusable
interface components, styling primitives, and common interaction patterns.

The stealth-startup experience combined custom state logic with Mantine
components to accelerate product delivery.

### Structured JSON

JSON is a structured text format for objects, arrays, strings, numbers,
booleans, and null values.

LLM-generated JSON is easier for application code to validate and render than
unstructured prose, but it still needs runtime schema validation.

### Slack

Slack is a workplace communication platform. Applications can participate
through APIs, events, commands, messages, and interactive components.

### Slack Block Kit

Slack Block Kit is Slack's structured UI framework for composing messages and
interactive surfaces from blocks such as sections, buttons, fields, and
context elements.

The Mentessa experience used it to convert structured AI results into a
reliable Slack interface.

### LaTeX

LaTeX is a document-preparation and typesetting system. Source markup is
compiled into a polished document, commonly PDF.

Compilation can be CPU-intensive and depends on a separate toolchain, which is
why Managify isolates it in a Python background service.

### Vercel

Vercel is a deployment platform commonly used for Next.js and frontend
applications. Both project URLs in the resume use Vercel-hosted domains.

### GitHub

GitHub hosts Git repositories and supports collaboration, pull requests, issue
tracking, and automation through GitHub Actions. The resume links to the
TeamFlow and Managify repositories.

### Claude Code

Claude Code is an AI-assisted software-development tool that can inspect a
codebase, modify files, run commands, and help implement engineering tasks.

### Antigravity

Antigravity is listed in the Managify development stack as an AI-assisted
development environment or workflow tool. In the context of the resume, it
supports implementation productivity rather than serving as part of the
runtime application architecture.

## Experience 1: TeamFlow

### Technologies explicitly connected to this experience

- Python
- FastAPI
- FastMCP
- MCP
- Gemini APIs
- pgvector
- PostgreSQL
- Sequential multi-agent pipelines
- Neural OCR/document extraction
- OpenTelemetry
- OpenTelemetry GenAI Semantic Conventions
- Google Cloud Trace
- Workload Identity Federation
- OIDC
- GitHub Actions
- CI/CD
- GitHub
- Vercel-hosted application

### How the technologies work together

```text
Resume upload
-> Python/FastAPI document service
-> MIME/signature/size validation
-> deterministic pypdf text for complete digital PDFs
-> Gemini vision only for scanned, mixed, or image input
-> typed canonical text and source blocks
-> embedding generation
-> PostgreSQL + pgvector
-> sequential agent evaluation
-> FastMCP loaders for configured database operations
-> structured result
-> versioned API response
```

The separation of responsibilities is:

- FastAPI exposes the Python service over HTTP.
- `pypdf` extracts text deterministically when every PDF page has usable text and
  bounded content inspection finds no image-dominant or non-painting text layer;
  Gemini interprets scanned, mixed, or image documents.
- The sequential workflow separates extraction from semantic evaluation.
- PostgreSQL stores relational candidate data.
- pgvector stores embeddings for semantic candidate search.
- FastMCP exposes narrow database capabilities through MCP. The Phase 4 review
  orchestrator uses two read-only loaders; neither review model receives a tool.
- OpenTelemetry instrumentation records selected safe spans and operational metadata.
- Google Cloud Trace export is configured but no live distributed trace was verified.

The deployment-security flow is:

```text
GitHub Actions
-> short-lived GitHub OIDC token
-> Google Workload Identity Federation
-> temporary service-account impersonation
-> Google Cloud deployment
```

This avoids storing a permanent Google service-account JSON key in the
repository.

### Phase 4 Agent 1 and Agent 2 relationship

- Agent 1 reads a validated extraction snapshot and configured job criteria, then classifies
  each criterion and attaches source evidence without producing a numeric score.
- Deterministic application logic validates IDs and literal quote membership, applies configured criterion
  weights, ranks eligible roles, and recommends the best-supported role.
- Agent 2 reads only the recommended role's validated unknown gaps and generates targeted,
  job-related follow-up questions.
- MCP loaders provide configured external data; typed LangGraph state, not MCP, passes Agent 1
  output to Agent 2.

LangGraph and LangChain are relevant to the current repository, but they are not
explicitly named on the supplied PDF resume. In the locally tested Phase 4 design,
LangGraph manages sequencing and typed state while LangChain
provides Gemini structured output and MCP integration.

### Main architectural trade-offs

- Multiple services and agents improve isolation and testability but increase
  latency, cost, and operational complexity.
- Gemini handles varied documents but remains probabilistic.
- FastMCP improves least-privilege tool access but adds a protocol and
  subprocess to maintain.
- pgvector keeps semantic search close to relational data but requires
  embedding-version and index management.
- Observability improves debugging but must avoid recording resume PII.

## Experience 2: Managify

### Technologies explicitly connected to this experience

- Next.js
- TypeScript
- Python
- PostgreSQL
- Google Cloud SQL
- Prisma ORM
- Generative AI
- LLM-as-a-judge
- Context relevance
- Groundedness
- Golden dataset
- Low-temperature model configuration
- LaTeX
- Python background service
- Claude Code
- Antigravity
- GitHub
- Vercel-hosted application

### How the application technologies work together

```text
Next.js + TypeScript interface
-> typed application logic
-> Prisma ORM
-> PostgreSQL hosted in Google Cloud SQL
```

- Next.js provides the React application structure and server-side application
  capabilities.
- TypeScript protects contracts between UI, server code, and database access.
- Prisma maps TypeScript operations to relational queries.
- PostgreSQL stores job-board context, applicants, generated-document state,
  and workflow relationships.
- Google Cloud SQL manages the PostgreSQL infrastructure.

### How the AI evaluation technologies work together

```text
Job-board and applicant context
-> generation workflow
-> generated document
-> LLM-as-a-judge
-> context-relevance and groundedness scores
-> comparison with curated golden examples
```

- The generation workflow synthesizes job-board information and tailors
  applicant documentation.
- A low-temperature judge model scores the generated result consistently.
- Context relevance checks whether the source context was useful and
  appropriately applied.
- Groundedness checks whether claims are supported by source material.
- The golden dataset provides known examples for detecting regressions.

### How document compilation works

```text
Next.js requests document generation
-> Python background service
-> dynamic LaTeX source
-> LaTeX compiler
-> final document
-> result returned to application
```

The Python service isolates CPU-heavy compilation and external compiler
dependencies from the interactive Next.js process. This allows the UI to remain
responsive and allows compilation workers to scale independently.

### Development tooling

- Claude Code and Antigravity assist implementation and iteration.
- They are development-time tools, not runtime services used by end users.
- Their output still requires code review, testing, and repository controls.

### Main architectural trade-offs

- Prisma improves TypeScript productivity but can hide inefficient queries if
  developers do not inspect generated SQL.
- Cloud SQL reduces database operations work but costs more than a
  self-managed database.
- An LLM judge scales evaluation but can share biases with the generating model.
- A separate Python worker adds deployment complexity but protects UI latency.

## Experience 3: Software Engineer at a stealth startup

### Technologies and concepts connected to this experience

- React
- TypeScript
- Cloud-deployed LLM microservices
- Secure data-fetching pipelines
- SQL
- Access control and client isolation
- State management
- Mantine

### How the frontend technologies work together

```text
React components
-> TypeScript props and data contracts
-> application state
-> Mantine UI components
-> responsive user experience
```

- React divides the product interface into reusable components.
- TypeScript defines safe component and API data contracts.
- State management coordinates user input, loading, model responses, and UI
  transitions.
- Mantine supplies reusable interface components and hooks.
- Custom logic is used where the product requires behavior that a component
  library does not provide.

### How the frontend communicates with AI services

```text
React/TypeScript UI
-> authenticated data-fetching layer
-> cloud LLM microservice
-> structured response
-> controlled UI state update
```

- The frontend does not directly contain model credentials.
- Cloud services own model calls and sensitive backend operations.
- Access controls restrict which client can retrieve which data.
- SQL queries retrieve only the data required for the authenticated tenant.
- Structured responses make model output safer to render.

### Main architectural trade-offs

- Custom state management provides control but takes longer to build and test.
- Mantine accelerates delivery but can constrain visual and interaction design.
- LLM microservices isolate secrets and scaling but add network latency.
- Strict tenant filtering improves security but must be enforced on every data
  path, not only in the UI.

## Experience 4: Software Engineering Intern at Mentessa

### Technologies explicitly connected to this experience

- OpenAI API
- Slack
- Contextual knowledge retrieval
- React
- Slack Block Kit
- Structured JSON
- Frontend deployment

### How the retrieval workflow works

```text
Slack user request
-> Slack application/backend
-> relevant corporate context retrieval
-> OpenAI API
-> structured JSON response
-> Slack Block Kit rendering
```

- Slack is the user-facing collaboration environment.
- The backend receives a Slack event or interaction.
- Relevant corporate knowledge is retrieved and added to the model context.
- The OpenAI API generates a response based on the retrieved information.
- Structured JSON provides a predictable format for the UI layer.
- Slack Block Kit turns that structure into readable and interactive Slack
  messages.
- React components support related web or embedded interface surfaces.

### Why structured JSON mattered

Free-form model responses can be difficult to render consistently. A structured
contract lets application code:

- Check required fields.
- Choose specific Block Kit components.
- Handle missing or invalid sections.
- Display errors without breaking the interface.
- Test the same input/output behavior repeatedly.

### Main architectural trade-offs

- Structured output improves reliability but requires schema maintenance.
- Retrieval improves relevance but can return incorrect or stale context.
- Slack provides immediate enterprise distribution but constrains interface
  design to its platform components.
- External model APIs accelerate development but introduce cost, latency, and
  data-governance considerations.

## How the experiences connect

The resume shows a progression:

1. **Mentessa:** Integrated an LLM into an existing enterprise interface and
   learned to render probabilistic output reliably through structured JSON.
2. **Stealth startup:** Owned a broader React/TypeScript product lifecycle and
   built secure frontend-to-LLM service boundaries with tenant isolation.
3. **Managify:** Built a full AI workflow with durable relational state,
   automated evaluation, and isolated background document processing.
4. **TeamFlow:** Combined agents, MCP tools, vector retrieval, secure cloud
   identity, and distributed AI observability into a production-minded
   architecture.

Across these experiences, the recurring engineering pattern is:

```text
Untrusted or complex input
-> explicit service boundary
-> AI or retrieval operation
-> structured contract
-> deterministic validation
-> observable application behavior
```

## Interview-ready summary

> My stack spans the full AI application lifecycle. I use React, Next.js, and
> TypeScript for typed product interfaces; Python and FastAPI for AI and
> background services; PostgreSQL, Prisma, and pgvector for relational state and
> semantic retrieval; and FastMCP to expose narrow tools to agents without
> giving them direct database access. I use Gemini or the OpenAI API for model
> capabilities, but surround them with structured JSON, runtime validation,
> golden-set evaluation, and groundedness checks. OpenTelemetry and Google
> Cloud Trace make the distributed model workflow observable, while GitHub
> Actions, OIDC, and Workload Identity Federation provide keyless cloud
> deployment.

## Accuracy notes

- The repository's model defaults are recorded in `config/ai-model-contract.json`.
  Cloud deployment environment overrides are external state and require separate
  verification.
- LangGraph and LangChain are present in the current TeamFlow repository and
  implement the locally tested Phase 4 two-agent scenario, but they are not explicitly listed
  on the supplied resume PDF.
- Supabase is used by the current TeamFlow repository, but it is not explicitly
  named on this resume PDF.
- Vercel is inferred from the two `vercel.app` project URLs.
- Do not claim that Claude Code or Antigravity runs as part of the deployed
  Managify application; they are development tools.
- Do not claim benchmark results, compliance status, or production scale beyond
  the specific metrics stated on the resume.
