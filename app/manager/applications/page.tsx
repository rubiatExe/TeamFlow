import type { Metadata } from 'next';

import { ManagerApplications } from './manager-applications';

export const metadata: Metadata = {
  title: 'Submitted applications | TeamFlow',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function ManagerApplicationsPage() {
  return <ManagerApplications />;
}
