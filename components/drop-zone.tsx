"use client";

import React, { useState, useCallback, useRef } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { getRoleById } from '@/lib/roles';
import { useToast } from '@/components/ui/toast';
import { ParserOutput } from '@/app/api/types';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ACCEPTED_TYPES = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/png',
    'image/heic',
];

interface DropZoneProps {
    onFileProcessed: (result: ParserOutput) => void;
    roleId?: string;
}

interface FileStatus {
    name: string;
    status: 'uploading' | 'success' | 'error';
    error?: string;
}

export function DropZone({ onFileProcessed, roleId }: DropZoneProps) {
    const [isDragging, setIsDragging] = useState(false);
    const [fileStatuses, setFileStatuses] = useState<FileStatus[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const { addToast } = useToast();

    const role = roleId ? getRoleById(roleId) : undefined;

    const validateFile = (file: File): string | null => {
        if (file.size > MAX_FILE_SIZE) {
            return `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 10MB.`;
        }
        const isAccepted = ACCEPTED_TYPES.includes(file.type) ||
            file.name.endsWith('.pdf') || file.name.endsWith('.docx') ||
            file.name.endsWith('.doc') || file.name.endsWith('.heic');
        if (!isAccepted) {
            return `Unsupported file type: ${file.type || 'unknown'}`;
        }
        return null;
    };

    const processFiles = useCallback(async (files: File[]) => {
        // Validate all files first
        const validFiles: File[] = [];
        for (const file of files) {
            const error = validateFile(file);
            if (error) {
                addToast(`${file.name}: ${error}`, 'error', 5000);
            } else {
                validFiles.push(file);
            }
        }

        if (validFiles.length === 0) return;

        // Initialize status for all valid files
        setFileStatuses(validFiles.map(f => ({ name: f.name, status: 'uploading' })));

        let successCount = 0;
        let errorCount = 0;

        for (const file of validFiles) {
            const fileName = file.name;

            try {
                // Convert file to base64 and send directly to parser
                const arrayBuffer = await file.arrayBuffer();
                const base64 = Buffer.from(arrayBuffer).toString('base64');
                const mimeType = file.type || 'application/pdf';

                const response = await fetch('/api/parser', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        fileData: base64,
                        mimeType: mimeType,
                        fileName: fileName,
                        roleId: roleId,
                    }),
                });

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    const errorMsg = errorData?.details || errorData?.error || `HTTP ${response.status}`;

                    // Special handling for rate limits
                    if (response.status === 429 || (typeof errorMsg === 'string' && errorMsg.includes('quota'))) {
                        addToast(`Rate limit hit. Please wait 30 seconds and try again.`, 'warning', 6000);
                    } else {
                        addToast(`Failed to parse ${fileName}: ${errorMsg}`, 'error', 5000);
                    }

                    setFileStatuses(prev => prev.map(f =>
                        f.name === fileName ? { ...f, status: 'error', error: errorMsg } : f
                    ));
                    errorCount++;
                    continue;
                }

                const result = await response.json();

                // Check if result has the expected structure
                if (result.candidate && result.score) {
                    onFileProcessed(result);
                    setFileStatuses(prev => prev.map(f =>
                        f.name === fileName ? { ...f, status: 'success' } : f
                    ));
                    successCount++;
                    addToast(`✓ ${result.candidate.name || fileName} parsed successfully (Score: ${result.score.total})`, 'success');
                } else {
                    addToast(`Unexpected response format for ${fileName}`, 'error');
                    setFileStatuses(prev => prev.map(f =>
                        f.name === fileName ? { ...f, status: 'error', error: 'Bad response' } : f
                    ));
                    errorCount++;
                }

            } catch (err) {
                console.error('Error processing file:', err);
                addToast(`Network error processing ${fileName}`, 'error');
                setFileStatuses(prev => prev.map(f =>
                    f.name === fileName ? { ...f, status: 'error', error: 'Network error' } : f
                ));
                errorCount++;
            }
        }

        // Batch summary toast
        if (validFiles.length > 1) {
            addToast(
                `Batch complete: ${successCount} succeeded, ${errorCount} failed`,
                errorCount > 0 ? 'warning' : 'success'
            );
        }

        // Clear statuses after a delay
        setTimeout(() => setFileStatuses([]), 4000);

    }, [onFileProcessed, roleId, addToast]);

    const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragging(false);
        const files = Array.from(e.dataTransfer.files);
        await processFiles(files);
    }, [processFiles]);

    const handleFileInput = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) {
            const files = Array.from(e.target.files);
            await processFiles(files);
            e.target.value = '';
        }
    }, [processFiles]);

    const handleClick = useCallback(() => {
        fileInputRef.current?.click();
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragging(true);
    }, []);

    const handleDragLeave = useCallback(() => {
        setIsDragging(false);
    }, []);

    const uploadingCount = fileStatuses.filter(f => f.status === 'uploading').length;
    const totalCount = fileStatuses.length;

    return (
        <Card
            className={`border-2 border-dashed transition-all duration-200 cursor-pointer rounded-2xl bg-white ${isDragging
                ? 'border-lime-500 bg-lime-50'
                : 'border-stone-300 hover:border-stone-400 hover:bg-stone-50'
                }`}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={handleClick}
        >
            <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.heic"
                onChange={handleFileInput}
                className="hidden"
            />
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                <div className="text-5xl mb-4">📄</div>
                <h3 className="text-xl font-semibold mb-2 text-stone-700">Drop Resumes Here</h3>

                {role && (
                    <div className="mb-2 px-3 py-1 bg-lime-100 text-lime-700 rounded-lg text-sm font-medium inline-flex items-center gap-1.5">
                        <span>{role.emoji}</span>
                        <span>Scoring for: {role.title}</span>
                    </div>
                )}

                <p className="text-stone-400 text-sm">
                    or <span className="text-lime-600 font-medium hover:underline">click to browse</span>
                </p>
                <p className="text-stone-300 text-xs mt-1">
                    PDF, DOCX, JPG, PNG, HEIC • Max 10MB
                </p>

                {fileStatuses.length > 0 && (
                    <div className="mt-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
                        {/* Batch progress header */}
                        {totalCount > 1 && (
                            <div className="mb-3 flex items-center justify-between text-sm">
                                <span className="text-stone-600 font-medium">
                                    Processing {totalCount - uploadingCount} / {totalCount}
                                </span>
                                <div className="w-24 h-1.5 bg-stone-200 rounded-full overflow-hidden">
                                    <div
                                        className="h-full bg-lime-500 rounded-full transition-all duration-500"
                                        style={{ width: `${((totalCount - uploadingCount) / totalCount) * 100}%` }}
                                    />
                                </div>
                            </div>
                        )}

                        {fileStatuses.map(file => (
                            <div key={file.name} className={`flex items-center gap-3 p-3 rounded-xl mb-2 ${file.status === 'uploading' ? 'bg-stone-100' :
                                    file.status === 'success' ? 'bg-lime-50' :
                                        'bg-red-50'
                                }`}>
                                {file.status === 'uploading' && (
                                    <div className="animate-spin h-4 w-4 border-2 border-lime-500 border-t-transparent rounded-full flex-shrink-0"></div>
                                )}
                                {file.status === 'success' && <span className="text-lime-600 flex-shrink-0">✓</span>}
                                {file.status === 'error' && <span className="text-red-500 flex-shrink-0">✕</span>}
                                <span className="text-sm truncate flex-1 text-stone-600">{file.name}</span>
                                <span className={`text-xs font-medium ${file.status === 'uploading' ? 'text-lime-600' :
                                        file.status === 'success' ? 'text-lime-600' :
                                            'text-red-500'
                                    }`}>
                                    {file.status === 'uploading' ? 'Scanning...' :
                                        file.status === 'success' ? 'Done' :
                                            'Failed'}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
