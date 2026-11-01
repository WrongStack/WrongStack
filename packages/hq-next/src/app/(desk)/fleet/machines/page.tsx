'use client';

import { useHqStore } from '@hq/data/store/index';
import { Suspense, useEffect } from 'react';
import { MachinesView } from '@/features/machines/machines-view';

export default function Page() {
  // Legacy surfaces still read `activeView`; keep it in step with the URL.
  useEffect(() => {
    if (useHqStore.getState().activeView !== 'machines')
      useHqStore.getState().setActiveView('machines');
  }, []);
  // `useSearchParams` in a statically exported page must sit under Suspense.
  return (
    <Suspense>
      <MachinesView />
    </Suspense>
  );
}
