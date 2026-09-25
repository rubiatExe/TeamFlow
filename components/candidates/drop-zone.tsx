'use client';

import {
  type ChangeEvent,
  type DragEvent,
  useCallback,
  useId,
  useRef,
  useState,
} from 'react';
import { Check, FileText, LoaderCircle, X } from 'lucide-react';

import { useToast } from '@/components/ui/toast';
import { ParserOutputSchema, type ParserOutput } from '@/lib/contracts/parser';

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ACCEPTED_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;

export type ProcessedResume = {
  result: ParserOutput;
  candidateId?: string;
  fileName: string;
};

interface DropZoneProps {
  onFileProcessed: (processed: ProcessedResume) => void;
  onViewCandidates?: () => void;
  roleId?: string;
  disabled?: boolean;
}

type FileStatus = {
  id: string;
  name: string;
  status: 'uploading' | 'success' | 'error';
  candidateName?: string;
  score?: number;
  error?: string;
};

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('The file could not be read.'));
        return;
      }
      const commaIndex = reader.result.indexOf(',');
      resolve(commaIndex >= 0 ? reader.result.slice(commaIndex + 1) : reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function candidateIdFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || !('candidateId' in payload)) return undefined;
  const candidateId = (payload as { candidateId?: unknown }).candidateId;
  return typeof candidateId === 'string' && candidateId.trim() ? candidateId : undefined;
}

