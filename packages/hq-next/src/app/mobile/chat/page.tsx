'use client';

import { useHqStore } from '@hq/data/store/index';
import { Suspense, useEffect } from 'react';
import { ConsoleView } from '@/features/console/console-view';

export default function Page() {
  // A phone opens on a conversation, not on a picker: a fresh tab with no
  // selection takes the first live session. A deliberate choice is kept.
  const firstSession = useHqStore((state) => state.snapshot?.liveSessions?.[0]?.sessionId ?? null);
  useEffect(() => {
    const store = useHqStore.getState();
    if (firstSession !== null && store.selectedSessionId === null)
      store.selectSession(firstSession);
  }, [firstSession]);
  // `useSearchParams` in a statically exported page must sit under Suspense.
  return (
    <Suspense>
      <ConsoleView />
    </Suspense>
  );
}
