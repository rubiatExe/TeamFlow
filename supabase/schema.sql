-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enable pgvector for embeddings (future proofing)
CREATE EXTENSION IF NOT EXISTS "vector";

-- 1. Merchants Table (Stores shop settings)
CREATE TABLE merchants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    email TEXT UNIQUE NOT NULL,
    store_name TEXT NOT NULL,
    square_merchant_id TEXT UNIQUE, -- Linked to Square
    phone_number TEXT -- Twilio sender config
);

-- 2. Jobs Table (Roles/Openings)
CREATE TABLE jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    merchant_id UUID REFERENCES merchants(id) ON DELETE CASCADE NOT NULL,
    title TEXT NOT NULL, -- e.g., "Barista", "Line Cook"
    wage_min NUMERIC,
    wage_max NUMERIC,
    is_active BOOLEAN DEFAULT TRUE,
    
    -- Hiring Persona / Constraints
    dealbreakers JSONB DEFAULT '[]'::JSONB, -- Array of questions
    nice_to_haves JSONB DEFAULT '[]'::JSONB,
    description TEXT
);

-- 3. Candidates Table (The core data)
CREATE TABLE candidates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    merchant_id UUID REFERENCES merchants(id) ON DELETE CASCADE NOT NULL,
    job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
    
    -- Personal Info (Parsed)
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    city TEXT,
    
    -- Status pipeline
    status TEXT CHECK (status IN ('new', 'invited', 'interviewed', 'hired', 'rejected')) DEFAULT 'new',
    
    -- Files
    resume_url TEXT NOT NULL, -- Path to PDF in Storage
    resume_text TEXT, -- Raw text/latex backup
    
    -- AI Scoring
    fit_score INTEGER CHECK (fit_score >= 0 AND fit_score <= 100),
    analysis JSONB, -- The full JSON output from Gemini (skills, gaps, etc.)
    red_flags JSONB DEFAULT '[]'::JSONB,
    summary TEXT, -- One line summary
    
    -- Metadata
    source TEXT DEFAULT 'upload' -- 'upload' or 'scan'
);

-- 4. Applications Table (Candidate Submissions)
CREATE TABLE IF NOT EXISTS applications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE SET NULL,
    role_id TEXT NOT NULL,
    data JSONB NOT NULL,
    submitted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Audit Log (Compliance)
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    merchant_id UUID REFERENCES merchants(id),
    action TEXT NOT NULL, -- 'score_generated', 'invite_sent'
    input_data JSONB, -- What was sent to AI
    output_data JSONB -- What AI returned
);

-- RLS Policies
-- Enable RLS
ALTER TABLE merchants ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Allow public/anon access for candidates (upload, select, update, delete)
DROP POLICY IF EXISTS "Enable all for users based on merchant_id" ON candidates;
CREATE POLICY "Allow public all on candidates" ON candidates FOR ALL USING (true) WITH CHECK (true);

-- Allow public/anon access for applications
DROP POLICY IF EXISTS "Enable insert for public application submission" ON applications;
CREATE POLICY "Allow public all on applications" ON applications FOR ALL USING (true) WITH CHECK (true);

-- Allow public/anon access for jobs & merchants & audit_logs
DROP POLICY IF EXISTS "Enable all for users based on merchant_id" ON jobs;
CREATE POLICY "Allow public all on jobs" ON jobs FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Enable all for users based on merchant_id" ON merchants;
CREATE POLICY "Allow public all on merchants" ON merchants FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow public all on audit_logs" ON audit_logs FOR ALL USING (true) WITH CHECK (true);


