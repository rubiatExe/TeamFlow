import { RecruiterSemanticSearch } from '@/components/demo/recruiter-semantic-search';
import { getRoleById } from '@/lib/domain/roles';

export function SmartSearchTab({ debugMode = false, roleId, candidateRefs }: {
  debugMode?: boolean;
  roleId?: string;
  candidateRefs?: string[];
}) {
  const roleTitle = roleId ? getRoleById(roleId)?.title ?? roleId : 'all roles';
  return (
    <section aria-labelledby="smart-search-tab-title">
      <div className="mb-6">
        <p className="cocoa-label">Evidence-led discovery</p>
        <h2 id="smart-search-tab-title" className="mt-2 font-display text-3xl font-semibold text-[var(--cocoa-900)]">Smart Search</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--cocoa-600)]">
          Describe the shift in plain language. Search covers {roleTitle}{candidateRefs ? ` · ${candidateRefs.length} visible fictional profiles` : ''} and respects the current board filters. Each result includes quoted résumé evidence.
        </p>
      </div>
      <RecruiterSemanticSearch
        key={JSON.stringify([roleId, candidateRefs?.slice().sort()])}
        debugMode={debugMode}
        roleId={roleId}
        candidateRefs={candidateRefs}
      />
    </section>
  );
}
