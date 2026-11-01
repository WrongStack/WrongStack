'use client';

import { useHqStore } from '@hq/data/store/index';
import { useEffect } from 'react';
import { SecurityView } from '@/features/security/security-view';

export default function Page() {
  // Legacy surfaces still read `activeView`; keep it in step with the URL.
  useEffect(() => {
    if (useHqStore.getState().activeView !== 'settings')
      useHqStore.getState().setActiveView('settings');
  }, []);
  return <SecurityView />;
}
