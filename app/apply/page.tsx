import { ApplicationFlow } from '@/components/candidate-application/application-flow';
import { legacyDemoRoutesEnabled } from '@/lib/http/legacy-demo-route';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export default function ApplyPage() {
  return <ApplicationFlow mode={legacyDemoRoutesEnabled() ? 'demo' : 'production'} />;
}
