import { notFound } from 'next/navigation';

import { ManagerDashboard } from '@/components/candidates/manager-dashboard';
import { legacyDemoRoutesEnabled } from '@/lib/http/legacy-demo-route';

export default function DashboardPage() {
  if (!legacyDemoRoutesEnabled()) notFound();
  return <ManagerDashboard />;
}
