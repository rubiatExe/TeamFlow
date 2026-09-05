"use client";

import React, { useCallback, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { CAFE_ROLES } from '@/lib/domain/roles';

export interface BasicInfoData {
    fullName: string;
    email: string;
    phone: string;
    resumeFile: File | null;
    resumeUploading: boolean;
    selectedRoleId: string;
}

interface BasicInfoProps {
    data: BasicInfoData;
    onChange: (data: BasicInfoData) => void;
    onNext: () => void;
}

const MAX_RESUME_BYTES = 10 * 1024 * 1024;
const RESUME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);

function validateResumeFile(file: File): string | null {
    if (!RESUME_TYPES.has(file.type)) return 'Choose a PDF, JPG, or PNG file.';
    if (file.size > MAX_RESUME_BYTES) return 'Choose a file smaller than 10 MB.';
    return null;
}

export function BasicInfo({ data, onChange, onNext }: BasicInfoProps) {
    const [dragActive, setDragActive] = useState(false);
    const [fileError, setFileError] = useState<string | null>(null);
    const fileInputId = useId();
    const roleHelpId = useId();
    const resumeHelpId = useId();

    const selectFile = useCallback((file: File) => {
        const error = validateResumeFile(file);
        setFileError(error);
        if (!error) onChange({ ...data, resumeFile: file });
    }, [data, onChange]);

    const handleDrag = useCallback((event: React.DragEvent<HTMLLabelElement>) => {
        event.preventDefault();
        event.stopPropagation();
        setDragActive(event.type === 'dragenter' || event.type === 'dragover');
    }, []);

    const handleDrop = useCallback((event: React.DragEvent<HTMLLabelElement>) => {
        event.preventDefault();
        event.stopPropagation();
        setDragActive(false);
        const file = event.dataTransfer.files[0];
        if (file) selectFile(file);
    }, [selectFile]);

    const handleFileInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) selectFile(file);
        event.target.value = '';
    }, [selectFile]);

    const formatPhone = (value: string) => {
        const numbers = value.replace(/\D/g, '');
        if (numbers.length <= 3) return numbers;
        if (numbers.length <= 6) return `(${numbers.slice(0, 3)}) ${numbers.slice(3)}`;
        return `(${numbers.slice(0, 3)}) ${numbers.slice(3, 6)}-${numbers.slice(6, 10)}`;
    };

    const isValid = data.fullName.trim().length >= 2
        && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)
        && data.phone.replace(/\D/g, '').length >= 10
        && data.selectedRoleId !== '';

    return (
        <div className="py-4 space-y-5">
            <fieldset aria-describedby={roleHelpId}>
                <legend className="text-base font-semibold text-stone-800">
                    What position are you applying for? <span aria-hidden="true" className="text-red-600">*</span>
                </legend>
                <p id={roleHelpId} className="mb-2 text-xs text-stone-500">Choose one required position.</p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {CAFE_ROLES.map(role => {
                        const selected = data.selectedRoleId === role.id;
                        return (
                            <button
                                key={role.id}
                                type="button"
                                aria-pressed={selected}
                                onClick={() => onChange({ ...data, selectedRoleId: role.id })}
                                className={`min-h-12 p-3 rounded-xl text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-600 focus-visible:ring-offset-2 ${selected
                                    ? 'bg-lime-100 border-2 border-lime-600'
                                    : 'bg-stone-50 border-2 border-stone-200 hover:border-stone-400'
                                    }`}
                            >
                                <span className="flex min-w-0 items-center gap-2">
                                    <span aria-hidden="true" className="text-xl">{role.emoji}</span>
                                    <span className="min-w-0">
                                        <span className={`block text-sm font-medium ${selected ? 'text-lime-900' : 'text-stone-700'}`}>
                                            {role.title}
                                        </span>
                                        <span className={`block text-xs ${selected ? 'text-lime-800' : 'text-stone-500'}`}>
                                            ${role.wageRange.min}-${role.wageRange.max}/hr
                                        </span>
                                    </span>
                                </span>
                            </button>
                        );
                    })}
                </div>
            </fieldset>

            <div>
                <label htmlFor="candidate-full-name" className="block text-base font-semibold text-stone-800 mb-2">
                    Full name <span aria-hidden="true" className="text-red-600">*</span>
                </label>
                <input
                    id="candidate-full-name"
                    name="fullName"
                    type="text"
                    autoComplete="name"
                    required
                    value={data.fullName}
                    onChange={(event) => onChange({ ...data, fullName: event.target.value })}
                    placeholder="e.g. Sarah Chen"
                    className="w-full min-w-0 bg-stone-50 border border-stone-300 rounded-xl px-4 py-3 text-stone-800 placeholder:text-stone-500 focus:outline-none focus:ring-2 focus:ring-lime-600 focus:border-lime-600"
                />
            </div>

            <div>
                <label htmlFor="candidate-email" className="block text-base font-semibold text-stone-800 mb-2">
                    Email <span aria-hidden="true" className="text-red-600">*</span>
                </label>
                <input
                    id="candidate-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    value={data.email}
                    onChange={(event) => onChange({ ...data, email: event.target.value })}
                    placeholder="e.g. sarah@email.com"
                    className="w-full min-w-0 bg-stone-50 border border-stone-300 rounded-xl px-4 py-3 text-stone-800 placeholder:text-stone-500 focus:outline-none focus:ring-2 focus:ring-lime-600 focus:border-lime-600"
                />
            </div>

            <div>
                <label htmlFor="candidate-phone" className="block text-base font-semibold text-stone-800 mb-2">
                    Phone number <span aria-hidden="true" className="text-red-600">*</span>
                </label>
                <input
                    id="candidate-phone"
                    name="phone"
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    required
                    value={data.phone}
                    onChange={(event) => onChange({ ...data, phone: formatPhone(event.target.value) })}
                    placeholder="(201) 555-0123"
                    className="w-full min-w-0 bg-stone-50 border border-stone-300 rounded-xl px-4 py-3 text-stone-800 placeholder:text-stone-500 focus:outline-none focus:ring-2 focus:ring-lime-600 focus:border-lime-600"
                />
            </div>

            <fieldset>
                <legend className="text-base font-semibold text-stone-800">
                    Resume <span className="text-stone-500 font-normal">(optional)</span>
                </legend>
                <p id={resumeHelpId} className="mb-2 text-xs text-stone-600">
                    Select a PDF, JPG, or PNG up to 10 MB. This local demo keeps the selection in your browser and does not upload it with the form.
                </p>
                {data.resumeFile ? (
                    <div className="flex min-w-0 items-center gap-3 p-4 bg-lime-50 border-2 border-lime-300 rounded-xl">
                        <span aria-hidden="true" className="text-2xl">📄</span>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-stone-800 truncate">{data.resumeFile.name}</p>
                            <p className="text-xs text-stone-600">{(data.resumeFile.size / 1024).toFixed(1)} KB · selected locally</p>
                        </div>
                        <button
                            type="button"
                            aria-label={`Remove ${data.resumeFile.name}`}
                            onClick={() => {
                                setFileError(null);
                                onChange({ ...data, resumeFile: null });
                            }}
                            className="min-h-11 min-w-11 rounded-lg text-stone-600 hover:bg-red-50 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600"
                        >
                            <span aria-hidden="true">✕</span>
                        </button>
                    </div>
                ) : (
                    <>
                        <input
                            id={fileInputId}
                            type="file"
                            accept=".pdf,.jpg,.jpeg,.png"
                            aria-describedby={resumeHelpId}
                            onChange={handleFileInput}
                            className="peer sr-only"
                        />
                        <label
                            htmlFor={fileInputId}
                            onDragEnter={handleDrag}
                            onDragLeave={handleDrag}
                            onDragOver={handleDrag}
                            onDrop={handleDrop}
                            className={`block cursor-pointer rounded-xl border-2 border-dashed p-5 text-center transition-all peer-focus-visible:ring-2 peer-focus-visible:ring-lime-600 peer-focus-visible:ring-offset-2 ${dragActive
                                ? 'border-lime-600 bg-lime-50'
                                : 'border-stone-300 bg-stone-50 hover:border-stone-500'
                                }`}
                        >
                            <span aria-hidden="true" className="mb-2 block text-3xl">📎</span>
                            <span className="block text-sm font-medium text-stone-700">Drop a file here or browse</span>
                        </label>
                    </>
                )}
                <p role="alert" className="mt-2 min-h-5 text-sm text-red-700">{fileError}</p>
            </fieldset>

            <div className="pt-2">
                <Button
                    type="button"
                    onClick={onNext}
                    disabled={!isValid}
                    className="w-full bg-lime-600 hover:bg-lime-700 text-white rounded-xl font-medium py-6 text-lg disabled:opacity-50"
                >
                    Continue →
                </Button>
            </div>
        </div>
    );
}
