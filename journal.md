# TeamFlow Development Journal

## When “Parsing Failed” Did Not Mean Parsing Failed

**Date:** July 25, 2026
**Area:** Resume ingestion, Gemini scoring, and production resilience

### The situation

I was testing TeamFlow’s resume pipeline when the application reported that parsing had failed. From the outside, the message made it look as if the résumé could not be read at all. That was especially frustrating because this flow crosses several systems: the Next.js upload route, the Cloud Run document processor, Gemini, and Supabase. A vague failure at the end of the chain gave me no immediate clue about which service was actually responsible.

I retried the same résumé several times. Each attempt took long enough to reach the AI services, and each attempt still ended in failure. At that point the difficult part was not simply “fixing JSON.” The difficult part was proving where the pipeline stopped and separating a document-processing problem from a model-output problem.

### What the evidence showed

The runtime logs changed the investigation.

Agent 1—the Cloud Run document processor—had succeeded. It extracted the résumé and produced a 768-dimensional embedding. The failure happened afterward in Agent 2, the Gemini scorer.

Gemini had understood the résumé. Its response contained the candidate’s details, a score, an explanation, and red flags. But the response was not consistently valid JSON:

- Two attempts ended before the final array and object were closed.
- Another attempt contained a complete JSON object followed by duplicated closing characters.
- `JSON.parse()` rejected those responses.
- The exception escaped the scorer and caused `/api/parser` to return a generic 500 error.
- Because scoring failed before persistence, the validated candidate never reached Supabase.

The phrase “parsing failed” was therefore misleading. OCR had worked. Semantic reasoning had mostly worked. Serialization at the model boundary had failed.

### The assumptions that hurt

I had made several assumptions that looked reasonable during early development:

1. Asking Gemini for `application/json` would always produce valid JSON.
2. A TypeScript cast such as `parsed as ParserOutput` meant the value matched the interface.
3. If the model response was malformed, throwing an error was safer than returning uncertain data.
4. Logging the raw model response was the fastest way to debug it.

All four assumptions broke down under real usage.

`responseMimeType` was a request, not a complete runtime guarantee. A TypeScript cast disappeared at runtime and validated nothing. Throwing the model-formatting error turned a recoverable dependency problem into a user-facing application failure. Raw response logging also exposed candidate names, emails, and phone numbers in development logs.

### The implementation that brought us out

I rebuilt the scoring boundary around one principle:

> Model output is untrusted input, even when the model is instructed to return JSON.

The new implementation adds several layers of protection.

#### 1. A structured Gemini response contract

The request now includes both `application/json` and an explicit response schema. The schema describes the candidate, score breakdown, explanation, and red flags that Gemini must return.

#### 2. Runtime validation with Zod

The response is parsed and checked with `ParserOutputSchema`. The validator confirms:

- Required fields are present.
- Scores stay within their allowed ranges.
- The total equals the three score components.
- Arrays and strings stay within reasonable limits.

The application no longer trusts a TypeScript cast.

#### 3. Finish-reason inspection

Before parsing the text, the scorer checks why Gemini stopped. A response stopped by a token limit, safety filter, or another incomplete finish reason is treated as invalid rather than being sent blindly into `JSON.parse()`.

#### 4. One bounded retry

Malformed or schema-invalid output gets one retry. The retry uses:

- The same structured schema
- Temperature zero
- An explicit output-token budget
- A stronger instruction to return exactly one complete JSON object

The retry is bounded. Authentication failures are not retried, and the system never enters an infinite loop.

#### 5. A conservative fallback

If both AI attempts fail, TeamFlow returns a deterministic result built only from explicit résumé evidence. It does not invent an email address, phone number, skill, or high fit score. The explanation states that AI scoring was unavailable and manual review is required.

There is also a minimal emergency fallback in case the primary deterministic fallback ever violates the output contract.

#### 6. Validation before Supabase

The API route validates the final result before attempting persistence. Supabase therefore receives only data that satisfies the parser contract. No database schema, migration, RLS policy, or service-role boundary had to change.

#### 7. Safer observability

The scorer now records:

- A request ID
- Attempt number
- Model
- Finish reason
- Token counts
- Response length
- Validation paths
- Whether the result came from AI, retry, or fallback

It no longer prints the raw candidate response.

### The regression tests

