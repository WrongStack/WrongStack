import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

/**
 * `useWebSocket` exposes ~70 one-line `useCallback` wrappers that forward
 * straight to the ws client. Rather than one test each, the client here is a
 * Proxy that records every call, so the suite can assert the whole delegation
 * surface at once and still name the handful of wrappers that do more than
 * forward.
 */

vi.mock('@/lib/favicon', () => ({
  installFaviconVisibilityReset: vi.fn(),
  setFaviconStatus: vi.fn(),
}));

vi.mock('../../src/hooks/ws-handlers.js', () => ({ WS_HANDLERS: {} }));

interface Recorded {
  method: string;
  args: unknown[];
}

const calls: Recorded[] = [];

/**
 * Any property read returns a recording function, so a wrapper calling a
 * client method this test didn't anticipate is still captured rather than
 * throwing. The few properties the hook reads as values are declared up front.
 */
const client = new Proxy(
  {
    isConnected: true,
    connect: () => Promise.resolve(),
    onStatus: () => () => {},
    on: () => () => {},
    consumeSuppressedChatEcho: () => false,
  } as Record<string, unknown>,
  {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return (...args: unknown[]) => {
        calls.push({ method: prop, args });
        return `ret:${prop}`;
      };
    },
  },
);

vi.mock('@/lib/ws-client', () => ({ getWSClient: () => client }));

const { useWebSocket } = await import('../../src/hooks/useWebSocket');

function api() {
  const { result } = renderHook(() => useWebSocket());
  return result.current as unknown as Record<string, unknown>;
}

function called(method: string): Recorded | undefined {
  return calls.find((c) => c.method === method);
}

beforeEach(() => {
  calls.length = 0;
});

describe('provider and key management delegation', () => {
  it('forwards each call with its arguments untouched', () => {
    const ws = api();

    (ws.listProviders as () => void)();
    (ws.listProviderModels as (a: string) => void)('openai');
    (ws.listSavedProviders as () => void)();
    (ws.addKey as (a: string, b: string, c: string) => void)('openai', 'work', 'sk-1');
    (ws.updateKey as (a: string, b: string, c: string) => void)('openai', 'work', 'sk-2');
    (ws.deleteKey as (a: string, b: string) => void)('openai', 'work');
    (ws.setActiveKey as (a: string, b: string) => void)('openai', 'work');
    (ws.removeProvider as (a: string) => void)('openai');

    expect(called('listProviders')).toBeDefined();
    expect(called('listProviderModels')?.args).toEqual(['openai']);
    expect(called('addKey')?.args).toEqual(['openai', 'work', 'sk-1']);
    expect(called('updateKey')?.args).toEqual(['openai', 'work', 'sk-2']);
    expect(called('deleteKey')?.args).toEqual(['openai', 'work']);
    expect(called('setActiveKey')?.args).toEqual(['openai', 'work']);
    expect(called('removeProvider')?.args).toEqual(['openai']);
  });

  it('passes the whole addProvider signature through in order', () => {
    const customModels = { m1: { contextWindow: 1 } };
    (api().addProvider as (...a: unknown[]) => void)(
      'acme',
      'openai',
      'https://api.acme.test',
      'sk-1',
      ['m1'],
      customModels,
    );

    expect(called('addProvider')?.args).toEqual([
      'acme',
      'openai',
      'https://api.acme.test',
      'sk-1',
      ['m1'],
      customModels,
    ]);
  });

  it('switchModel returns the client promise rather than swallowing it', () => {
    expect((api().switchModel as (a: string, b: string) => unknown)('openai', 'gpt-5')).toBe(
      'ret:switchModel',
    );
  });
});

describe('session delegation', () => {
  it('forwards resume and save', () => {
    const ws = api();
    (ws.resumeSession as (a: string) => void)('sess_1');
    (ws.saveSession as () => void)();

    expect(called('resumeSessionById')?.args).toEqual(['sess_1']);
    expect(called('saveSession')).toBeDefined();
  });
});

