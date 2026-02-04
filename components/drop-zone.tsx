"use client";

import React, { useState, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { uploadResume } from '@/lib/storage';

interface DropZoneProps {
    onFileProcessed: (result: unknown) => void;
}

export function DropZone({ onFileProcessed }: DropZoneProps) {
    const [isDragging, setIsDragging] = useState(false);
    const [processing, setProcessing] = useState<string[]>([]);

    const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragging(false);

        const files = Array.from(e.dataTransfer.files);

        for (const file of files) {
            const fileName = file.name;
            setProcessing(prev => [...prev, fileName]);

            try {
                // 1. Upload to Supabase Storage
                const path = `uploads/${Date.now()}_${fileName}`;
                const publicUrl = await uploadResume(file, path);

                if (!publicUrl) {
                    console.error('Upload failed for', fileName);
                    setProcessing(prev => prev.filter(f => f !== fileName));
                    continue;
                }

                // 2. Call Parser API
                const response = await fetch('/api/parser', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fileUrl: publicUrl }),
                });

                if (!response.ok) {
                    throw new Error('Parser API failed');
                }

                const result = await response.json();
                onFileProcessed(result);

            } catch (err) {
                console.error('Error processing file:', err);
            } finally {
                setProcessing(prev => prev.filter(f => f !== fileName));
            }
        }
    }, [onFileProcessed]);

    const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragging(true);
    }, []);

    const handleDragLeave = useCallback(() => {
        setIsDragging(false);
    }, []);

    return (
        <Card
            className={`border-2 border-dashed transition-all duration-200 cursor-pointer rounded-2xl bg-white ${isDragging
                ? 'border-lime-500 bg-lime-50'
                : 'border-stone-300 hover:border-stone-400 hover:bg-stone-50'
                }`}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
        >
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                <div className="text-5xl mb-4">📄</div>
                <h3 className="text-xl font-semibold mb-2 text-stone-700">Drop Resumes Here</h3>
                <p className="text-stone-400 text-sm">
                    PDF, DOCX, JPG, PNG, HEIC
                </p>

                {processing.length > 0 && (
                    <div className="mt-6 w-full max-w-sm">
                        {processing.map(fileName => (
                            <div key={fileName} className="flex items-center gap-3 p-3 bg-stone-100 rounded-xl mb-2">
                                <div className="animate-spin h-4 w-4 border-2 border-lime-500 border-t-transparent rounded-full"></div>
                                <span className="text-sm truncate flex-1 text-stone-600">{fileName}</span>
                                <span className="text-xs text-lime-600 font-medium">Scanning...</span>
                            </div>
                        ))}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
