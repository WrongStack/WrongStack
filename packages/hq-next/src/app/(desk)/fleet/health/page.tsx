'use client';

import { useHqStore } from '@hq/data/store/index';
import { useEffect } from 'react';
import { FleetHealthView } from '@/features/machines/fleet-health-view';

export default function Page() {
  // Legacy surfaces still read `activeView`; keep it in step with the URL.
  useEffect(() => {
    if (useHqStore.getState().activeView !== 'health')
      useHqStore.getState().setActiveView('health');
  }, []);
  return <FleetHealthView />;
}
