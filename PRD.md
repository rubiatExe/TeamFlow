# TeamFlow Product Requirements Document (PRD)

## 1. Executive Summary
**TeamFlow** is an AI-native hiring agent integrated into the Square ecosystem. It automates the "Screening & Scheduling" phase for SMB owners (cafes, retail, restaurants) who are drowning in unformatted applicant data.

Unlike traditional ATS tools that require candidates to fill out digital forms, TeamFlow accepts unstructured inputs (PDFs, images, handwritten notes). It uses a Neural LaTeX Extraction pipeline to preserve document layout, enabling Large Language Models (Gemini 1.5) to "Read and Rank" candidates with human-level context.

**Core Value Prop:** "Normalize Chaos, Grade Contextually, and Automate Action."

## 2. Target Audience & Problem Statement
*   **Target User:** The "Deskless" Operator (Cafe Owners, Restaurant Managers). They have <1 hour/day for admin.

**The Problem:**
*   **Data Chaos:** Resumes come as emails, PDFs, and photos of paper.
*   **Context Gap:** Keywords don't capture dealbreakers (e.g., "Must work weekends," "45-min commute").
*   **Process Lag:** High-quality candidates are lost because the owner takes days to reply.

## 3. Product Principles
1.  **Zero Data Entry:** The user never types candidate info manually. The AI extracts it.
2.  **Bias for Action:** The UI prioritizes verbs (Invite, Reject) over nouns (Candidate Lists).
3.  **Explainable Intelligence:** Every AI score must have a "Why?" tooltip to build trust.
4.  **Local-First Compliance:** Adherence to NYC Local Law 144 (AEDT) is built-in.

## 4. Functional Requirements

### FR 1.0: Ingestion & The "Smart Drop Zone"
**User Story:** As a user, I want to drag a mixed pile of PDF resumes and photos into a box and have them instantly processed.

