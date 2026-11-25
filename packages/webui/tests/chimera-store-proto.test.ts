import { describe, expect, it } from 'vitest';
import { useChimeraReportsStore } from '../src/stores/chimera-reports-store';

describe('chimera-reports-store prototype-key safety', () => {
  it('handles prototype property names as sessionIds without throwing', () => {
    try {
      const added = useChimeraReportsStore.getState().recordReport({
        reportId: 'r1',
        sessionId: 'toString',
        message: 'm',
        findingCount: 1,
        fileCount: 1,
        hasActionableFindings: true,
        receivedAt: 1,
        actionedAt: null,
        source: 'event',
      });
      expect(added).toBe(true);
      useChimeraReportsStore.getState().markActioned('constructor', 'r1', 2);
      useChimeraReportsStore.getState().markActioned('toString', 'r1', 2);
      expect(useChimeraReportsStore.getState().bySession['toString']?.[0]?.actionedAt).toBe(2);
    } finally {
      useChimeraReportsStore.getState().forgetSession('toString');
    }
  });
});
