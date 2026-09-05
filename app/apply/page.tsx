import { notFound } from 'next/navigation';

import { ApplicationFlow } from '@/components/candidate-application/application-flow';
import { legacyDemoRoutesEnabled } from '@/lib/http/legacy-demo-route';

export default function ApplyPage() {
  if (!legacyDemoRoutesEnabled()) notFound();
  return <ApplicationFlow />;
}
