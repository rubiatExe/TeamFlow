import { RecruiterSemanticSearch } from '@/components/demo/recruiter-semantic-search';

export function SmartSearchTab({ debugMode = false }: { debugMode?: boolean }) {
  return (
    <section aria-labelledby="smart-search-tab-title">
      <div className="mb-6">
        <p className="cocoa-label">Evidence-led discovery</p>
        <h2 id="smart-search-tab-title" className="mt-2 font-display text-3xl font-semibold text-[var(--cocoa-900)]">Smart Search</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--cocoa-600)]">
          Describe the shift in plain language. Every match is rescored for that query and backed by quoted résumé evidence.
        </p>
      </div>
      <RecruiterSemanticSearch debugMode={debugMode} />
    </section>
  );
}
