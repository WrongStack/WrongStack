'use client';

import { useHqStore } from '@hq/data/store/index';
import { useEffect } from 'react';
import { OverviewView } from '@/features/overview/overview-view';

export default function OverviewPage() {
  // Legacy surfaces still read `activeView`; keep it in step with the URL.
  useEffect(() => {
    if (useHqStore.getState().activeView !== 'cockpit')
      useHqStore.getState().setActiveView('cockpit');
  }, []);
  return <OverviewView />;
}
