"use client";

import React, { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';

export interface BasicInfoData {
    fullName: string;
    email: string;
    phone: string;
    resumeFile: File | null;
    resumeUploading: boolean;
}

interface BasicInfoProps {
    data: BasicInfoData;
    onChange: (data: BasicInfoData) => void;
    onNext: () => void;
}

export function BasicInfo({ data, onChange, onNext }: BasicInfoProps) {
    const [dragActive, setDragActive] = useState(false);

    const handleDrag = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === 'dragenter' || e.type === 'dragover') {
            setDragActive(true);
        } else if (e.type === 'dragleave') {
            setDragActive(false);
        }
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setDragActive(false);

        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            const file = e.dataTransfer.files[0];
            if (isValidFile(file)) {
                onChange({ ...data, resumeFile: file });
            }
        }
    }, [data, onChange]);

    const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            const file = e.target.files[0];
            if (isValidFile(file)) {
                onChange({ ...data, resumeFile: file });
            }
        }
    }, [data, onChange]);

    const isValidFile = (file: File) => {
        const validTypes = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png', 'image/heic'];
        return validTypes.includes(file.type) || file.name.endsWith('.pdf') || file.name.endsWith('.docx') || file.name.endsWith('.doc');
    };

    const removeFile = () => {
        onChange({ ...data, resumeFile: null });
    };

    const formatPhone = (value: string) => {
        const numbers = value.replace(/\D/g, '');
        if (numbers.length <= 3) return numbers;
        if (numbers.length <= 6) return `(${numbers.slice(0, 3)}) ${numbers.slice(3)}`;
        return `(${numbers.slice(0, 3)}) ${numbers.slice(3, 6)}-${numbers.slice(6, 10)}`;
    };

    const isValidEmail = (email: string) => {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    };

    const isValid = data.fullName.trim().length >= 2 &&
        isValidEmail(data.email) &&
        data.phone.replace(/\D/g, '').length >= 10;

    return (
        <div className="py-4 space-y-5">
            {/* Full Name */}
            <div>
                <label className="block text-base font-semibold text-stone-800 mb-2">
                    Full Name <span className="text-red-500">*</span>
                </label>
                <input
                    type="text"
                    value={data.fullName}
                    onChange={(e) => onChange({ ...data, fullName: e.target.value })}
                    placeholder="e.g. Sarah Chen"
                    className="w-full bg-stone-50 border border-stone-200 rounded-xl px-4 py-3 text-stone-700 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-lime-500/50 focus:border-lime-500"
                />
            </div>

            {/* Email */}
            <div>
                <label className="block text-base font-semibold text-stone-800 mb-2">
                    Email <span className="text-red-500">*</span>
                </label>
                <input
                    type="email"
                    value={data.email}
                    onChange={(e) => onChange({ ...data, email: e.target.value })}
                    placeholder="e.g. sarah@email.com"
                    className="w-full bg-stone-50 border border-stone-200 rounded-xl px-4 py-3 text-stone-700 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-lime-500/50 focus:border-lime-500"
                />
            </div>

            {/* Phone */}
            <div>
                <label className="block text-base font-semibold text-stone-800 mb-2">
                    Phone Number <span className="text-red-500">*</span>
                </label>
                <input
                    type="tel"
                    value={data.phone}
                    onChange={(e) => onChange({ ...data, phone: formatPhone(e.target.value) })}
                    placeholder="(201) 555-0123"
                    className="w-full bg-stone-50 border border-stone-200 rounded-xl px-4 py-3 text-stone-700 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-lime-500/50 focus:border-lime-500"
                />
            </div>

            {/* Resume Upload */}
            <div>
                <label className="block text-base font-semibold text-stone-800 mb-2">
                    Resume <span className="text-stone-400 font-normal">(optional)</span>
                </label>

                {data.resumeFile ? (
                    <div className="flex items-center gap-3 p-4 bg-lime-50 border-2 border-lime-200 rounded-xl">
                        <span className="text-2xl">📄</span>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-stone-700 truncate">{data.resumeFile.name}</p>
                            <p className="text-xs text-stone-400">{(data.resumeFile.size / 1024).toFixed(1)} KB</p>
                        </div>
                        <button
                            onClick={removeFile}
                            className="text-stone-400 hover:text-red-500 transition-colors p-1"
                        >
                            ✕
                        </button>
                    </div>
                ) : (
                    <div
                        onDragEnter={handleDrag}
                        onDragLeave={handleDrag}
                        onDragOver={handleDrag}
                        onDrop={handleDrop}
                        className={`relative border-2 border-dashed rounded-xl p-6 text-center transition-all cursor-pointer ${dragActive
                                ? 'border-lime-500 bg-lime-50'
                                : 'border-stone-200 bg-stone-50 hover:border-stone-300'
                            }`}
                    >
                        <input
                            type="file"
                            accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.heic"
                            onChange={handleFileInput}
                            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                        />
                        <div className="text-3xl mb-2">📎</div>
                        <p className="text-sm text-stone-600 font-medium">
                            Drop your resume or <span className="text-lime-600">browse</span>
                        </p>
                        <p className="text-xs text-stone-400 mt-1">PDF, DOCX, JPG, PNG</p>
                    </div>
                )}
            </div>

            {/* Continue Button */}
            <div className="pt-2">
                <Button
                    onClick={onNext}
                    disabled={!isValid}
                    className="w-full bg-lime-500 hover:bg-lime-600 text-white rounded-xl font-medium py-6 text-lg disabled:opacity-50"
                >
                    Continue →
                </Button>
            </div>
        </div>
    );
}
