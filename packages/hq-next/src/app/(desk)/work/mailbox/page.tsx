'use client';

import { useHqStore } from '@hq/data/store/index';
import { Suspense, useEffect } from 'react';
import { MailboxView } from '@/features/mailbox/mailbox-view';

export default function MailboxPage() {
  // Legacy surfaces still read `activeView`; keep it in step with the URL.
  useEffect(() => {
    if (useHqStore.getState().activeView !== 'mailbox')
      useHqStore.getState().setActiveView('mailbox');
  }, []);
  // `useSearchParams` in a statically exported page must sit under Suspense.
  return (
    <Suspense>
      <MailboxView />
    </Suspense>
  );
}
