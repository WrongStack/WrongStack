'use client';

import { Suspense } from 'react';
import { KanbanView } from '@/features/kanban/kanban-view';

export default function Page() {
  // `useSearchParams` in a statically exported page must sit under Suspense.
  return (
    <Suspense>
      <KanbanView />
    </Suspense>
  );
}
