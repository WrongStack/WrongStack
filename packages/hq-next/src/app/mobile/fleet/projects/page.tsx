'use client';

import { Suspense } from 'react';
import { MobileProjectsView } from '@/features/projects/mobile-projects-view';

export default function Page() {
  // `useSearchParams` in a statically exported page must sit under Suspense.
  return (
    <Suspense>
      <MobileProjectsView />
    </Suspense>
  );
}