export function DropZone({ onFileProcessed, onViewCandidates, roleId, disabled = false }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [fileStatuses, setFileStatuses] = useState<FileStatus[]>([]);
  const [showViewLink, setShowViewLink] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const helpId = useId();
  const { addToast } = useToast();

  const validateFile = (file: File): string | null => {
    if (file.size > MAX_FILE_SIZE) return `File is ${(file.size / 1024 / 1024).toFixed(1)}MB; the limit is 10MB.`;
    if (!(ACCEPTED_TYPES as readonly string[]).includes(file.type)) return 'Use a PDF, JPG, or PNG file.';
    return null;
  };

  const processFiles = useCallback(async (files: File[]) => {
    if (disabled) return;
    const accepted: Array<{ file: File; id: string }> = [];
    files.forEach((file, index) => {
      const error = validateFile(file);
      if (error) {
        addToast(`${file.name}: ${error}`, 'error', 5_000);
      } else {
        accepted.push({ file, id: `${Date.now()}-${index}-${file.name}` });
      }
    });
    if (accepted.length === 0) return;

    setShowViewLink(false);
    setFileStatuses(previous => [
      ...accepted.map(({ file, id }) => ({ id, name: file.name, status: 'uploading' as const })),
      ...previous,
    ]);

    let successes = 0;
    let errors = 0;
    for (const { file, id } of accepted) {
      try {
        const response = await fetch('/api/parser', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileData: await fileToBase64(file),
            mimeType: file.type,
            fileName: file.name,
            roleId,
          }),
        });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const message = response.status === 429
            ? 'The résumé service is busy. Wait a moment and try again.'
            : 'This résumé could not be analyzed.';
          setFileStatuses(previous => previous.map(item => item.id === id ? { ...item, status: 'error', error: message } : item));
          addToast(`${file.name}: ${message}`, response.status === 429 ? 'warning' : 'error', 5_000);
          errors += 1;
          continue;
        }

        const parsed = ParserOutputSchema.safeParse(payload);
        if (!parsed.success) {
          const message = 'The analysis response was incomplete.';
          setFileStatuses(previous => previous.map(item => item.id === id ? { ...item, status: 'error', error: message } : item));
          addToast(`${file.name}: ${message}`, 'error');
          errors += 1;
          continue;
        }

        const processed: ProcessedResume = {
          result: parsed.data,
          candidateId: candidateIdFromPayload(payload),
          fileName: file.name,
        };
        onFileProcessed(processed);
        setFileStatuses(previous => previous.map(item => item.id === id ? {
          ...item,
          status: 'success',
          candidateName: parsed.data.candidate.name,
          score: parsed.data.score.total,
        } : item));
        successes += 1;
        setTimeout(() => {
          setFileStatuses(previous => previous.filter(item => item.id !== id));
          setShowViewLink(true);
        }, 5_000);
      } catch {
        const message = 'The résumé service could not be reached.';
        setFileStatuses(previous => previous.map(item => item.id === id ? { ...item, status: 'error', error: message } : item));
        addToast(`${file.name}: ${message}`, 'error');
        errors += 1;
      }
    }

    if (accepted.length > 1) {
      addToast(`Batch complete: ${successes} processed, ${errors} failed.`, errors > 0 ? 'warning' : 'success');
    }
  }, [addToast, disabled, onFileProcessed, roleId]);

  const handleInput = async (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) await processFiles(Array.from(event.target.files));
    event.target.value = '';
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    await processFiles(Array.from(event.dataTransfer.files));
  };

  const uploadingCount = fileStatuses.filter(file => file.status === 'uploading').length;

  return (
    <div>
      <div
        onDrop={handleDrop}
        onDragOver={event => { event.preventDefault(); if (!disabled) setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        aria-busy={uploadingCount > 0}
        className={`flex min-h-[280px] flex-col items-center justify-center rounded-[var(--radius-lg)] border-2 p-6 text-center transition-all ${
          isDragging
            ? 'border-solid border-[var(--cocoa-600)] bg-[var(--cocoa-100)]'
            : 'border-dashed border-[var(--cocoa-300)] bg-[var(--cocoa-50)]'
        } ${disabled ? 'cursor-not-allowed opacity-70' : ''}`}
      >
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          multiple
          accept=".pdf,.jpg,.jpeg,.png"
          disabled={disabled}
          aria-label="Choose résumé files"
          aria-describedby={helpId}
          onChange={handleInput}
          className="sr-only"
        />
        <svg
          aria-hidden="true"
          viewBox="0 0 80 80"
          fill="none"
          className={`size-16 text-[var(--cocoa-300)] ${isDragging ? 'animate-[upload-bounce_600ms_ease-in-out_infinite]' : ''}`}
        >
          <path d="M22 8h25l12 12v46a6 6 0 0 1-6 6H22a6 6 0 0 1-6-6V14a6 6 0 0 1 6-6Z" stroke="currentColor" strokeWidth="3" />
          <path d="M47 8v14h12M28 38h19M28 49h12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          <path d="m50 52 8-8 8 8M58 45v18" stroke="var(--cocoa-600)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <h3 className="mt-4 font-display text-2xl font-semibold text-[var(--cocoa-800)]">
          <span className="md:hidden">Tap to choose résumés</span>
          <span className="hidden md:inline">Drop résumés here</span>
        </h3>
        <p id={helpId} className="mt-2 text-sm text-[var(--cocoa-600)]">PDF, JPG, PNG · Max 10MB each</p>
        {disabled ? (
          <p className="mt-4 max-w-sm text-sm leading-6 text-[var(--cocoa-700)]">Résumé processing is disabled in the public preview.</p>
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="mt-5 min-h-11 rounded-[var(--radius-md)] border border-[var(--cocoa-700)] bg-white px-5 text-sm font-semibold text-[var(--cocoa-700)] transition hover:bg-[var(--cocoa-100)]"
          >
            Browse files
          </button>
        )}
      </div>

      {fileStatuses.length > 0 ? (
        <div className="mt-5 space-y-2" role="status" aria-live="polite" aria-label="Résumé processing queue">
          {fileStatuses.map(file => (
            <div key={file.id} className={`file-row-enter flex items-center gap-3 rounded-[var(--radius-md)] border p-3 ${
              file.status === 'success' ? 'border-green-200 bg-[var(--sage-50)]' : file.status === 'error' ? 'border-red-200 bg-red-50' : 'border-[var(--cocoa-100)] bg-white'
            }`}>
              {file.status === 'uploading' ? <LoaderCircle className="size-5 shrink-0 animate-spin text-[var(--cocoa-600)]" aria-hidden="true" /> : null}
              {file.status === 'success' ? <Check className="size-5 shrink-0 text-[var(--sage-700)]" aria-hidden="true" /> : null}
              {file.status === 'error' ? <X className="size-5 shrink-0 text-red-700" aria-hidden="true" /> : null}
              <FileText className="size-4 shrink-0 text-[var(--cocoa-500)]" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-[var(--cocoa-800)]">{file.name}</p>
                <p className={`mt-0.5 text-xs ${file.status === 'error' ? 'text-red-700' : 'text-[var(--cocoa-600)]'}`}>
                  {file.status === 'uploading' ? 'Analyzing résumé…' : file.status === 'success' ? `Found: ${file.candidateName} · Score: ${file.score}` : file.error}
                </p>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {showViewLink && onViewCandidates ? (
        <button type="button" onClick={onViewCandidates} className="mt-4 min-h-11 text-sm font-semibold text-[var(--cocoa-700)] hover:underline">
          View in Candidates →
        </button>
      ) : null}
    </div>
  );
}
