'use client';

import { useHqStore } from '@hq/data/store/index';
import { Suspense, useEffect } from 'react';
import { KanbanView } from '@/features/kanban/kanban-view';

export default function KanbanPage() {
  // Legacy surfaces still read `activeView`; keep it in step with the URL.
  useEffect(() => {
    if (useHqStore.getState().activeView !== 'kanban')
      useHqStore.getState().setActiveView('kanban');
  }, []);
  // `useSearchParams` in a statically exported page must sit under Suspense.
  return (
    <Suspense>
      <KanbanView />
    </Suspense>
  );
}
