'use client';

import { useHqStore } from '@hq/data/store/index';
import { Suspense, useEffect } from 'react';
import { InboxView } from '@/features/inbox/inbox-view';

export default function InboxPage() {
  // Legacy surfaces still read `activeView`; keep it in step with the URL.
  useEffect(() => {
    if (useHqStore.getState().activeView !== 'approvals') {
      useHqStore.getState().setActiveView('approvals');
    }
  }, []);
  // `useSearchParams` in a statically exported page must sit under Suspense.
  return (
    <Suspense>
      <InboxView />
    </Suspense>
  );
}
