'use client';

import { DropZone, type ProcessedResume } from '@/components/candidates/drop-zone';
import { getRoleOrDefault } from '@/lib/domain/roles';

interface UploadTabProps {
  roleId: string;
  disabled?: boolean;
  onFileProcessed: (processed: ProcessedResume) => void;
  onViewCandidates: () => void;
  onSearch: () => void;
}

export function UploadTab({ roleId, disabled = false, onFileProcessed, onViewCandidates, onSearch }: UploadTabProps) {
  const role = getRoleOrDefault(roleId);

  return (
    <section aria-labelledby="upload-tab-title" className="mx-auto max-w-4xl">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="cocoa-label">Add applicants</p>
          <h2 id="upload-tab-title" className="mt-2 font-display text-3xl font-semibold text-[var(--cocoa-900)]">Upload Resumes</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--cocoa-600)]">
            {disabled ? 'This public demo uses supplied fictional profiles. Explore their résumé evidence and practice the pipeline without uploading personal documents.' : 'Drag in PDFs, JPGs, or PNGs. TeamFlow reads each résumé and prepares a role-specific fit score for manager review.'}
          </p>
        </div>
        <span className="inline-flex w-fit items-center rounded-full border border-[var(--cocoa-200)] bg-[var(--cocoa-100)] px-3 py-1.5 text-xs font-semibold text-[var(--cocoa-700)]">
          {disabled ? 'Sample role' : 'Scoring for'}: {role.emoji} {role.title}
        </span>
      </div>
      <div className="mt-7">
        {disabled ? (
          <div className="rounded-[var(--radius-lg)] border border-[var(--cocoa-200)] bg-white p-6">
            <h3 className="font-display text-xl font-semibold text-[var(--cocoa-900)]">Try the sample résumés</h3>
            <p className="mt-2 text-sm leading-6 text-[var(--cocoa-600)]">Résumé uploads and processing are disabled in the public demo. Smart Search and Candidates use the same fictional profiles for this role.</p>
            <div className="mt-5 flex flex-wrap gap-3">
              <button type="button" onClick={onSearch} className="min-h-11 rounded-[var(--radius-md)] bg-[var(--cocoa-700)] px-4 text-sm font-semibold text-white hover:bg-[var(--cocoa-600)]">Search sample résumés</button>
              <button type="button" onClick={onViewCandidates} className="min-h-11 rounded-[var(--radius-md)] border border-[var(--cocoa-300)] px-4 text-sm font-semibold text-[var(--cocoa-700)] hover:bg-[var(--cocoa-50)]">View sample candidates</button>
            </div>
          </div>
        ) : (
        <DropZone
          roleId={roleId}
          disabled={disabled}
          onFileProcessed={onFileProcessed}
          onViewCandidates={onViewCandidates}
        />
        )}
      </div>
    </section>
  );
}
