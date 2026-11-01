'use client';

import { useHqStore } from '@hq/data/store/index';
import { Suspense, useEffect } from 'react';
import { AlertsView } from '@/features/alerts/alerts-view';

export default function Page() {
  // Legacy surfaces still read `activeView`; keep it in step with the URL.
  useEffect(() => {
    if (useHqStore.getState().activeView !== 'alerts')
      useHqStore.getState().setActiveView('alerts');
  }, []);
  // `useSearchParams` in a statically exported page must sit under Suspense.
  return (
    <Suspense>
      <AlertsView />
    </Suspense>
  );
}
