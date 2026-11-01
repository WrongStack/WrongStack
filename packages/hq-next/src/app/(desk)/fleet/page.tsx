'use client';

import { useHqStore } from '@hq/data/store/index';
import { useEffect } from 'react';
import { FleetView } from '@/features/fleet/fleet-view';

export default function FleetPage() {
  // Legacy surfaces still read `activeView`; keep it in step with the URL.
  useEffect(() => {
    if (useHqStore.getState().activeView !== 'fleet') useHqStore.getState().setActiveView('fleet');
  }, []);
  return <FleetView />;
}
