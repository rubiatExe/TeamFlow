import { ManagerDashboard } from '@/components/candidates/manager-dashboard';
import { legacyDemoRoutesEnabled } from '@/lib/http/legacy-demo-route';

export default function HomePage() {
  return (
    <>
      <a
        href="#main-content"
        className="sr-only z-[100] rounded-[var(--radius-md)] bg-white px-4 py-3 font-semibold text-[var(--cocoa-900)] shadow-lg focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to main content
      </a>
      <ManagerDashboard interactiveDemoEnabled={legacyDemoRoutesEnabled()} />
    </>
  );
}
