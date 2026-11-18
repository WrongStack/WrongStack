/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { desktopKanbanHost } from '../src/desktop-kanban-host.js';

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

describe('desktopKanbanHost useModelCandidates own-property lookup', () => {
  it('handles Object.prototype provider IDs such as constructor without throwing', async () => {
    const handlers = new Map<string, (msg: { type: string; payload: unknown }) => void>();
    const sent: Array<{ type: string; payload?: unknown }> = [];

    const host = desktopKanbanHost({
      client: {
        on: (type: string, fn: (msg: { type: string; payload: unknown }) => void) => {
          handlers.set(type, fn as (msg: { type: string; payload: unknown }) => void);
          return () => handlers.delete(type);
        },
        send: () => {},
      } as never,
      send: ((msg: { type: string; payload?: unknown }) => {
        sent.push(msg);
      }) as never,
    });

    let latestCandidates: Array<{ provider: string; model: string }> = [];
    function Harness() {
      latestCandidates = host.useModelCandidates(true);
      return <div data-count={latestCandidates.length} />;
    }

    await act(async () => {
      root!.render(<Harness />);
    });

    await act(async () => {
      handlers.get('providers.saved')?.({
        type: 'providers.saved',
        payload: { providers: [{ id: 'constructor', type: 'custom' }] },
      });
    });

    expect(
      sent.some(
        (m) =>
          m.type === 'provider.models' &&
          (m.payload as { providerId?: string })?.providerId === 'constructor',
      ),
    ).toBe(true);

    await act(async () => {
      handlers.get('provider.models')?.({
        type: 'provider.models',
        payload: { provider: 'constructor', models: [{ id: 'ctor-1' }] },
      });
    });

    expect(latestCandidates).toEqual([
      expect.objectContaining({ provider: 'constructor', model: 'ctor-1' }),
    ]);
  });
});
