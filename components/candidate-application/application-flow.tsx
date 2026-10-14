"use client";

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { BasicInfo, BasicInfoData } from '@/components/candidate-application/basic-info';
import { CandidateProfile, ProfileData } from '@/components/candidate-application/candidate-profile';
import { SkillsExperience, SkillsData } from '@/components/candidate-application/skills-experience';
import { MotivationQuestions, MotivationData } from '@/components/candidate-application/motivation-questions';
import {
    getRoleById,
    getRoleOrDefault,
    type RoleQuestion,
} from '@/lib/domain/roles';
import { ResumePrefillSchema } from '@/lib/domain/resume-prefill';

function encodeResumeFile(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Could not read the selected resume.'));
        reader.onload = () => {
            if (typeof reader.result !== 'string') {
                reject(new Error('Could not read the selected resume.'));
                return;
            }
            const comma = reader.result.indexOf(',');
            if (comma < 0) {
                reject(new Error('Could not read the selected resume.'));
                return;
            }
            resolve(reader.result.slice(comma + 1));
        };
        reader.readAsDataURL(file);
    });
}

function equalStrings(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

interface TokenPayload {
    candidateId?: string;
    candidateName?: string;
    merchantName?: string;
    jobId?: string;
    roleId?: string;
}

type ApplicationMode = 'demo' | 'production';

type UploadedResume = { file: File; id: string };
type PendingResumeGrant = {
    file: File;
    grant: { id: string; path: string; signedToken: string };
    attempts: number;
};

function parseUploadGrant(value: unknown): { id: string; path: string; signedToken: string } | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (record.success !== true || !record.upload || typeof record.upload !== 'object') return null;
    const upload = record.upload as Record<string, unknown>;
    if (typeof upload.id !== 'string' || typeof upload.path !== 'string' || typeof upload.signedToken !== 'string') return null;
    return { id: upload.id, path: upload.path, signedToken: upload.signedToken };
}

function parseApplicationSession(value: unknown): TokenPayload | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (record.success !== true || !record.session || typeof record.session !== 'object') return null;
    const session = record.session as Record<string, unknown>;
    if (typeof session.merchantName !== 'string' || typeof session.roleId !== 'string' || !getRoleById(session.roleId)) return null;
    if (session.candidateName !== undefined && typeof session.candidateName !== 'string') return null;
    return {
        candidateName: session.candidateName as string | undefined,
        merchantName: session.merchantName,
        roleId: session.roleId,
    };
}

type Step = 'loading' | 'welcome' | 'basicInfo' | 'questions' | 'profile' | 'skills' | 'motivation' | 'passed' | 'needsReview' | 'complete' | 'error' | 'serviceError';

type SubmissionFailure = {
    message: string;
    retryable: boolean;
    code?: string;
};

type ApplicationApiResult =
    | { success: true; applicationId: string; passed: boolean; failedKnockouts: string[] }
    | { success: false; error: SubmissionFailure };

function parseApplicationApiResult(value: unknown): ApplicationApiResult | null {
    if (!value || typeof value !== 'object') return null;
    const result = value as Record<string, unknown>;
    if (
        result.success === true
        && typeof result.applicationId === 'string'
        && typeof result.passed === 'boolean'
        && Array.isArray(result.failedKnockouts)
        && result.failedKnockouts.every(item => typeof item === 'string')
    ) {
        return {
            success: true,
            applicationId: result.applicationId,
            passed: result.passed,
            failedKnockouts: result.failedKnockouts,
        };
    }
    if (result.success !== false || !result.error || typeof result.error !== 'object') {
        return null;
    }
    const error = result.error as Record<string, unknown>;
    if (typeof error.message !== 'string' || typeof error.retryable !== 'boolean') return null;
    return {
        success: false,
        error: {
            message: error.message,
            retryable: error.retryable,
            code: typeof error.code === 'string' ? error.code : undefined,
        },
    };
}

// Step configuration for progress indicator
const STEPS = [
    { id: 'basicInfo', label: 'Your Info' },
    { id: 'questions', label: 'Quick Check' },
    { id: 'profile', label: 'Availability' },
    { id: 'skills', label: 'Experience' },
    { id: 'motivation', label: 'About You' },
];