I added automated tests for the exact failure modes observed:

- Truncated JSON
- Duplicated trailing JSON
- Markdown-fenced JSON
- Empty or incomplete responses
- Token-limit finish reasons
- Schema-valid JSON with inconsistent scores
- First attempt failing and the retry succeeding
- Both attempts failing and fallback succeeding
- Non-retryable provider errors
- Invalid primary fallback activating the emergency fallback

This was important because the bug was intermittent. A manual successful upload would not prove that the failure path was safe. The tests make the failure reproducible without depending on Gemini to misbehave again.

### What I learned

The strongest lesson was that reliability around AI systems comes from ordinary software-engineering discipline:

- Validate every external boundary.
- Separate extraction, reasoning, validation, and persistence.
- Make retries bounded and intentional.
- Design a degraded mode before production needs it.
- Prefer conservative output over fabricated confidence.
- Give every request a traceable identity.
- Never log more personal data than the investigation requires.

The AI did not need to become perfect. The application needed to become resilient to an imperfect dependency.

### How I would explain this in an interview

> “Our OCR stage was succeeding, but the Gemini scoring stage occasionally returned truncated or duplicated JSON. The original code trusted `responseMimeType` and used a TypeScript cast instead of runtime validation, so malformed output became a 500 error. I introduced schema-constrained generation, Zod validation, finish-reason checks, one bounded retry, and a conservative deterministic fallback. I also moved validation ahead of Supabase persistence and replaced raw PII logs with request-scoped metadata. The result is that model formatting errors are now contained inside the scoring boundary instead of reaching the user.”

### Follow-up questions for future entries

- What new failure did I observe?
- Which assumption did it challenge?
- What evidence isolated the failing boundary?
- How did the implementation degrade safely?
- What test now prevents the regression?
- How would I explain the tradeoff to an interviewer?

---

## When the Trace Existed but the Story Was Still Broken

**Date:** July 25, 2026
**Area:** Distributed tracing across local Next.js and Google Cloud Run

### The confusing symptom

After the parsing fix, a résumé completed successfully: OCR ran, an embedding
was generated, Gemini scored the candidate, and the review appeared in the
application. I expected that success to create a clear new entry in Google
Cloud Trace. The Trace Explorer did not show the end-to-end pipeline I was
looking for.

The first instinct was to assume that the exporter had failed. The Cloud Run
logs disproved that. The request reached `/extract`, returned HTTP 200, and
OpenTelemetry reported that the Google Cloud exporter initialized normally.

### What was actually happening

There were two valid traces:

- Cloud Run created an infrastructure request trace for `/extract`.
- The Python service created a separate custom trace containing
  `ocr_extraction` and `embedding_generation`.

Both traces described the same request, but neither contained the complete
story. FastAPI had not extracted Cloud Run's W3C `traceparent` context, and the
local Next.js server had only the OpenTelemetry API—not an initialized SDK and
exporter. The result was technically valid telemetry with broken causality.

### The implementation

I changed the design around context propagation rather than adding more log
statements:

1. FastAPI instrumentation now extracts the incoming `traceparent`.
2. The existing OCR and embedding spans inherit the active request context.
3. Next.js initializes OpenTelemetry through its root `instrumentation.ts`
   convention when an OTLP exporter is explicitly configured.
4. Only the OCR request opts into outbound context propagation; Gemini and
   Supabase do not receive tracing headers.
5. Scoring and persistence have named child spans.
6. Local Next.js traces can pass through a Google-built collector to Cloud
   Trace, while tracing remains disabled by default.
7. The résumé filename was removed from trace attributes to avoid leaking
   candidate information.

The telemetry path is fail-open. A missing collector, expired credential, or
export failure cannot change the parsing result.

### The lesson

Observability is not just producing spans. A useful distributed trace requires
every service to agree on propagation, sampling, and parentage. Separate green
spans can still tell an incomplete story.

### How I would explain this in an interview

> “The exporter was working, but Cloud Run and our custom OCR instrumentation
> were producing separate trace IDs. I added W3C context extraction in
> FastAPI, explicit propagation on the Next.js-to-Cloud-Run boundary, and an
> optional OTLP collector for local Next.js export. I also removed filename
> PII and added a regression test that injects a known `traceparent` and proves
> the OCR span keeps the same trace ID. The result is one causal waterfall,
> while telemetry failures remain isolated from the hiring workflow.”

