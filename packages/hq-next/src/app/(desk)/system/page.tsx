'use client';

import { useHqStore } from '@hq/data/store/index';
import { useEffect } from 'react';
import { ControlView } from '@/features/control/control-view';

export default function Page() {
  // Legacy surfaces still read `activeView`; keep it in step with the URL.
  useEffect(() => {
    if (useHqStore.getState().activeView !== 'control')
      useHqStore.getState().setActiveView('control');
  }, []);
  return <ControlView />;
}
