'use client';

import { Suspense } from 'react';
import { MobileFleetView } from '@/features/machines/mobile-fleet-view';

export default function Page() {
  // `useSearchParams` in a statically exported page must sit under Suspense.
  return (
    <Suspense>
      <MobileFleetView />
    </Suspense>
  );
}