function ApplyPageContent({ mode }: { mode: ApplicationMode }) {
    const searchParams = useSearchParams();
    const token = searchParams.get('token');

    const [step, setStep] = useState<Step>('loading');
    const [payload, setPayload] = useState<TokenPayload | null>(null);
    const [answers, setAnswers] = useState<Record<string, string | boolean>>({});
    const [currentQuestion, setCurrentQuestion] = useState(0);
    const [submitting, setSubmitting] = useState(false);
    const [submissionFailure, setSubmissionFailure] = useState<SubmissionFailure | null>(null);
    const [applicationId, setApplicationId] = useState<string | null>(null);
    const transitionHeadingRef = useRef<HTMLHeadingElement>(null);
    const [resumeStatus, setResumeStatus] = useState<'idle' | 'reading' | 'ready' | 'error'>('idle');
    const [resumeMessage, setResumeMessage] = useState<string | null>(null);
    const [resumeUploaded, setResumeUploaded] = useState(false);
    const [uploadAttempt, setUploadAttempt] = useState(0);
    const [sessionAttempt, setSessionAttempt] = useState(0);
    const encodedResumeRef = useRef<{ file: File; fileData: string } | null>(null);
    const uploadedResumeRef = useRef<UploadedResume | null>(null);
    const pendingResumeGrantRef = useRef<PendingResumeGrant | null>(null);
    const manuallyEdited = useRef({
        fullName: false, email: false, phone: false, city: false,
        yearsExperience: false, skills: false, certifications: false, languages: false,
    });

    // New state for enhanced sections
    const [profile, setProfile] = useState<ProfileData>({
        preferredShifts: [],
        daysAvailable: [],
        startDate: '',
        transportation: '',
        contactPreference: '',
    });

    const [skills, setSkills] = useState<SkillsData>({
        yearsExperience: '',
        skills: [],
        certifications: [],
        languages: [],
    });

    const [motivation, setMotivation] = useState<MotivationData>({
        whyWorkHere: '',
        superpower: '',
        aboveAndBeyond: '',
        skillAnswers: {},
    });

    const [basicInfo, setBasicInfo] = useState<BasicInfoData>({
        fullName: '',
        email: '',
        phone: '',
        city: '',
        resumeFile: null,
        selectedRoleId: 'barista',
    });

    const handleBasicInfoChange = (next: BasicInfoData) => {
        const update = mode === 'production' && payload?.roleId
            ? { ...next, selectedRoleId: payload.roleId }
            : next;
        for (const field of ['fullName', 'email', 'phone', 'city'] as const) {
            if (basicInfo[field] !== update[field]) manuallyEdited.current[field] = true;
        }
        if (basicInfo.selectedRoleId !== update.selectedRoleId) {
            manuallyEdited.current.skills = false;
            manuallyEdited.current.certifications = false;
            setSkills(previous => ({ ...previous, skills: [], certifications: [] }));
            if (update.resumeFile) setResumeStatus('reading');
        }
        if (basicInfo.resumeFile !== update.resumeFile) {
            encodedResumeRef.current = null;
            uploadedResumeRef.current = null;
            pendingResumeGrantRef.current = null;
            setResumeUploaded(false);
            setResumeStatus(update.resumeFile ? 'reading' : 'idle');
            setResumeMessage(null);
            setBasicInfo({
                ...update,
                fullName: manuallyEdited.current.fullName ? update.fullName : '',
                email: manuallyEdited.current.email ? update.email : '',
                phone: manuallyEdited.current.phone ? update.phone : '',
                city: manuallyEdited.current.city ? update.city : '',
            });
            setSkills(previous => ({
                yearsExperience: manuallyEdited.current.yearsExperience ? previous.yearsExperience : '',
                skills: manuallyEdited.current.skills ? previous.skills : [],
                certifications: manuallyEdited.current.certifications ? previous.certifications : [],
                languages: manuallyEdited.current.languages ? previous.languages : [],
            }));
            return;
        }
        setBasicInfo(update);
    };

    const handleSkillsChange = (next: SkillsData) => {
        if (skills.yearsExperience !== next.yearsExperience) manuallyEdited.current.yearsExperience = true;
        for (const field of ['skills', 'certifications', 'languages'] as const) {
            if (!equalStrings(skills[field], next[field])) manuallyEdited.current[field] = true;
        }
        setSkills(next);
    };

    useEffect(() => {
        const file = basicInfo.resumeFile;
        if (!file) return;

        let active = true;
        const controller = new AbortController();
        const readResume = async () => {
            setResumeStatus('reading');
            setResumeMessage(null);
            let uploadComplete = mode === 'demo';
            try {
                let previewBody: Record<string, string>;
                const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                if (mode === 'production') {
                    if (!token) throw new Error('Missing invitation token');
                    headers.Authorization = `Bearer ${token}`;
                    let uploaded = uploadedResumeRef.current;
                    let storageAccepted = uploaded?.file === file;
                    if (uploaded?.file !== file) {
                        let pending = pendingResumeGrantRef.current;
                        if (pending?.file !== file) {
                            const grantResponse = await fetch('/api/application/resume-upload', {
                                method: 'POST',
                                headers,
                                body: JSON.stringify({ fileName: file.name, mimeType: file.type, size: file.size }),
                                signal: controller.signal,
                            });
                            const grant = parseUploadGrant(await grantResponse.json().catch(() => null));
                            if (!active) return;
                            if (grantResponse.status === 401) {
                                setStep('error');
                                return;
                            }
                            if (!grantResponse.ok || !grant) throw new Error('Resume upload could not be authorized');
                            pending = { file, grant, attempts: 0 };
                            pendingResumeGrantRef.current = pending;
                        }

                        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
                        const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
                        if (!supabaseUrl || !supabaseKey) throw new Error('Resume storage is unavailable');
                        const storage = createClient(supabaseUrl, supabaseKey, {
                            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
                        }).storage;
                        pending.attempts += 1;
                        const { error: storageError } = await storage.from('resumes').uploadToSignedUrl(
                            pending.grant.path, pending.grant.signedToken, file, { contentType: file.type },
                        );
                        if (!active) return;
                        storageAccepted = !storageError;
                        // A lost Storage response may still mean the object was saved.
                        // The server validates the registered object in preview.
                        uploaded = { file, id: pending.grant.id };
                        uploadedResumeRef.current = uploaded;
                    }
                    setResumeUploaded(storageAccepted);
                    uploadComplete = storageAccepted;
                    previewBody = { uploadId: uploaded.id };
                } else {
                    const cached = encodedResumeRef.current;
                    const fileData = cached?.file === file ? cached.fileData : await encodeResumeFile(file);
                    if (!active) return;
                    encodedResumeRef.current = { file, fileData };
                    previewBody = {
                        fileData,
                        fileName: file.name,
                        mimeType: file.type,
                        roleId: basicInfo.selectedRoleId,
                    };
                }
                const response = await fetch('/api/application/resume-preview', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(previewBody),
                    signal: controller.signal,
                });
                const payload: unknown = await response.json().catch(() => null);
                if (!active) return;
                if (mode === 'production' && response.status === 401) {
                    setStep('error');
                    return;
                }
                const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
                if (mode === 'production' && !response.ok && record?.error
                    && typeof record.error === 'object'
                    && (record.error as Record<string, unknown>).code === 'INVALID_RESUME') {
                    uploadedResumeRef.current = null;
                    if ((pendingResumeGrantRef.current?.attempts ?? 0) >= 2) {
                        pendingResumeGrantRef.current = null;
                    }
                    setResumeUploaded(false);
                    uploadComplete = false;
                }
                if (mode === 'production' && record?.error
                    && typeof record.error === 'object'
                    && (record.error as Record<string, unknown>).code === 'EXTRACTION_UNAVAILABLE') {
                    // The server verified the private object before OCR failed.
                    setResumeUploaded(true);
                    uploadComplete = true;
                }
                const parsed = ResumePrefillSchema.safeParse(record?.prefill);
                if (!response.ok || record?.success !== true || !parsed.success) throw new Error('Resume extraction failed');

                if (mode === 'production') setResumeUploaded(true);
                const prefill = parsed.data;
                setBasicInfo(previous => ({
                    ...previous,
                    fullName: manuallyEdited.current.fullName ? previous.fullName : prefill.fullName,
                    email: manuallyEdited.current.email ? previous.email : prefill.email,
                    phone: manuallyEdited.current.phone ? previous.phone : prefill.phone,
                    city: manuallyEdited.current.city ? previous.city : prefill.city,
                }));
                setSkills(previous => ({
                    yearsExperience: manuallyEdited.current.yearsExperience ? previous.yearsExperience : prefill.yearsExperience,
                    skills: manuallyEdited.current.skills ? previous.skills : prefill.skills,
                    certifications: manuallyEdited.current.certifications ? previous.certifications : prefill.certifications,
                    languages: manuallyEdited.current.languages ? previous.languages : prefill.languages,
                }));
                setResumeStatus('ready');
                const foundDetails = Boolean(
                    prefill.fullName || prefill.email || prefill.phone || prefill.city
                    || prefill.yearsExperience || prefill.skills.length
                    || prefill.certifications.length || prefill.languages.length,
                );
                setResumeMessage(foundDetails
                    ? 'Details found. Review and edit anything that is missing or incorrect.'
                    : 'No form details were recognized. Fill in the fields yourself; your resume will still be attached.');
            } catch {
                if (!active) return;
                setResumeStatus('error');
                setResumeMessage(uploadComplete
                    ? 'We could not read details from this resume. Enter them yourself; the file will still be attached when you submit.'
                    : 'Your resume could not be verified. Retry the upload before continuing.');
            }
        };
        void readResume();
        return () => {
            active = false;
            controller.abort();
        };
    }, [basicInfo.resumeFile, basicInfo.selectedRoleId, mode, token, uploadAttempt]);

    // Get the role based on what the candidate selected
    const selectedRole = getRoleOrDefault(basicInfo.selectedRoleId);
    const knockoutQuestions: RoleQuestion[] = selectedRole.questions.knockout;

    useEffect(() => {
        if (!token) {
            setStep('error');
            return;
        }

        if (mode === 'production') {
            const controller = new AbortController();
            const loadSession = async () => {
                try {
                    const response = await fetch(`/api/application/session?token=${encodeURIComponent(token)}`, {
                        cache: 'no-store',
                        signal: controller.signal,
                    });
                    const session = parseApplicationSession(await response.json().catch(() => null));
                    if (controller.signal.aborted) return;
                    if (!response.ok || !session?.roleId) {
                        setStep(response.status === 401 ? 'error' : 'serviceError');
                        return;
                    }
                    const roleId = session.roleId;
                    setPayload(session);
                    setBasicInfo(previous => ({ ...previous, selectedRoleId: roleId }));
                    setStep('welcome');
                } catch {
                    if (!controller.signal.aborted) setStep('serviceError');
                }
            };
            void loadSession();
            return () => controller.abort();
        }

        // Local demo invitations can use the existing unsigned sample payload.
        try {
            // Simple base64 decode of JWT payload (middle part)
            const parts = token.split('.');
            if (parts.length === 3) {
                const payloadStr = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
                const decoded = JSON.parse(payloadStr) as TokenPayload;
                setPayload(decoded);
                // If token includes roleId, pre-select it
                if (decoded.roleId) {
                    setBasicInfo(prev => ({ ...prev, selectedRoleId: decoded.roleId! }));
                }
                setStep('welcome');
            } else {
                // Mock token for testing
                setPayload({
                    candidateId: 'demo_1',
                    candidateName: 'Demo Candidate',
                    merchantName: "Cocoa Bakery",
                });
                setStep('welcome');
            }
        } catch {
            setPayload({
                candidateId: 'demo_1',
                candidateName: 'Demo Candidate',
                merchantName: "Cocoa Bakery",
            });
            setStep('welcome');
        }
    }, [mode, token, sessionAttempt]);

    useEffect(() => {
        if (step !== 'loading') transitionHeadingRef.current?.focus();
    }, [currentQuestion, step]);

    const handleAnswer = (questionId: string, answer: string | boolean) => {
        setAnswers(prev => ({ ...prev, [questionId]: answer }));

        // Every answer continues to submission. The server records configured flags for
        // human review; this client never makes an adverse hiring decision.
        if (currentQuestion < knockoutQuestions.length - 1) {
            setCurrentQuestion(prev => prev + 1);
        } else {
            setStep('profile');
        }
    };

    const getCurrentStepIndex = () => {
        return STEPS.findIndex(s => s.id === step);
    };

    const renderProgress = () => {
        const currentIndex = getCurrentStepIndex();
        if (currentIndex < 0) return null;

        return (
            <div className="mb-6" aria-label={`Application step ${currentIndex + 1} of ${STEPS.length}: ${STEPS[currentIndex]?.label}`}>
                <ol className="grid grid-cols-5 gap-1 mb-2" aria-hidden="true">
                    {STEPS.map((s, i) => (
                        <li key={s.id} className="flex min-w-0 items-center justify-center">
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors ${i < currentIndex ? 'bg-lime-500 text-white' :
                                i === currentIndex ? 'bg-lime-100 text-lime-700 border-2 border-lime-500' :
                                    'bg-stone-100 text-stone-400'
                                }`}>
                                {i < currentIndex ? '✓' : i + 1}
                            </div>
                        </li>
                    ))}
                </ol>
                <p className="text-center text-sm text-stone-500">
                    {STEPS[currentIndex]?.label}
                </p>
            </div>
        );
    };

    const handleSubmitApplication = async () => {
        const resumeFile = basicInfo.resumeFile;
        if (!resumeFile) {
            setResumeStatus('error');
            setResumeMessage('A resume is required to submit your application.');
            setStep('basicInfo');
            return;
        }
        const uploaded = uploadedResumeRef.current;
        if (mode === 'production' && (!resumeUploaded || uploaded?.file !== resumeFile)) {
            setResumeStatus('error');
            setResumeMessage('Your resume did not upload. Retry the upload before continuing.');
            setStep('basicInfo');
            return;
        }
        setSubmitting(true);
        setSubmissionFailure(null);

        const recoverSavedApplication = async (): Promise<boolean> => {
            if (mode !== 'production' || !token || !uploaded) return false;
            try {
                const receiptResponse = await fetch(
                    `/api/application/receipt?uploadId=${encodeURIComponent(uploaded.id)}`,
                    { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
                );
                const receipt = parseApplicationApiResult(await receiptResponse.json().catch(() => null));
                if (!receiptResponse.ok || !receipt?.success) return false;
                setApplicationId(receipt.applicationId);
                setStep(receipt.passed ? 'complete' : 'needsReview');
                return true;
            } catch {
                return false;
            }
        };

        try {
            let attachment: { uploadId: string } | { resume: { fileData: string; fileName: string; mimeType: string } };
            if (mode === 'production') {
                attachment = { uploadId: uploaded!.id };
            } else {
                const cached = encodedResumeRef.current;
                const fileData = cached?.file === resumeFile
                    ? cached.fileData
                    : await encodeResumeFile(resumeFile);
                encodedResumeRef.current = { file: resumeFile, fileData };
                attachment = { resume: { fileData, fileName: resumeFile.name, mimeType: resumeFile.type } };
            }
            const applicationData = {
                ...(mode === 'demo' ? { candidateId: payload?.candidateId } : {}),
                roleId: basicInfo.selectedRoleId,
                basicInfo: {
                    fullName: basicInfo.fullName,
                    email: basicInfo.email,
                    phone: basicInfo.phone,
                    city: basicInfo.city,
                },
                knockoutAnswers: answers,
                profile,
                skills,
                motivation,
                ...attachment,
            };
            const res = await fetch('/api/application', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(mode === 'production' && token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify(applicationData),
            });

            const result = parseApplicationApiResult(await res.json().catch(() => null));
            if (res.ok && result?.success) {
                setApplicationId(result.applicationId);
                setStep(result.passed ? 'complete' : 'needsReview');
                return;
            }
            if (await recoverSavedApplication()) return;

            if (mode === 'production' && result && !result.success
                && result.error.code === 'INVALID_RESUME') {
                uploadedResumeRef.current = null;
                setResumeUploaded(false);
                setResumeStatus('error');
                setResumeMessage('Your resume could not be verified. Retry the upload before continuing.');
                setStep('basicInfo');
                return;
            }

            setSubmissionFailure(result && !result.success
                ? result.error
                : {
                    message: 'The application was not saved. Your answers are still here; please try again.',
                    retryable: true,
                });
        } catch {
            if (await recoverSavedApplication()) return;
            setSubmissionFailure({
                message: 'We could not reach the application service. Your answers are still here; please try again.',
                retryable: true,
            });
        } finally {
            setSubmitting(false);
        }
    };

    const renderContent = () => {
        switch (step) {
            case 'loading':
                return (
                    <div className="text-center py-20">
                        <div aria-hidden="true" className="animate-spin h-8 w-8 border-4 border-lime-500 border-t-transparent rounded-full mx-auto mb-4"></div>
                        <p className="text-stone-500" role="status">Loading your application...</p>
                    </div>
                );

            case 'error':
                return (
                    <div className="text-center py-20">
                        <div className="text-5xl mb-4">🔗</div>
                        <h2 ref={transitionHeadingRef} tabIndex={-1} className="text-2xl font-semibold text-stone-800 mb-2 focus:outline-none">Invalid Link</h2>
                        <p className="text-stone-500">This link is invalid or has expired. Please contact the employer for a new link.</p>
                    </div>
                );

            case 'serviceError':
                return (
                    <div className="text-center py-20">
                        <h2 ref={transitionHeadingRef} tabIndex={-1} className="text-2xl font-semibold text-stone-800 mb-2 focus:outline-none">Application unavailable</h2>
                        <p className="text-stone-600 mb-5">We could not check your application link right now. Please try again.</p>
                        <Button onClick={() => { setStep('loading'); setSessionAttempt(value => value + 1); }}>
                            Try again
                        </Button>
                    </div>
                );

            case 'welcome':
                return (
                    <div className="text-center py-10">
                        <div className="text-6xl mb-6">☕</div>
                        <h2 ref={transitionHeadingRef} tabIndex={-1} className="text-2xl font-semibold text-stone-800 mb-3 focus:outline-none">
                            Welcome{payload?.candidateName ? `, ${payload.candidateName}` : ''}!
                        </h2>
                        <p className="text-lg text-stone-600 mb-2">
                            {payload?.merchantName || 'Our team'} is excited to learn more about you.
                        </p>
                        <p className="text-stone-600 mb-8">
                            This takes about 3-5 minutes. Let&apos;s get started!
                        </p>
                        <Button
                            size="lg"
                            className="text-lg px-8 py-6 bg-lime-500 hover:bg-lime-600 text-white rounded-xl font-medium shadow-sm"
                            onClick={() => setStep('basicInfo')}
                        >
                            Let&apos;s Go! 🚀
                        </Button>
                    </div>
                );

            case 'basicInfo':
                return (
                    <div>
                        {renderProgress()}
                        <div className="text-center mb-4">
                            <h2 ref={transitionHeadingRef} tabIndex={-1} className="text-xl font-semibold text-stone-800 focus:outline-none">👋 Tell us about yourself</h2>
                            <p className="text-sm text-stone-600">We&apos;ll use this to stay in touch</p>
                        </div>
                        <BasicInfo
                            data={basicInfo}
                            onChange={handleBasicInfoChange}
                            resumeStatus={resumeStatus}
                            resumeMessage={resumeMessage}
                            resumeUploaded={mode === 'demo' || resumeUploaded}
                            onRetryUpload={mode === 'production' ? () => setUploadAttempt(previous => previous + 1) : undefined}
                            roleLocked={mode === 'production'}
                            onNext={() => {
                                // Reset knockout state when role changes
                                setCurrentQuestion(0);
                                setAnswers({});
                                setStep('questions');
                            }}
                        />
                    </div>
                );

            case 'questions': {
                const question = knockoutQuestions[currentQuestion];
                if (!question) {
                    return (
                        <div role="alert" className="py-10 text-center text-red-700">
                            This role has no question configured. Please contact the employer.
                        </div>
                    );
                }
                const selectedAnswer = answers[question.id];
                return (
                    <div className="py-6">
                        {renderProgress()}
                        <div className="mb-6">
                            <div className="flex justify-between items-center mb-3">
                                <Badge variant="secondary" className="bg-stone-100 text-stone-600 font-medium">
                                    Question {currentQuestion + 1} of {knockoutQuestions.length}
                                </Badge>
                                <Badge className="bg-red-100 text-red-700 font-medium">Required</Badge>
                            </div>
                            <div className="flex items-center gap-2 px-3 py-1.5 bg-lime-50 border border-lime-200 rounded-lg mb-4">
                                <span className="text-sm">{selectedRole.emoji}</span>
                                <span className="text-xs font-medium text-lime-700">{selectedRole.title} Position</span>
                            </div>
                        </div>

                        <h3 ref={transitionHeadingRef} tabIndex={-1} className="text-xl font-semibold text-stone-800 mb-8 focus:outline-none">{question.question}</h3>

                        {question.type === 'boolean' && (
                            <div className="flex flex-col min-[390px]:flex-row gap-3 min-[390px]:gap-4">
                                <Button
                                    size="lg"
                                    variant="outline"
                                    aria-pressed={selectedAnswer === true}
                                    className={`flex-1 text-lg py-8 rounded-xl ${selectedAnswer === true
                                        ? 'border-lime-600 bg-lime-600 text-white hover:bg-lime-700'
                                        : 'border-stone-300 text-stone-700 hover:bg-stone-100'
                                        }`}
                                    onClick={() => handleAnswer(question.id, true)}
                                >
                                    ✓ Yes
                                </Button>
                                <Button
                                    size="lg"
                                    variant="outline"
                                    aria-pressed={selectedAnswer === false}
                                    className={`flex-1 text-lg py-8 rounded-xl ${selectedAnswer === false
                                        ? 'border-stone-800 bg-stone-800 text-white hover:bg-stone-900'
                                        : 'border-stone-300 text-stone-700 hover:bg-stone-100'
                                        }`}
                                    onClick={() => handleAnswer(question.id, false)}
                                >
                                    ✗ No
                                </Button>
                            </div>
                        )}

                        {question.type === 'select' && question.options && (
                            <div className="space-y-3">
                                {question.options.map((option, i) => (
                                    <Button
                                        key={i}
                                        size="lg"
                                        variant="outline"
                                        aria-pressed={selectedAnswer === option}
                                        className={`w-full text-left text-base py-5 justify-start rounded-xl ${selectedAnswer === option
                                            ? 'border-lime-600 bg-lime-50 text-lime-900 hover:bg-lime-100'
                                            : 'border-stone-200 text-stone-700 hover:bg-stone-50 hover:border-stone-300'
                                            }`}
                                        onClick={() => handleAnswer(question.id, option)}
                                    >
                                        {option}
                                    </Button>
                                ))}
                            </div>
                        )}

                        <Button
                            type="button"
                            variant="ghost"
                            className="mt-6 min-h-11 text-stone-600 hover:text-stone-800"
                            onClick={() => {
                                if (currentQuestion === 0) {
                                    setStep('basicInfo');
                                    return;
                                }
                                setCurrentQuestion(previous => previous - 1);
                            }}
                        >
                            ← Back and review
                        </Button>
                    </div>
                );
            }

            case 'profile':
                return (
                    <div>
                        {renderProgress()}
                        <div className="text-center mb-4">
                            <h2 ref={transitionHeadingRef} tabIndex={-1} className="text-xl font-semibold text-stone-800 focus:outline-none">📋 Tell us about your availability</h2>
                            <p className="text-sm text-stone-600">So we can understand your availability</p>
                        </div>
                        <CandidateProfile
                            data={profile}
                            onChange={setProfile}
                            onNext={() => setStep('skills')}
                            onBack={() => {
                                setCurrentQuestion(knockoutQuestions.length - 1);
                                setStep('questions');
                            }}
                        />
                    </div>
                );

            case 'skills':
                return (
                    <div>
                        {renderProgress()}
                        <div className="text-center mb-4">
                            <h2 ref={transitionHeadingRef} tabIndex={-1} className="text-xl font-semibold text-stone-800 focus:outline-none">💼 Your Skills & Experience</h2>
                            <p className="text-sm text-stone-600">Share the experience and skills you want reviewed</p>
                        </div>
                        <SkillsExperience
                            data={skills}
                            onChange={handleSkillsChange}
                            onNext={() => setStep('motivation')}
                            onBack={() => setStep('profile')}
                            roleId={basicInfo.selectedRoleId}
                        />
                    </div>
                );

            case 'motivation':
                return (
                    <div>
                        {renderProgress()}
                        <div className="text-center mb-4">
                            <h2 ref={transitionHeadingRef} tabIndex={-1} className="text-xl font-semibold text-stone-800 focus:outline-none">💬 Almost there!</h2>
                            <p className="text-sm text-stone-600">Help reviewers understand your interest</p>
                        </div>
                        <MotivationQuestions
                            data={motivation}
                            onChange={setMotivation}
                            onNext={() => setStep('passed')}
                            onBack={() => setStep('skills')}
                            merchantName={payload?.merchantName}
                            roleId={basicInfo.selectedRoleId}
                        />
                    </div>
                );

            case 'passed':
                return (
                    <div className="text-center py-10">
                        <div className="text-6xl mb-6" aria-hidden="true">📝</div>
                        <h2 ref={transitionHeadingRef} tabIndex={-1} className="text-2xl font-semibold mb-3 text-stone-800 focus:outline-none">
                            Ready to submit
                        </h2>
                        <p className="text-lg text-stone-600 mb-6">
                            Reviewers at {payload?.merchantName || 'the team'} will evaluate your answers after submission.
                        </p>
                        {basicInfo.resumeFile && (
                            <p className="mb-4 rounded-lg bg-lime-50 p-3 text-sm text-lime-900">
                                Your resume, {basicInfo.resumeFile.name}, will be attached to this application. You can go back to correct any filled details.
                            </p>
                        )}
                        {submissionFailure && (
                            <div
                                role="alert"
                                className="mb-4 rounded-xl border border-red-300 bg-red-50 p-4 text-left text-sm text-red-900"
                            >
                                <p className="font-medium">Submission not completed</p>
                                <p className="mt-1">{submissionFailure.message}</p>
                                {!submissionFailure.retryable && (
                                    <p className="mt-1">Please contact the employer before submitting again.</p>
                                )}
                            </div>
                        )}
                        <div className="space-y-3">
                            <Button
                                size="lg"
                                className="w-full text-lg py-6 bg-lime-500 hover:bg-lime-600 text-white rounded-xl font-medium"
                                onClick={handleSubmitApplication}
                                disabled={submitting || submissionFailure?.retryable === false}
                            >
                                {submitting ? 'Submitting application…' : submissionFailure?.retryable ? 'Try submission again' : 'Submit application'}
                            </Button>
                            <Button
                                variant="ghost"
                                onClick={() => {
                                    setSubmissionFailure(null);
                                    setStep('motivation');
                                }}
                                className="text-stone-600 hover:text-stone-800"
                                disabled={submitting}
                            >
                                ← Go back and review
                            </Button>
                        </div>
                    </div>
                );

            case 'complete':
                return (
                    <div className="text-center py-10">
                        <div className="text-6xl mb-6">✅</div>
                        <h2 ref={transitionHeadingRef} tabIndex={-1} className="text-2xl font-semibold mb-3 text-lime-700 focus:outline-none">
                            Application received
                        </h2>
                        <p className="text-lg text-stone-600 mb-2">
                            Your answers were saved for manager review. No interview has been scheduled.
                        </p>
                        <div className="bg-lime-50 rounded-xl p-4 mt-6 text-left">
                            <p className="text-sm font-medium text-lime-800 mb-2">What&apos;s next?</p>
                            <ul className="text-sm text-lime-700 space-y-1">
                                <li>• The manager will review your application</li>
                                <li>• The employer decides whether and when to contact you</li>
                            </ul>
                        </div>
                        {applicationId && (
                            <p className="mt-4 break-all text-xs text-stone-500">
                                Application reference: {applicationId}
                            </p>
                        )}
                        <p className="text-stone-600 mt-6 text-sm">
                            You can close this page now.
                        </p>
                    </div>
                );

            case 'needsReview':
                return (
                    <div className="text-center py-10">
                        <div className="text-6xl mb-6" aria-hidden="true">📝</div>
                        <h2 ref={transitionHeadingRef} tabIndex={-1} className="text-2xl font-semibold mb-3 text-stone-800 focus:outline-none">
                            Application received for review
                        </h2>
                        <p className="text-stone-600">
                            Your answers and candidate record were saved. One or more configured
                            responses were flagged for an authorized human reviewer; no automated
                            rejection or interview decision was made.
                        </p>
                        {applicationId && (
                            <p className="mt-4 break-all text-xs text-stone-500">
                                Application reference: {applicationId}
                            </p>
                        )}
                    </div>
                );
        }
    };

    return (
        <Card className="w-full min-w-0 max-w-lg overflow-hidden bg-white border-stone-200 shadow-lg rounded-2xl">
            <CardHeader className="text-center border-b border-stone-100 px-4 pb-4 sm:px-6">
                <CardTitle className="flex items-center justify-center gap-2 text-xl font-semibold text-stone-800">
                    <span aria-hidden="true">🌿</span>
                    <h1>TeamFlow</h1>
                </CardTitle>
                {payload?.merchantName && (
                    <p className="text-stone-600 text-sm">Application for {payload.merchantName}</p>
                )}
                {mode === 'demo' && (
                    <p className="rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-900">
                        Local demo — not a production authentication or hiring workflow
                    </p>
                )}
            </CardHeader>
            <CardContent className="min-w-0 px-4 pt-6 sm:px-6" aria-busy={submitting}>
                <p className="sr-only" aria-live="polite">
                    {step === 'complete' ? 'Application received' : STEPS.find(item => item.id === step)?.label || step}
                </p>
                {renderContent()}
            </CardContent>
        </Card>
    );
}

function LoadingFallback() {
    return (
        <Card className="w-full min-w-0 max-w-lg overflow-hidden bg-white border-stone-200 shadow-lg rounded-2xl">
            <CardHeader className="text-center border-b border-stone-100 pb-4">
                <CardTitle className="flex items-center justify-center gap-2 text-xl font-semibold text-stone-800">
                    <span aria-hidden="true">🌿</span>
                    <h1>TeamFlow</h1>
                </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
                <div className="text-center py-20">
                    <div aria-hidden="true" className="animate-spin h-8 w-8 border-4 border-lime-500 border-t-transparent rounded-full mx-auto mb-4"></div>
                    <p className="text-stone-500" role="status">Loading your application...</p>
                </div>
            </CardContent>
        </Card>
    );
}

export function ApplicationFlow({ mode }: { mode: ApplicationMode }) {
    return (
        <main className="min-h-screen min-w-0 bg-stone-50 flex items-start justify-center px-2 py-4 sm:items-center sm:p-4">
            <Suspense fallback={<LoadingFallback />}>
                <ApplyPageContent mode={mode} />
            </Suspense>
        </main>
    );
}
