# TeamFlow Project Flow

## Overview
TeamFlow is an AI-powered hiring tool built to make hourly hiring easier for managers and faster for candidates.

It has two main experiences:
1. **Manager dashboard** — where hiring teams upload resumes, review candidates, and invite people to apply.
2. **Candidate portal** — where invited applicants complete a quick application using a magic link.

## What the manager sees
- A dashboard where they can upload resumes by dragging and dropping files.
- A list of candidates organized by hiring stage: pending, new, invited, interviewed, and hired.
- A score for each candidate that shows how well they match the job based on AI analysis.
- Tools to set hiring preferences like job type, dealbreakers, and the skills they want.
- A mock integration with Square jobs, so the manager can choose a role and see relevant hiring criteria.

## What happens when a manager uploads a resume
1. The system receives the resume file.
2. It sends the file to an AI service called Gemini.
3. Gemini reads the resume and returns structured information such as:
   - candidate name
   - email
   - phone number
   - location
   - relevant skills
   - estimated experience
   - a suitability score
4. The candidate is added to the dashboard with the AI score and any potential red flags.

## What happens when a manager invites a candidate
- The manager can send a magic link to the candidate via SMS.
- The magic link contains a secure token that allows the candidate to open the application form without creating an account.
- The candidate portal is personalized with the store name and the selected job role.

## What the candidate sees
The candidate application is a simple, guided flow:
1. Welcome screen with the store name and role.
2. Basic contact information and role selection.
3. A small set of knockout questions to confirm key requirements (for example, age or availability).
4. Availability and schedule preferences.
5. Skills and experience questions.
6. Motivation questions to understand why the candidate wants the job.
7. A final submission screen with confirmation that their application was received.

## Why this matters
- Managers can quickly review resumes without manually reading every document.
- The AI helps surface the strongest candidates first.
- Candidates get a fast, no-login application experience.
- Instead of email threads and attachments, everything is handled in one streamlined system.

## Why this is different for cafés
TeamFlow is designed specifically for cafés, restaurants, and other hourly service businesses.
- It focuses on the hires cafés need most, such as baristas, line cooks, and shift leads.
- It uses role-specific hiring criteria, so the AI evaluates candidates against real café requirements like weekend availability, food handling, and customer service.
- It removes the need for bulky paper resumes and long application forms, making it easier for busy candidates to apply quickly.
- Managers can invite candidates directly by SMS with a magic link, which increases response rates from walk-in and mobile-first applicants.
- The system helps cafés hire faster by turning fragmented hiring tasks into one simple workflow.

## Technical note for non-technical users
- The project is built with a website framework called Next.js.
- It uses AI from Google Gemini to understand resumes and score candidates.
- It can optionally send SMS messages through a service called Twilio.
- It can also save data in a database (Supabase) if configured.

## Simple visual flow
1. Manager uploads resume → 2. AI analyzes resume → 3. Candidate appears in dashboard → 4. Manager sends magic link → 5. Candidate completes application → 6. Application is saved

## In short
TeamFlow turns hiring into a guided experience:
- Managers upload resumes and get AI-backed candidate insights.
- Candidates click a link and complete a short, friendly application.
- The whole process is meant to be faster, easier, and more reliable than traditional hourly hiring workflows.
