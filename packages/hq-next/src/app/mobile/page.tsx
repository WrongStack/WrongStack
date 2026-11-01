'use client';

import { Suspense } from 'react';
import { InboxView } from '@/features/inbox/inbox-view';

export default function Page() {
  // `useSearchParams` in a statically exported page must sit under Suspense.
  return (
    <Suspense>
      <InboxView />
    </Suspense>
  );
}
