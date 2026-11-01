'use client';

import { useHqStore } from '@hq/data/store/index';
import { useEffect } from 'react';
import { SessionsView } from '@/features/telemetry/sessions-view';

export default function Page() {
  // Legacy surfaces still read `activeView`; keep it in step with the URL.
  useEffect(() => {
    if (useHqStore.getState().activeView !== 'sessions')
      useHqStore.getState().setActiveView('sessions');
  }, []);
  return <SessionsView />;
}
