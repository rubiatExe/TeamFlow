'use client';

import { DropZone, type ProcessedResume } from '@/components/candidates/drop-zone';
import { getRoleOrDefault } from '@/lib/domain/roles';

interface UploadTabProps {
  roleId: string;
  disabled?: boolean;
  onFileProcessed: (processed: ProcessedResume) => void;
  onViewCandidates: () => void;
}

export function UploadTab({ roleId, disabled = false, onFileProcessed, onViewCandidates }: UploadTabProps) {
  const role = getRoleOrDefault(roleId);

  return (
    <section aria-labelledby="upload-tab-title" className="mx-auto max-w-4xl">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="cocoa-label">Add applicants</p>
          <h2 id="upload-tab-title" className="mt-2 font-display text-3xl font-semibold text-[var(--cocoa-900)]">Upload Resumes</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--cocoa-600)]">
            Drag in PDFs, JPGs, or PNGs. TeamFlow reads each résumé and prepares a role-specific fit score for manager review.
          </p>
        </div>
        <span className="inline-flex w-fit items-center rounded-full border border-[var(--cocoa-200)] bg-[var(--cocoa-100)] px-3 py-1.5 text-xs font-semibold text-[var(--cocoa-700)]">
          Scoring for: {role.emoji} {role.title}
        </span>
      </div>
      <div className="mt-7">
        <DropZone
          roleId={roleId}
          disabled={disabled}
          onFileProcessed={onFileProcessed}
          onViewCandidates={onViewCandidates}
        />
      </div>
    </section>
  );
}
