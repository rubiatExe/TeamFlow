"use client";

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { BasicInfo, BasicInfoData } from '@/components/candidate-application/basic-info';
import { CandidateProfile, ProfileData } from '@/components/candidate-application/candidate-profile';
import { SkillsExperience, SkillsData } from '@/components/candidate-application/skills-experience';
import { MotivationQuestions, MotivationData } from '@/components/candidate-application/motivation-questions';
import {
    getRoleOrDefault,
    type RoleQuestion,
} from '@/lib/domain/roles';

interface TokenPayload {
    candidateId: string;
    candidateName: string;
    merchantName?: string;
    jobId?: string;
    roleId?: string;
}

type Step = 'loading' | 'welcome' | 'basicInfo' | 'questions' | 'profile' | 'skills' | 'motivation' | 'passed' | 'needsReview' | 'complete' | 'error';

type SubmissionFailure = {
    message: string;
    retryable: boolean;
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
        error: { message: error.message, retryable: error.retryable },
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

function ApplyPageContent() {
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
        languages: ['english'],
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
        resumeFile: null,
        resumeUploading: false,
        selectedRoleId: 'barista',
    });

    // Get the role based on what the candidate selected
    const selectedRole = getRoleOrDefault(basicInfo.selectedRoleId);
    const knockoutQuestions: RoleQuestion[] = selectedRole.questions.knockout;

    useEffect(() => {
        if (!token) {
            setStep('error');
            return;
        }

        // In production, verify token via API. For demo, decode locally.
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
    }, [token]);

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
        setSubmitting(true);
        setSubmissionFailure(null);

        const applicationData = {
            candidateId: payload?.candidateId,
            roleId: basicInfo.selectedRoleId,
            basicInfo: {
                fullName: basicInfo.fullName,
                email: basicInfo.email,
                phone: basicInfo.phone,
            },
            knockoutAnswers: answers,
            profile,
            skills,
            motivation,
        };

        try {
            const res = await fetch('/api/application', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(applicationData),
            });

            const result = parseApplicationApiResult(await res.json().catch(() => null));
            if (res.ok && result?.success) {
                setApplicationId(result.applicationId);
                setStep(result.passed ? 'complete' : 'needsReview');
                return;
            }

            setSubmissionFailure(result && !result.success
                ? result.error
                : {
                    message: 'The application was not saved. Your answers are still here; please try again.',
                    retryable: true,
                });
        } catch {
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

            case 'welcome':
                return (
                    <div className="text-center py-10">
                        <div className="text-6xl mb-6">☕</div>
                        <h2 ref={transitionHeadingRef} tabIndex={-1} className="text-2xl font-semibold text-stone-800 mb-3 focus:outline-none">
                            Welcome, {payload?.candidateName}!
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
                            onChange={setBasicInfo}
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
                            This demo role has no question configured. Go back and choose another role.
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
                            onChange={setSkills}
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
                            <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                                Your selected resume is not uploaded by this demo form. Only the answers shown here will be submitted.
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
                                onClick={() => setStep('motivation')}
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
                <p className="rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-900">
                    Local demo — not a production authentication or hiring workflow
                </p>
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

export function ApplicationFlow() {
    return (
        <main className="min-h-screen min-w-0 bg-stone-50 flex items-start justify-center px-2 py-4 sm:items-center sm:p-4">
            <Suspense fallback={<LoadingFallback />}>
                <ApplyPageContent />
            </Suspense>
        </main>
    );
}
