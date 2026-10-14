import type { Metadata } from 'next';

import { getRoleTitles } from '@/lib/domain/roles';

import { ManagerApplicationLinks } from './manager-application-links';

export const metadata: Metadata = {
  title: 'Application links | TeamFlow',
  robots: { index: false, follow: false },
};

export default function ManagerApplicationLinksPage() {
  return <ManagerApplicationLinks roles={getRoleTitles()} />;
}
