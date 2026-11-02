import { vi } from 'vitest';

// SQLite reported missing: `wrongmemory` mode must not need it, `local` must.
vi.mock('@wrongstack/sage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/sage')>();
  return { ...actual, isSqliteAvailable: () => false };
});

import { TOKENS } from '@wrongstack/contracts/kernel';
import { AutoSageMemoryPort, WrongMemoryPort } from '@wrongstack/sage';
import { describe, expect, it } from 'vitest';
import { createDefaultContainer } from '../src/container.js';

function build(service?: Record<string, unknown>) {
  return createDefaultContainer({
    config: {
      version: 1,
      provider: 'noop',
      model: 'noop',
      ...(service ? { Sage: { service } } : {}),
    } as never,
    wpaths: {
      projectRoot: '/repo',
      projectSessions: '/tmp/sessions',
      configDir: '/tmp/config',
      projectTrust: '/tmp/trust.json',
      globalRoot: '/tmp/global',
      projectSlug: 'repo',
    } as never,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      child() {
        return this;
      },
    } as never,
    modelsRegistry: {} as never,
  });
}

describe('createDefaultContainer Sage.service selection', () => {
  it('wrongmemory binds ONE WrongMemoryPort under MemoryStore and MemoryPort without SQLite', () => {
    const container = build({ mode: 'wrongmemory', startPolicy: 'never' });
    const store = container.resolve(TOKENS.MemoryStore);
    const port = container.resolve(TOKENS.MemoryPort);
    expect(store).toBeInstanceOf(WrongMemoryPort);
    expect(port).toBe(store);
  });

  it('auto binds a deferred selector that does not require SQLite up front', () => {
    const container = build({ mode: 'auto' });
    const store = container.resolve(TOKENS.MemoryStore);
    expect(store).toBeInstanceOf(AutoSageMemoryPort);
    expect(container.resolve(TOKENS.MemoryPort)).toBe(store);
  });

  it('local (default and explicit) keeps requiring SQLite', () => {
    expect(() => build()).toThrow(/SAGE requires synchronous SQLite/);
    expect(() => build({ mode: 'local' })).toThrow(/SAGE requires synchronous SQLite/);
  });
});
