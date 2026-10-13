-- Preserve extraction provenance for Cloud Vision without changing document
-- identity, immutable snapshots, tenant isolation, grants, or existing methods.
begin;

set local lock_timeout = '5s';

alter table public.resume_documents
  drop constraint resume_documents_extraction_method_check,
  add constraint resume_documents_extraction_method_check
    check (extraction_method in ('pdf_text', 'gemini_vision', 'google_cloud_vision'));

commit;
