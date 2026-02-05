"use client";

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { BasicInfo, BasicInfoData } from '@/components/candidate-portal/BasicInfo';
import { CandidateProfile, ProfileData } from '@/components/candidate-portal/CandidateProfile';
import { SkillsExperience, SkillsData } from '@/components/candidate-portal/SkillsExperience';
import { MotivationQuestions, MotivationData } from '@/components/candidate-portal/MotivationQuestions';

interface TokenPayload {
    candidateId: string;
    candidateName: string;
    merchantName?: string;
    jobId?: string;
}

type Step = 'loading' | 'welcome' | 'basicInfo' | 'questions' | 'profile' | 'skills' | 'motivation' | 'passed' | 'failed' | 'complete' | 'error';

interface Question {
    id: string;
    text: string;
    type: 'boolean' | 'choice' | 'text';
    required: boolean;
    dealbreaker?: boolean;
    options?: string[];
}

// Sample knockout questions (would come from Hiring Persona in production)
const knockoutQuestions: Question[] = [
    {
        id: 'age',
        text: 'Are you at least 18 years of age?',
        type: 'boolean',
        required: true,
        dealbreaker: true,
    },
    {
        id: 'work_auth',
        text: 'Are you legally authorized to work in the United States?',
        type: 'boolean',
        required: true,
        dealbreaker: true,
    },
    {
        id: 'weekends',
        text: 'Can you work weekends (Saturdays and Sundays)?',
        type: 'boolean',
        required: true,
        dealbreaker: true,
    },
];

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
    });

    const [basicInfo, setBasicInfo] = useState<BasicInfoData>({
        fullName: '',
        email: '',
        phone: '',
        resumeFile: null,
        resumeUploading: false,
    });

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
                setStep('welcome');
            } else {
                // Mock token for testing
                setPayload({
                    candidateId: 'demo_1',
                    candidateName: 'Demo Candidate',
                    merchantName: "Joe's Coffee",
                });
                setStep('welcome');
            }
        } catch {
            setPayload({
                candidateId: 'demo_1',
                candidateName: 'Demo Candidate',
                merchantName: "Joe's Coffee",
            });
            setStep('welcome');
        }
    }, [token]);

    const handleAnswer = (questionId: string, answer: string | boolean) => {
        const question = knockoutQuestions[currentQuestion];
        setAnswers(prev => ({ ...prev, [questionId]: answer }));

        // Check if dealbreaker failed
        if (question.dealbreaker && answer === false) {
            setStep('failed');
            return;
        }

        // Move to next question or proceed to profile
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
            <div className="mb-6">
                <div className="flex justify-between items-center mb-2">
                    {STEPS.map((s, i) => (
                        <div key={s.id} className="flex items-center">
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors ${i < currentIndex ? 'bg-lime-500 text-white' :
                                i === currentIndex ? 'bg-lime-100 text-lime-700 border-2 border-lime-500' :
                                    'bg-stone-100 text-stone-400'
                                }`}>
                                {i < currentIndex ? '✓' : i + 1}
                            </div>
                            {i < STEPS.length - 1 && (
                                <div className={`w-12 h-1 mx-1 rounded ${i < currentIndex ? 'bg-lime-500' : 'bg-stone-200'
                                    }`} />
                            )}
                        </div>
                    ))}
                </div>
                <p className="text-center text-sm text-stone-500">
                    {STEPS[currentIndex]?.label}
                </p>
            </div>
        );
    };

    const handleSubmitApplication = () => {
        // In production, send all data to API
        console.log('Application submitted:', {
            candidateId: payload?.candidateId,
            basicInfo: {
                fullName: basicInfo.fullName,
                email: basicInfo.email,
                phone: basicInfo.phone,
                hasResume: !!basicInfo.resumeFile,
            },
            knockoutAnswers: answers,
            profile,
            skills,
            motivation,
            submittedAt: new Date().toISOString(),
        });
        setStep('complete');
    };

    const renderContent = () => {
        switch (step) {
            case 'loading':
                return (
                    <div className="text-center py-20">
                        <div className="animate-spin h-8 w-8 border-4 border-lime-500 border-t-transparent rounded-full mx-auto mb-4"></div>
                        <p className="text-stone-400">Loading your application...</p>
                    </div>
                );

            case 'error':
                return (
                    <div className="text-center py-20">
                        <div className="text-5xl mb-4">🔗</div>
                        <h2 className="text-2xl font-semibold text-stone-800 mb-2">Invalid Link</h2>
                        <p className="text-stone-500">This link is invalid or has expired. Please contact the employer for a new link.</p>
                    </div>
                );

            case 'welcome':
                return (
                    <div className="text-center py-10">
                        <div className="text-6xl mb-6">☕</div>
                        <h2 className="text-2xl font-semibold text-stone-800 mb-3">
                            Welcome, {payload?.candidateName}!
                        </h2>
                        <p className="text-lg text-stone-600 mb-2">
                            {payload?.merchantName || 'Our team'} is excited to learn more about you.
                        </p>
                        <p className="text-stone-400 mb-8">
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
                            <h2 className="text-xl font-semibold text-stone-800">👋 Tell us about yourself</h2>
                            <p className="text-sm text-stone-400">We&apos;ll use this to stay in touch</p>
                        </div>
                        <BasicInfo
                            data={basicInfo}
                            onChange={setBasicInfo}
                            onNext={() => setStep('questions')}
                        />
                    </div>
                );

            case 'questions':
                const question = knockoutQuestions[currentQuestion];
                return (
                    <div className="py-6">
                        {renderProgress()}
                        <div className="mb-6">
                            <div className="flex justify-between items-center mb-3">
                                <Badge variant="secondary" className="bg-stone-100 text-stone-600 font-medium">
                                    Question {currentQuestion + 1} of {knockoutQuestions.length}
                                </Badge>
                                {question.dealbreaker && (
                                    <Badge className="bg-red-100 text-red-700 font-medium">Required</Badge>
                                )}
                            </div>
                        </div>

                        <h3 className="text-xl font-semibold text-stone-800 mb-8">{question.text}</h3>

                        {question.type === 'boolean' && (
                            <div className="flex gap-4">
                                <Button
                                    size="lg"
                                    className="flex-1 text-lg py-8 bg-lime-500 hover:bg-lime-600 text-white rounded-xl"
                                    onClick={() => handleAnswer(question.id, true)}
                                >
                                    ✓ Yes
                                </Button>
                                <Button
                                    size="lg"
                                    variant="outline"
                                    className="flex-1 text-lg py-8 border-stone-300 text-stone-600 hover:bg-stone-100 rounded-xl"
                                    onClick={() => handleAnswer(question.id, false)}
                                >
                                    ✗ No
                                </Button>
                            </div>
                        )}

                        {question.type === 'choice' && question.options && (
                            <div className="space-y-3">
                                {question.options.map((option, i) => (
                                    <Button
                                        key={i}
                                        size="lg"
                                        variant="outline"
                                        className="w-full text-left text-base py-5 justify-start border-stone-200 text-stone-700 hover:bg-stone-50 hover:border-stone-300 rounded-xl"
                                        onClick={() => handleAnswer(question.id, option)}
                                    >
                                        {option}
                                    </Button>
                                ))}
                            </div>
                        )}
                    </div>
                );

            case 'profile':
                return (
                    <div>
                        {renderProgress()}
                        <div className="text-center mb-4">
                            <h2 className="text-xl font-semibold text-stone-800">📋 Tell us about your availability</h2>
                            <p className="text-sm text-stone-400">So we can find the perfect fit</p>
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
                            <h2 className="text-xl font-semibold text-stone-800">💼 Your Skills & Experience</h2>
                            <p className="text-sm text-stone-400">No experience? No problem—we train!</p>
                        </div>
                        <SkillsExperience
                            data={skills}
                            onChange={setSkills}
                            onNext={() => setStep('motivation')}
                            onBack={() => setStep('profile')}
                        />
                    </div>
                );

            case 'motivation':
                return (
                    <div>
                        {renderProgress()}
                        <div className="text-center mb-4">
                            <h2 className="text-xl font-semibold text-stone-800">💬 Almost there!</h2>
                            <p className="text-sm text-stone-400">Help us get to know you better</p>
                        </div>
                        <MotivationQuestions
                            data={motivation}
                            onChange={setMotivation}
                            onNext={() => setStep('passed')}
                            onBack={() => setStep('skills')}
                            merchantName={payload?.merchantName}
                        />
                    </div>
                );

            case 'passed':
                return (
                    <div className="text-center py-10">
                        <div className="text-6xl mb-6">🎉</div>
                        <h2 className="text-2xl font-semibold mb-3 text-lime-600">
                            You&apos;re a Great Fit!
                        </h2>
                        <p className="text-lg text-stone-600 mb-6">
                            {payload?.merchantName || 'The team'} would love to meet you.
                        </p>
                        <div className="space-y-3">
                            <Button
                                size="lg"
                                className="w-full text-lg py-6 bg-lime-500 hover:bg-lime-600 text-white rounded-xl font-medium"
                                onClick={handleSubmitApplication}
                            >
                                Submit & Schedule Interview 📅
                            </Button>
                            <Button
                                variant="ghost"
                                onClick={() => setStep('motivation')}
                                className="text-stone-400 hover:text-stone-600"
                            >
                                ← Go back and review
                            </Button>
                        </div>
                    </div>
                );

            case 'failed':
                return (
                    <div className="text-center py-10">
                        <div className="text-6xl mb-6">💼</div>
                        <h2 className="text-xl font-semibold text-stone-800 mb-3">
                            Thanks for Your Interest
                        </h2>
                        <p className="text-stone-600 mb-4">
                            Unfortunately, this position requires specific qualifications that don&apos;t match your current situation.
                        </p>
                        <p className="text-stone-400">
                            We appreciate you taking the time to apply and wish you the best in your job search!
                        </p>
                    </div>
                );

            case 'complete':
                return (
                    <div className="text-center py-10">
                        <div className="text-6xl mb-6">✅</div>
                        <h2 className="text-2xl font-semibold mb-3 text-lime-600">
                            Application Complete!
                        </h2>
                        <p className="text-lg text-stone-600 mb-2">
                            We&apos;ll be in touch soon to confirm your interview.
                        </p>
                        <div className="bg-lime-50 rounded-xl p-4 mt-6 text-left">
                            <p className="text-sm font-medium text-lime-800 mb-2">📱 What&apos;s next?</p>
                            <ul className="text-sm text-lime-700 space-y-1">
                                <li>• You&apos;ll receive a confirmation text/email</li>
                                <li>• The manager will review your application</li>
                                <li>• Expect to hear back within 24-48 hours</li>
                            </ul>
                        </div>
                        <p className="text-stone-400 mt-6 text-sm">
                            You can close this page now.
                        </p>
                    </div>
                );
        }
    };

    return (
        <Card className="w-full max-w-lg bg-white border-stone-200 shadow-lg rounded-2xl">
            <CardHeader className="text-center border-b border-stone-100 pb-4">
                <CardTitle className="flex items-center justify-center gap-2 text-xl font-semibold text-stone-800">
                    <span>🌿</span>
                    <span>TeamFlow</span>
                </CardTitle>
                {payload?.merchantName && (
                    <p className="text-stone-400 text-sm">Application for {payload.merchantName}</p>
                )}
            </CardHeader>
            <CardContent className="pt-6">
                {renderContent()}
            </CardContent>
        </Card>
    );
}

function LoadingFallback() {
    return (
        <Card className="w-full max-w-lg bg-white border-stone-200 shadow-lg rounded-2xl">
            <CardHeader className="text-center border-b border-stone-100 pb-4">
                <CardTitle className="flex items-center justify-center gap-2 text-xl font-semibold text-stone-800">
                    <span>🌿</span>
                    <span>TeamFlow</span>
                </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
                <div className="text-center py-20">
                    <div className="animate-spin h-8 w-8 border-4 border-lime-500 border-t-transparent rounded-full mx-auto mb-4"></div>
                    <p className="text-stone-400">Loading your application...</p>
                </div>
            </CardContent>
        </Card>
    );
}

export default function ApplyPage() {
    return (
        <div className="min-h-screen bg-stone-50 flex items-center justify-center p-4">
            <Suspense fallback={<LoadingFallback />}>
                <ApplyPageContent />
            </Suspense>
        </div>
    );
}

