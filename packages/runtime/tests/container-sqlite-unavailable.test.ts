import { vi } from 'vitest';

vi.mock('@wrongstack/sage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/sage')>();
  return {
    ...actual,
    isSqliteAvailable: () => false,
  };
});

import { describe, expect, it } from 'vitest';
import { createDefaultContainer } from '../src/container.js';

describe('createDefaultContainer without built-in SQLite', () => {
  it('fails clearly instead of silently selecting the removed JSONL backend', () => {
    expect(() =>
      createDefaultContainer({
        config: {
          version: 1,
          provider: 'noop',
          model: 'noop',
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
      }),
    ).toThrow(/SAGE requires Node built-in SQLite/);
  });
});
