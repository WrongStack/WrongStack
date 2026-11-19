/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from 'react';
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
      root?.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

describe('desktopKanbanHost useModelCandidates reopen and error retry', () => {
  it('re-requests unresolved providers after active=false -> true while keeping resolved providers cached', async () => {
    const listeners = new Map<string, Set<(msg: { type: string; payload: unknown }) => void>>();
    const sent: Array<{ type: string; payload?: Record<string, unknown> }> = [];

    const host = desktopKanbanHost({
      client: {
        on(type, fn) {
          const set = listeners.get(type) ?? new Set();
          set.add(fn);
          listeners.set(type, set);
          return () => set.delete(fn);
        },
        findMemoriesForFile() {},
      },
      send(msg) {
        sent.push(msg);
      },
    });

    const emit = (type: string, payload: unknown) => {
      for (const cb of [...(listeners.get(type) ?? [])]) cb({ type, payload });
    };

    let latest: ReturnType<typeof host.useModelCandidates> = [];
    function Probe({ active }: { active: boolean }) {
      latest = host.useModelCandidates(active);
      return null;
    }

    await act(async () => {
      root?.render(createElement(Probe, { active: true }));
    });
    await act(async () => {
      emit('providers.saved', {
        providers: [
          { id: 'cached-prov', type: 'anthropic' },
          { id: 'inflight-prov', type: 'openai' },
        ],
      });
    });
    await act(async () => {
      emit('provider.models', {
        provider: 'cached-prov',
        models: [
          { id: 'claude-sonnet-4-6', outputModalities: ['text'] },
          { id: 'imagen-only', outputModalities: ['image'] },
        ],
      });
    });
    expect(latest).toEqual([
      expect.objectContaining({ provider: 'cached-prov', model: 'claude-sonnet-4-6' }),
    ]);

    // Close picker while inflight-prov reply has not arrived yet
    await act(async () => {
      root?.render(createElement(Probe, { active: false }));
    });
    await act(async () => {
      emit('provider.models', {
        provider: 'inflight-prov',
        models: [{ id: 'gpt-missed-while-closed' }],
      });
    });

    // Reopen picker: cached-prov stays cached, inflight-prov is re-requested
    sent.length = 0;
    await act(async () => {
      root?.render(createElement(Probe, { active: true }));
    });
    await act(async () => {
      emit('providers.saved', {
        providers: [
          { id: 'cached-prov', type: 'anthropic' },
          { id: 'inflight-prov', type: 'openai' },
        ],
      });
    });

    expect(
      sent.filter((m) => m.type === 'provider.models').map((m) => m.payload?.['providerId']),
    ).toEqual(['inflight-prov']);

    await act(async () => {
      emit('provider.models', {
        provider: 'inflight-prov',
        models: [{ id: 'gpt-5' }],
      });
    });
    expect(latest).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'cached-prov', model: 'claude-sonnet-4-6' }),
        expect.objectContaining({ provider: 'inflight-prov', model: 'gpt-5' }),
      ]),
    );
  });

  it('does not cache empty model lists on error replies without a models array', async () => {
    const listeners = new Map<string, Set<(msg: { type: string; payload: unknown }) => void>>();
    const sent: Array<{ type: string; payload?: Record<string, unknown> }> = [];

    const host = desktopKanbanHost({
      client: {
        on(type, fn) {
          const set = listeners.get(type) ?? new Set();
          set.add(fn);
          listeners.set(type, set);
          return () => set.delete(fn);
        },
        findMemoriesForFile() {},
      },
      send(msg) {
        sent.push(msg);
      },
    });

    const emit = (type: string, payload: unknown) => {
      for (const cb of [...(listeners.get(type) ?? [])]) cb({ type, payload });
    };

    let latest: ReturnType<typeof host.useModelCandidates> = [];
    function Probe({ active }: { active: boolean }) {
      latest = host.useModelCandidates(active);
      return null;
    }

    await act(async () => {
      root?.render(createElement(Probe, { active: true }));
    });
    await act(async () => {
      emit('providers.saved', {
        providers: [{ id: 'flaky-prov', type: 'openai' }],
      });
    });
    await act(async () => {
      emit('provider.models', {
        provider: 'flaky-prov',
        error: '503 Service Unavailable',
      });
    });

    sent.length = 0;
    await act(async () => {
      emit('providers.saved', {
        providers: [{ id: 'flaky-prov', type: 'openai' }],
      });
    });
    expect(
      sent.filter((m) => m.type === 'provider.models').map((m) => m.payload?.['providerId']),
    ).toEqual(['flaky-prov']);

    await act(async () => {
      emit('provider.models', {
        provider: 'flaky-prov',
        models: [{ id: 'gpt-recovered' }],
      });
    });
    expect(latest).toEqual([
      expect.objectContaining({ provider: 'flaky-prov', model: 'gpt-recovered' }),
    ]);
  });
});