---

## When Local OCR Worked but Production Could Not Reach It

**Area:** Service boundaries, PDF handling, and production parity

### The situation

The résumé workflow looked healthy in local development because the Next.js
app could call a Python OCR service on the same machine. That assumption did
not survive deployment. A serverless deployment cannot reach a developer's
`localhost`, and an early fallback tried to treat raw PDF bytes as text. The
file reached the AI layer, but its content had already been corrupted.

### What changed

I separated the two concerns:

- The durable OCR path became a separately deployable document-processing
  service rather than a local-only dependency.
- When that service was unavailable, the fallback preserved the original
  PDF/image and sent it to Gemini as an inline vision input instead of decoding
  binary data as UTF-8 text.
- The parser kept the same output contract regardless of whether OCR or the
  vision fallback supplied the résumé text.

### What I learned

Local success is not evidence of production reachability. I now treat a
service URL, file representation, and fallback behavior as explicit
integration contracts. A fallback must preserve the meaning of the input; it
cannot merely avoid throwing an error.

### How I would explain this in an interview

> “The OCR service worked locally because both processes shared one machine,
> but the deployed Next.js runtime could not call that local address. I moved
> the durable path to an independently deployable document processor and made
> the fallback multimodal: it passes the original file to Gemini Vision rather
> than converting PDF bytes into invalid text. That gave us production parity
> without changing the parser's response contract.”

---

## When AI Provider Configuration Became a Runtime Dependency

**Area:** Gemini quotas, model deprecations, and defensive provider handling

### The situation

During development, model names, quota availability, and response metadata did
not stay stable. A model that worked in one iteration could become deprecated
or unavailable in the next. In another case, code assumed token-usage metadata
would always be present, turning optional observability data into an avoidable
runtime failure.

### What changed

I treated the AI provider as an external dependency instead of a fixed utility:

- Model selection is centralized rather than scattered across routes.
- Provider metadata is accessed defensively and never determines whether the
  candidate workflow succeeds.
- The application has bounded retries and deterministic fallbacks for
  recoverable model failures.
- Logs identify the selected model, attempt, finish reason, and token counts
  when available, without exposing candidate content.

### What I learned

AI model identifiers and optional response fields are runtime contracts. They
need the same compatibility thinking as an external API version: validate
inputs, handle absent fields, make configuration easy to update, and keep a
safe degraded mode.

### How I would explain this in an interview

> “I learned not to hard-code assumptions about an AI provider. Model access,
> deprecations, quotas, and even usage metadata can change independently of my
> code. I centralized model configuration, made metadata optional, and designed
> retries and fallbacks so a provider change becomes a contained dependency
> issue instead of a broken hiring workflow.”

---

## When a Normal API Route Was Not Enough for an AI Pipeline

**Area:** Serverless limits and end-to-end latency

### The situation

Résumé processing is not one quick database request. It can include file
transfer, OCR, embedding generation, Gemini scoring, validation, and Supabase
persistence. The combined path approached or exceeded the default execution
budget of a typical serverless API route.

### What changed

I measured the pipeline as one end-to-end operation and configured an explicit
maximum duration for the parser route. I also retained request IDs and
stage-level logging so I could see whether time was being spent in extraction,
scoring, or persistence.

### What I learned

The important number is the full critical path, not the time of an individual
function call. When synchronous processing is still appropriate, the platform
limit must be intentional. When it is no longer appropriate, the next step is
to move the work into a queued or durable background workflow rather than
hoping a longer timeout will solve every problem.

### How I would explain this in an interview

> “The résumé pipeline crosses multiple AI and data services, so I evaluated
> its total latency rather than treating each call in isolation. I set an
> explicit route duration, added request-scoped timing, and made the current
> synchronous trade-off visible. That also gives me a clear path to a queue if
> throughput or latency requirements grow.”

---

## When the Candidate Dashboard Met Supabase RLS

**Area:** Data access boundaries and least privilege

### The situation

The hiring dashboard needed to read and manage candidate records, while
Supabase Row Level Security correctly prevents a browser client from behaving
like a trusted backend. The hard part was enabling the UI without leaking a
service-role credential or weakening the database policy just to make a demo
work.

