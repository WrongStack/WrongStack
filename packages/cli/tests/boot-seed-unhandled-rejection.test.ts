import type { HqAlertEngine, HqCommandAuditLog, HqPersistence } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { seedHqServerFromDisk } from '../src/hq-server/boot-seed.js';

describe('seedHqServerFromDisk (F2214)', () => {
  it('attaches rejection handlers to machines/sessionHistory/healthHistory loads', async () => {
    let unhandled = 0;
    const onUnhandled = () => {
      unhandled++;
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      seedHqServerFromDisk({
        persistence: {
          eventLog: { hydrate: async () => {}, recent: async () => [] },
          timeseries: { load: async () => {} },
          alertLog: { readAll: async () => [] },
          commandLog: { readAll: async () => [] },
          machines: { load: async () => Promise.reject(new Error('corrupt machines')) },
          sessionHistory: { load: async () => Promise.reject(new Error('corrupt sessions')) },
          healthHistory: { load: async () => Promise.reject(new Error('corrupt health')) },
        } as unknown as HqPersistence,
        eventLog: [],
        maxEventLog: 10,
        alertEngine: { seed() {} } as unknown as HqAlertEngine,
        auditLog: { seed() {} } as unknown as HqCommandAuditLog,
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
