'use client';

import { useHqStore } from '@hq/data/store/index';
import { useEffect } from 'react';
import { VaultView } from '@/features/vault/vault-view';

export default function Page() {
  // Legacy surfaces still read `activeView`; keep it in step with the URL.
  useEffect(() => {
    if (useHqStore.getState().activeView !== 'vault') useHqStore.getState().setActiveView('vault');
  }, []);
  return <VaultView />;
}
