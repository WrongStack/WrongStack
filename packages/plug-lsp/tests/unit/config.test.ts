import { TOKENS } from '@wrongstack/core/kernel';
import { describe, expect, it } from 'vitest';
import {
  mergeConfig,
  PLUGIN_NAME,
  readPlugLSPConfig,
  withPresetFallbacks,
} from '../../src/config.js';

describe('plug-lsp config', () => {
  it('normalizes valid server config and defaults invalid options', () => {
    const cfg = mergeConfig({
      autoStart: 'eager',
      diagnosticsAfterEdit: 'manual',
      diagnosticsWaitMs: 25,
      severityFilter: ['error', 'nope', 'hint'],
      maxDiagnosticsPerFile: 2,
      maxDiagnosticsTotal: 9,
      autoDiscover: false,
      logServerOutput: true,
      servers: {
        valid: {
          command: 'server',
          args: ['--stdio'],
          env: { A: '1', B: 2 },
          languages: ['typescript'],
          rootPatterns: ['package.json'],
          initializationOptions: { a: true },
          settings: { b: true },
          startupTimeoutMs: 42,
          enabled: false,
        },
        invalid: { command: 1, languages: ['typescript'] },
        nonObject: null,
      },
    });

    expect(cfg.autoStart).toBe('eager');
    expect(cfg.diagnosticsAfterEdit).toBe('manual');
    expect(cfg.severityFilter).toEqual(['error', 'hint']);
    expect(cfg.autoDiscover).toBe(false);
    expect(cfg.logServerOutput).toBe(true);
    expect(Object.keys(cfg.servers)).toEqual(['valid']);
    expect(cfg.servers.valid).toMatchObject({
      command: 'server',
      args: ['--stdio'],
      env: { A: '1' },
      languages: ['typescript'],
      startupTimeoutMs: 42,
      enabled: false,
    });
  });

  it('falls back when values are malformed', () => {
    const cfg = mergeConfig({
      autoStart: 'bad',
      diagnosticsAfterEdit: 'bad',
      diagnosticsWaitMs: -1,
      severityFilter: ['bad'],
      maxDiagnosticsPerFile: 0,
      maxDiagnosticsTotal: Number.NaN,
      servers: {
        badLanguages: { command: 'server', languages: ['typescript', 1] },
      },
    });

    expect(cfg).toMatchObject({
      autoStart: 'lazy',
      diagnosticsAfterEdit: 'background',
      diagnosticsWaitMs: 1500,
      severityFilter: ['error', 'warning'],
      maxDiagnosticsPerFile: 5,
      maxDiagnosticsTotal: 50,
      autoDiscover: true,
      logServerOutput: false,
      servers: {},
    });
  });

  it('can fill in the TypeScript preset only when no servers are configured', () => {
    expect(withPresetFallbacks(mergeConfig({ servers: {} })).servers.typescript).toBeDefined();
    const cfg = mergeConfig({
      servers: { custom: { command: 'x', languages: ['typescript'] } },
    });
    expect(Object.keys(withPresetFallbacks(cfg).servers)).toEqual(['custom']);
  });

  it('prefers ConfigStore extension config and falls back when resolving fails', () => {
    const api = {
      container: {
        has: (token: unknown) => token === TOKENS.ConfigStore,
        resolve: () => ({ getExtension: () => ({ autoStart: 'never', servers: {} }) }),
      },
      config: { extensions: { [PLUGIN_NAME]: { autoStart: 'eager', servers: {} } } },
    };
    expect(readPlugLSPConfig(api as never).autoStart).toBe('never');

    const fallback = {
      container: {
        has: () => true,
        resolve: () => {
          throw new Error('no store');
        },
      },
      config: { extensions: { [PLUGIN_NAME]: { autoStart: 'eager', servers: {} } } },
    };
    expect(readPlugLSPConfig(fallback as never).autoStart).toBe('eager');
    expect(
      readPlugLSPConfig({ container: { has: () => false }, config: {} } as never).autoStart,
    ).toBe('lazy');
  });
});
