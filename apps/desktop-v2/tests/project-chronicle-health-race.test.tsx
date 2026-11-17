/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectChronicle } from '../src/ProjectChronicle.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

describe('ProjectChronicle refreshHealth generation guard', () => {
  it('ignores stale chronicle.status error after a newer refreshHealth succeeds', async () => {
    let rejectFirst!: (err: unknown) => void;
    let resolveSecond!: (v: unknown) => void;
    let statusCalls = 0;

    const command = async (type: string) => {
      if (type === 'chronicle.status') {
        statusCalls += 1;
        if (statusCalls === 1) {
          return new Promise((_r, rej) => {
            rejectFirst = rej;
          });
        }
        return new Promise((r) => {
          resolveSecond = r;
        });
      }
      if (type === 'chronicle.events') return { events: [], total: 0 };
      if (type === 'chronicle.facets') return { values: {} };
      return {};
    };

    await act(async () => {
      root!.render(<ProjectChronicle command={command as never} />);
    });

    await act(async () => {
      root!.render(
        <ProjectChronicle
          command={((...args: Parameters<typeof command>) => command(...args)) as never}
        />,
      );
    });

    await act(async () => {
      resolveSecond({ pipeline: { running: true } });
    });
    await act(async () => {
      rejectFirst(new Error('STALE_HEALTH_ERR'));
    });

    expect(container!.textContent).not.toContain('STALE_HEALTH_ERR');
  });
});