*   **1.1 Multimodal Upload:** Support for PDF, DOCX, JPG, PNG, HEIC.
*   **1.2 Neural LaTeX Extraction (The "Nougat" Pipeline):**
    *   **Constraint:** Do not use standard text-scraping.
    *   **Requirement:** All PDF/Image inputs must be passed through a Vision-to-LaTeX model (e.g., Meta's Nougat or a finetuned OCR-to-LaTeX model).
    *   **Rationale:** Resumes often have complex columns, tables (for skills), and headers. Standard text extraction destroys this spatial relationship. Converting to LaTeX syntax preserves the structure (e.g., `\begin{table} ... \end{table}`) before sending to the LLM.
*   **1.3 Progress UI:** Visual feedback per file ("Scanning Layout..." -> "Parsing LaTeX..." -> "Grading...").

### FR 2.0: The AI "Hiring Brain" (Gemini 1.5)
**User Story:** As a user, I want candidates to be scored based on my specific shop rules, not just generic keywords.

*   **2.1 Persona Configuration:**
    *   Input: Job Role (pulled from Square Labor API), Hourly Wage, Dealbreakers (Boolean), Nice-to-haves.
*   **2.2 Contextual Parsing (LLM):**
    *   Input: The LaTeX string generated in FR 1.2.
    *   Process: Gemini 1.5 Flash (or Pro for handwritten) analyzes the LaTeX.
    *   Output: Structured JSON.
*   **2.3 The Scoring Algorithm (0-100):**
    *   **Constraints (50%):** Binary pass/fail on dealbreakers (e.g., Weekend Availability).
    *   **Experience (30%):** Semantic match on skills.
    *   **Logistics (20%):** Commute time calculation (User Store Location <-> Candidate City).
*   **2.4 Red Flag Detector:**
    *   Logic to flag: Job Hopping (>3 jobs/year), Gaps (>6 months), Unexplainable downgrades.

### FR 3.0: The Candidate Board & Action Layer
**User Story:** As a user, I want to see who is a "Yes" and invite them in one click.

*   **3.1 Ranked Kanban View:**
    *   Columns: New (Sorted by Score), Invited, Interviewed, Hired.
*   **3.2 The "Why?" Tooltip:**
    *   Hovering over a score (e.g., "82") shows: "Strong experience, matches weekend needs, but commute is 35 mins."
*   **3.3 One-Click Invite:**
    *   Button: "Invite to Interview."
    *   Action: Triggers a pre-filled SMS/Email draft via Twilio/SendGrid.
    *   Template: "Hi [Name], [Store Name] here. We loved your resume. Free for a chat [Next Tuesday]?"

### FR 4.0: Square Ecosystem Integration
**User Story:** As a user, I want this to work with the Square tools I already use.

*   **4.1 Labor API Sync:**
    *   Pull active "Job Titles" and "Wages" from Square to pre-fill the Hiring Persona.
*   **4.2 Onboarding Sync:**
    *   When status moves to "Hired," payload is sent to CreateTeamMember endpoint in Square, instantly creating their POS login.

### FR 5.0: The Candidate Portal (Mobile Web)
**User Story:** As a candidate, I want to complete my application or schedule my interview on my phone in under 2 minutes without creating an account.

**Design Principle:** "No Login, No Friction." The portal is accessed via a secure "Magic Link" sent via SMS or a QR code scanned at the store counter.

*   **5.1 The Interface**
    *   **Mobile-First Design:** A single-column, touch-friendly interface (Next.js) that feels like a chat application.
    *   **Authentication:** Token-based access (JWT) embedded in the URL (e.g., `teamflow.app/apply?token=xyz`). No username/password required.
    *   **Brand Identity:** The portal dynamically themes itself to match the store’s brand (Logo + Primary Color pulled from Square Merchant settings).

*   **5.2 The Workflow**
    *   **Landing:** "Welcome to [Joe's Coffee]. We just have 3 quick questions to finish your application."
    *   **The "Knockout" Round:** 3-5 high-priority constraint questions (defined in the Manager's Hiring Persona).
    *   **The "Vibe Check" (Optional):** A prompt to record a 30-second video or audio intro (replacing the cover letter).
    *   **Scheduling (If Qualified):** If the candidate passes the "Knockout" questions, they immediately see a calendar to book their interview slot (synced with the Manager’s availability).

*   **5.3 The Question Bank (Dynamic Logic)**
    The questions presented to the candidate are not static. They are dynamically generated based on the Job Role and Hiring Persona settings.

    *   **Category A: The "Dealbreakers" (Hard Constraints)**
        *   These are binary Pass/Fail questions. If a candidate answers "No" to a critical one, the workflow ends politely.
        *   *Legal/Ops:*
            *   "Are you legally authorized to work in the US?"
            *   "Are you at least 18 years of age?"
            *   "Do you have a valid Food Handler’s Permit?" (For FOH/BOH roles).
        *   *Availability:*
            *   "Can you work closing shifts (until 11 PM) on Fridays and Saturdays?"
            *   "Are you available for a minimum of 20 hours per week?"
        *   *Logistics:*
            *   "Do you have reliable transportation to commute to [Jersey City]?"

    *   **Category B: Role-Specific Skills (Contextual)**
        *   The AI selects 2-3 questions based on the job title.
        *   *For "Barista" Roles:*
            *   "Rate your experience with manual espresso machines (La Marzocco, Slayer, etc.): [None / Beginner / Pro]"
            *   "Can you pour latte art (hearts, rosettas)? [Yes / No / Willing to learn]"
            *   "How do you handle a customer who says their drink is 'wrong' during a rush?" (Open text/voice)
        *   *For "Line Cook / BOH" Roles:*
            *   "What is your experience level with high-volume ticket management?"
            *   "Have you worked with a sous-vide or combi oven before?"
            *   "Are you comfortable lifting up to 50lbs repeatedly?"
        *   *For "Retail / Sales" Roles:*
            *   "Have you used a Square POS or similar register system before?"
            *   "Describe a time you turned a difficult customer interaction into a positive one."

    *   **Category C: The "Vibe Check" (AI Analysis)**
        *   Prompt: "In 30 seconds, tell us why you want to join the [Joe's Coffee] team specifically. Be yourself!"
        *   Tech: Browser-based MediaRecorder API (Audio or Video).
        *   AI Analysis: The backend analyzes the transcript for sentiment ("Enthusiastic" vs. "Bored") and keywords ("Community," "Coffee," "Learning").

## 5. Technical Architecture

### 5.1 Tech Stack
*   **Frontend:** Next.js 14 (App Router), Tailwind CSS, Shadcn/UI.
*   **Backend:** Python (FastAPI) or Next.js Server Actions (Node.js). Note: Python is preferred for the LaTeX/Nougat pipeline.
*   **Extraction Layer:**
    *   **Model:** `facebook/nougat-small` (or similar Vision Transformer) for PDF-to-LaTeX conversion.
    *   **Infrastructure:** Run on a GPU-enabled container (e.g., Modal or Replicate) to handle the inference speed.
*   **Intelligence Layer:** Google Gemini 1.5 Flash (via Vertex AI or AI Studio).
*   **Database:** Supabase (PostgreSQL) + pgvector (for semantic search on resumes).

### 5.2 Data Pipeline (The "LaTeX" Flow)
1.  **Upload:** User uploads `resume.pdf`.
2.  **Conversion:** Service sends file to Neural OCR -> Returns `raw_latex_string`.
    *   Example Output: `\section*{Experience} \begin{itemize} \item Barista at Joe's Coffee... \end{itemize}`
3.  **Parsing:** `raw_latex_string` is sent to Gemini 1.5 with prompt: "Extract JSON from this LaTeX resume..."
4.  **Storage:** JSON stored in Supabase; Original PDF stored in Bucket.

## 6. Compliance & Security (NYC LL 144)
*   **Audit Trail:** Every "Fit Score" generation must log the input features used to calculate the score to a separate audit table.
*   **Disparate Impact Check:** Real-time monitoring to ensure the algorithm isn't systematically downgrading specific zip codes or names (if not anonymized).
*   **Data Retention:** Auto-delete candidate PII after 90 days unless "Hired."

## 7. Development Phases

### Phase 1: The "Smart Parser" (Week 1-2)
*   Build Next.js Drop Zone.
*   Implement the PDF -> LaTeX -> Gemini pipeline.
*   Display the "Fit Score" and JSON output in a table.

### Phase 2: The "Agent" (Week 3-4)
*   Implement Twilio integration for SMS.
*   Build the "Hiring Persona" settings page.
*   Add the "Why?" tooltips.

### Phase 3: The Square Integration (Week 5)
*   Connect Square OAuth.
*   Sync with Labor API.
*   Launch on Square App Marketplace.

## 8. Success Metrics
*   **North Star:** "Time Saved per Hire" (Target: Reduced from 10 hours to 1 hour).
*   **Conversion:** % of processed resumes that result in an "Invite" click.
*   **Accuracy:** % of extracted fields that require user correction (Target: <5%).

## Appendix: Why LaTeX Extraction?
Using LaTeX as the intermediate representation solves the "Column Problem" in standard OCR.
*   **Standard OCR:** Reads left-to-right across columns, jumbling text (e.g., "Education 2020" gets mixed with "Experience 2022").
*   **LaTeX Extraction:** Recognizes the page layout as a grid/table structure (`\begin{minicols}{2}`) and preserves the semantic separation of data before the AI reads it. This ensures 99.9% parsing accuracy for complex resume layouts.
