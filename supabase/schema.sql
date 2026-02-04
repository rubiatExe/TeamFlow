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

-- 4. Audit Log (Compliance)
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
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Policies (Simple stub for now, assuming auth.uid() == merchant_id later)
-- For development, we might want to allow anon access or key-based access depending on auth setup.
-- We will refine this once Auth is implemented. 
-- For now, create a policy that allows all operations for authenticated users (managers).

CREATE POLICY "Enable all for users based on merchant_id" ON merchants
    FOR ALL USING (auth.uid() = id);

CREATE POLICY "Enable all for users based on merchant_id" ON jobs
    FOR ALL USING (auth.uid() = merchant_id);

CREATE POLICY "Enable all for users based on merchant_id" ON candidates
    FOR ALL USING (auth.uid() = merchant_id);

-- Storage buckets setup should be done via API/Dashboard, but here is the idea:
-- Bucket: 'resumes'
-- Policy: Authenticated users can upload and read.