### What changed

I introduced narrow server-side API boundaries for trusted candidate operations.
The browser calls the application API; the API performs the authorized
Supabase operation on the server; and the privileged key remains server-only.
The client does not receive elevated database credentials.

### What I learned

RLS is not an obstacle to work around. It is a design constraint that clarifies
which actions belong in the browser and which belong behind a trusted server
boundary. The result is easier to audit and safer to extend when the project
adds real users and tenant-specific policies.

### How I would explain this in an interview

> “The dashboard needed operational access that a browser client should not
> have. Rather than relaxing Supabase RLS or exposing a service-role key, I
> created a narrow server-side API boundary. That preserved the database's
> security model while keeping the UI simple.”

---

## When Deployment Needed an Identity and a Container Contract

**Area:** GitHub Actions, Workload Identity Federation, Docker, and Cloud Run

### The situation

Deploying the Python document processor involved more than building a Docker
image. Cloud Run expects the container to listen on the injected `PORT`, GitHub
Actions needs a trusted deployment identity, and the service configuration has
to match the URL, authentication, and environment expected by the Next.js app.

### What changed

I made the deployment contract explicit:

- The container respects Cloud Run's `PORT` environment variable.
- GitHub Actions uses a federated deployment identity instead of storing a
  long-lived cloud credential in the repository.
- CI checks the application and Python service separately.
- Deployment configuration lives with the source so the document processor can
  be reproduced from a clean checkout.

### What I learned

Deployment is part of application design. The container entry point, cloud
identity, workflow permissions, and service configuration form one system. A
successful local Docker build is valuable, but it does not prove that the
runtime contract is correct in Cloud Run.

### How I would explain this in an interview

> “I treated the Cloud Run deploy as an integration problem rather than just a
> CI task. The image had to honor the platform port, GitHub Actions needed a
> short-lived federated identity, and the deployed service had to match the
> application's authentication and URL contract. That reduced secret exposure
> and made the deployment repeatable.”

---

## When an Embedding Dimension Became a Cross-Service Contract

**Area:** OCR output, pgvector schema, and candidate persistence

### The situation

Adding semantic search and ranking introduced a subtle integration risk. The
document processor generates an embedding, the API transports it, and Supabase
stores it in a vector column. If the model changes dimension or one service
silently returns an unexpected value, the failure appears far away from its
cause—often at database persistence time.

### What changed

I made the embedding path explicit in the service contract and database setup:

- The document processor returns the embedding alongside extracted text.
- The parser persists it only through the server-side candidate boundary.
- The Supabase schema and migration define the vector storage shape.
- Runtime logs record the embedding dimension without recording résumé content.

### What I learned

Vector dimensions are not an implementation detail. They are a versioned
contract shared by the model, transport layer, database schema, and any future
similarity query. Keeping that contract visible makes future model migrations
safer.

### How I would explain this in an interview

> “The embedding model, API payload, and pgvector column all need to agree on
> one dimension. I treated that as a cross-service contract, stored embeddings
> only after the parser validated the pipeline result, and logged dimensions as
> operational metadata. That prevents a model change from becoming a mysterious
> database failure.”

---

## When Direct Uploads Simplified the Prototype but Changed the Trade-Off

**Area:** File transport and product-stage architecture

### The situation

The earliest upload path relied more heavily on storage infrastructure than the
prototype needed. For a faster, more reliable demonstration flow, the client
sent an encoded file directly to the parser API. That removed one moving part,
but it also made file size, request duration, and transient data handling more
important.

### What changed

I made the direct-upload path explicit and constrained it with validation. The
parser accepts either an inline file or a file URL, validates the request, and
keeps the processing pipeline independent of the transport choice.

### What I learned

There is no universally correct upload architecture. Direct upload can be a
good prototype choice because it removes storage setup from the critical demo
path. For larger files, retries, retention, or multi-user production traffic,
object storage with signed URLs becomes the better design. The important part
is documenting the trade-off rather than presenting a prototype shortcut as a
permanent default.

### How I would explain this in an interview

> “For the prototype, I chose direct upload to reduce infrastructure friction
> and make the résumé-analysis flow easy to demonstrate. I kept the parser
> transport-agnostic and added validation, while documenting that signed object
> storage is the next step for larger files and production retention needs.”
