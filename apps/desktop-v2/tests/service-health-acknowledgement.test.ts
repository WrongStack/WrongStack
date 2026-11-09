// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { BackgroundServices } from '../src/BackgroundServices';
import { EngineOperations } from '../src/engine-operations';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('service health native acknowledgement', () => {
  it.each([false, true])('consumes correlated health response (failed=%s)', async (failed) => {
    const operations = new EngineOperations(async (_type, payload) => {
      operations.receive({
        type: failed ? 'connections.health_error' : 'connections.health_result',
        payload: {
          requestId: payload?.requestId,
          ...(failed
            ? { success: false, message: 'Fixture collector unavailable' }
            : {
                overall: 'healthy',
                services: [
                  {
                    id: 'session-catalog',
                    label: 'Session Catalog',
                    status: 'healthy',
                    control: 'shutdown',
                  },
                ],
              }),
        },
      });
    }, 1000);
    const host = document.createElement('div'),
      root = createRoot(host);
    try {
      await act(async () =>
        root.render(createElement(BackgroundServices, { command: operations.request })),
      );
      if (failed)
        expect(host.querySelector('[role=alert]')?.textContent).toBe(
          'Fixture collector unavailable',
        );
      else expect(host.querySelector('li')?.textContent).toContain('Session Catalog');
    } finally {
      operations.clear();
      await act(async () => root.unmount());
    }
  });
});
