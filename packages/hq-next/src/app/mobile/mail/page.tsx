'use client';

import { Suspense } from 'react';
import { MailboxView } from '@/features/mailbox/mailbox-view';

export default function Page() {
  // `useSearchParams` in a statically exported page must sit under Suspense.
  return (
    <Suspense>
      <MailboxView />
    </Suspense>
  );
}