describe('memory and sage delegation', () => {
  it('forwards the whole sage surface', () => {
    const ws = api();
    const options = { queueIfDisconnected: false };

    (ws.listMemory as (o?: unknown) => void)(options);
    (ws.listSageMemories as (o?: unknown) => void)(options);
    (ws.listSageMemoriesPage as (p?: unknown, o?: unknown) => void)({ limit: 10 }, options);
    (ws.getSage as (a: string, o?: unknown) => void)('m1', options);
    (ws.getSageGraph as (a: string, p?: unknown, o?: unknown) => void)(
      'auth',
      { limit: 5 },
      options,
    );
    (ws.updateSage as (a: string, p: unknown, o?: unknown) => void)('m1', { tags: [] }, options);
    (ws.deleteSage as (a: string, r?: string) => void)('m1', 'obsolete');
    (ws.rememberSage as (o: unknown, x?: unknown) => void)({ text: 'x' }, options);
    (ws.findMemoriesForFile as (o: unknown, x?: unknown) => void)({ path: 'a.ts' }, options);
    (ws.recoverSage as (o: unknown, x?: unknown) => void)({ id: 'm1' }, options);
    (ws.resolveMemoryCandidate as (o: unknown, x?: unknown) => void)({ id: 'c1' }, options);
    (ws.backfillRecoverable as (o: unknown, x?: unknown) => void)({ limit: 5 }, options);

    expect(called('listSageMemoriesPage')?.args).toEqual([{ limit: 10 }, options]);
    expect(called('getSageGraph')?.args).toEqual(['auth', { limit: 5 }, options]);
    expect(called('updateSage')?.args).toEqual(['m1', { tags: [] }, options]);
    expect(called('deleteSage')?.args).toEqual(['m1', 'obsolete']);
    for (const method of [
      'listMemory',
      'listSageMemories',
      'getSage',
      'rememberSage',
      'findMemoriesForFile',
      'recoverSage',
      'resolveMemoryCandidate',
      'backfillRecoverable',
    ]) {
      expect(called(method), `${method} was not forwarded`).toBeDefined();
    }
  });
});

describe('diagnostics and mode delegation', () => {
  it('forwards the read-only queries', () => {
    const ws = api();
    const options = { queueIfDisconnected: false };

    (ws.listSkills as (o?: unknown) => void)(options);
    (ws.getDiag as (o?: unknown) => void)(options);
    (ws.getStats as (o?: unknown) => void)(options);
    (ws.getPlan as () => void)();
    (ws.listModes as () => void)();
    (ws.listContextModes as () => void)();

    expect(called('listSkills')?.args).toEqual([options]);
    expect(called('getDiag')?.args).toEqual([options]);
    expect(called('getStats')?.args).toEqual([options]);
    expect(called('getPlan')).toBeDefined();
    expect(called('listModes')).toBeDefined();
    expect(called('listContextModes')).toBeDefined();
  });

  it('forwards the mode mutations', () => {
    const ws = api();
    const mode = {
      id: 'lean',
      name: 'Lean',
      description: 'd',
      thresholds: { warn: 1, soft: 2, hard: 3 },
    };

    (ws.switchMode as (a: string) => void)('plan');
    (ws.switchContextMode as (a: string) => void)('lean');
    (ws.createContextMode as (m: unknown) => void)(mode);
    (ws.updateContextMode as (a: string, p: unknown) => void)('lean', { name: 'Leaner' });
    (ws.deleteContextMode as (a: string) => void)('lean');
    (ws.repairContext as () => void)();

    expect(called('switchMode')?.args).toEqual(['plan']);
    expect(called('switchContextMode')?.args).toEqual(['lean']);
    expect(called('createContextMode')?.args).toEqual([mode]);
    expect(called('updateContextMode')?.args).toEqual(['lean', { name: 'Leaner' }]);
    expect(called('deleteContextMode')?.args).toEqual(['lean']);
    expect(called('repairContext')).toBeDefined();
  });
});

describe('callback identity', () => {
  it('keeps every wrapper stable across a re-render', () => {
    // The client reference never changes, so the useCallback deps never
    // change either — a new identity here would re-subscribe every consumer.
    const { result, rerender } = renderHook(() => useWebSocket());
    const before = result.current;
    rerender();

    expect(result.current.listProviders).toBe(before.listProviders);
    expect(result.current.addProvider).toBe(before.addProvider);
    expect(result.current.getSage).toBe(before.getSage);
  });
});
