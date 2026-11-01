'use client';

import { useHqStore } from '@hq/data/store/index';
import { Suspense, useEffect } from 'react';
import { ConsoleView } from '@/features/console/console-view';

export default function ConsolePage() {
  // Legacy surfaces still read `activeView`; keep it in step with the URL.
  useEffect(() => {
    if (useHqStore.getState().activeView !== 'console') {
      useHqStore.getState().setActiveView('console');
    }
  }, []);
  // `useSearchParams` in a statically exported page must sit under Suspense.
  return (
    <Suspense>
      <ConsoleView />
    </Suspense>
  );
}
