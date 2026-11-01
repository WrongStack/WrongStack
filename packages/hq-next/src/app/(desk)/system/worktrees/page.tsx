'use client';

import { useHqStore } from '@hq/data/store/index';
import { Suspense, useEffect } from 'react';
import { WorktreesView } from '@/features/worktrees/worktrees-view';

export default function Page() {
  // Legacy surfaces still read `activeView`; keep it in step with the URL.
  useEffect(() => {
    if (useHqStore.getState().activeView !== 'worktree')
      useHqStore.getState().setActiveView('worktree');
  }, []);
  // `useSearchParams` in a statically exported page must sit under Suspense.
  return (
    <Suspense>
      <WorktreesView />
    </Suspense>
  );
}
