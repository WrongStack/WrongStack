'use client';

import { useHqStore } from '@hq/data/store/index';
import { useEffect } from 'react';
import { NotificationsView } from '@/features/notifications/notifications-view';

export default function Page() {
  // Legacy surfaces still read `activeView`; keep it in step with the URL.
  useEffect(() => {
    if (useHqStore.getState().activeView !== 'notifications')
      useHqStore.getState().setActiveView('notifications');
  }, []);
  return <NotificationsView />;
}
