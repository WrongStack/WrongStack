import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONFIG,
  PLUGIN_NAME,
  readTelegramConfig,
  readTelegramConfigFromConfig,
  telegramConfigSchema,
} from '../../src/config.js';

describe('telegram config', () => {
  it('reads directly from a raw config snapshot', () => {
    expect(
      readTelegramConfigFromConfig({
        plugins: { telegram: { botToken: 'token', inboundMode: 'disabled' } },
      } as never),
    ).toMatchObject({ botToken: 'token', inboundMode: 'disabled' });
  });

  it('returns defaults when no plugin options are set', () => {
    const api = { config: {} };
    const cfg = readTelegramConfig(api as Parameters<typeof readTelegramConfig>[0]);
    expect(cfg.pollIntervalSec).toBe(2);
    expect(cfg.notifyOnSessionEnd).toBe(false);
    expect(cfg.longToolThresholdMs).toBe(30_000);
    expect(cfg.notifyOnDelegate).toBe(true);
    expect(cfg.maxMessageLength).toBe(4000);
    expect(cfg.inboundMode).toBe('disabled');
    expect(cfg.allowedUsers).toEqual([]);
    expect(cfg.allowedChats).toEqual([]);
    expect(cfg.allowedOutboundChats).toEqual([]);
  });

  it('overrides defaults with user config', () => {
    const api = {
      config: {
        extensions: {
          [PLUGIN_NAME]: {
            botToken: 'token123',
            notifyChatId: '999',
            pollIntervalSec: 5,
            notifyOnSessionEnd: true,
            longToolThresholdMs: 60_000,
            maxMessageLength: 2000,
            allowedUsers: [123, 456],
            allowedChats: ['789'],
            allowedOutboundChats: ['888', -100999],
          },
        },
      },
    };
    const cfg = readTelegramConfig(api as Parameters<typeof readTelegramConfig>[0]);
    expect(cfg.botToken).toBe('token123');
    expect(cfg.notifyChatId).toBe('999');
    expect(cfg.pollIntervalSec).toBe(5);
    expect(cfg.notifyOnSessionEnd).toBe(true);
    expect(cfg.longToolThresholdMs).toBe(60_000);
    expect(cfg.maxMessageLength).toBe(2000);
    expect(cfg.allowedUsers).toEqual([123, 456]);
    expect(cfg.allowedChats).toEqual(['789']);
    expect(cfg.allowedOutboundChats).toEqual(['888', -100999]);
  });

  it('keeps legacy plugins.telegram options working', () => {
    const api = {
      config: {
        plugins: {
          [PLUGIN_NAME]: {
            botToken: 'legacy-token',
            notifyChatId: '111',
          },
        },
      },
    };
    const cfg = readTelegramConfig(api as Parameters<typeof readTelegramConfig>[0]);
    expect(cfg.botToken).toBe('legacy-token');
    expect(cfg.notifyChatId).toBe('111');
  });

  it('reads options from plugin object entries', () => {
    const api = {
      config: {
        plugins: [
          {
            name: '@wrongstack/telegram',
            options: {
              botToken: 'entry-token',
              notifyChatId: '222',
              pollIntervalSec: 7,
            },
          },
        ],
      },
    };
    const cfg = readTelegramConfig(api as Parameters<typeof readTelegramConfig>[0]);
    expect(cfg.botToken).toBe('entry-token');
    expect(cfg.notifyChatId).toBe('222');
    expect(cfg.pollIntervalSec).toBe(7);
  });

  it('lets extensions override plugin object options', () => {
    const api = {
      config: {
        plugins: [
          {
            name: '@wrongstack/telegram',
            options: {
              botToken: 'entry-token',
              notifyChatId: '222',
            },
          },
        ],
        extensions: {
          [PLUGIN_NAME]: {
            notifyChatId: '333',
          },
        },
      },
    };
    const cfg = readTelegramConfig(api as Parameters<typeof readTelegramConfig>[0]);
    expect(cfg.botToken).toBe('entry-token');
    expect(cfg.notifyChatId).toBe('333');
  });

  it('partially overrides — missing fields stay at defaults', () => {
    const api = {
      config: {
        extensions: {
          [PLUGIN_NAME]: {
            botToken: 'token456',
          },
        },
      },
    };
    const cfg = readTelegramConfig(api as Parameters<typeof readTelegramConfig>[0]);
    expect(cfg.botToken).toBe('token456');
    expect(cfg.pollIntervalSec).toBe(2); // default
    expect(cfg.notifyOnSessionEnd).toBe(false); // default
    expect(cfg.inboundMode).toBe('disabled');
    expect(cfg.allowedUsers).toEqual([]); // default
  });

  it('requires explicit public opt-in for allow-all inbound access', () => {
    const cfg = readTelegramConfig({
      config: {
        extensions: {
          [PLUGIN_NAME]: {
            botToken: 'token-public',
            inboundMode: 'public',
          },
        },
      },
    } as Parameters<typeof readTelegramConfig>[0]);

    expect(cfg.inboundMode).toBe('public');
    expect(cfg.allowedUsers).toEqual([]);
    expect(cfg.allowedChats).toEqual([]);
  });

  it('rejects an unknown inbound mode even when schema validation is bypassed', () => {
    expect(() =>
      readTelegramConfig({
        config: {
          extensions: {
            [PLUGIN_NAME]: {
              botToken: 'token-invalid',
              inboundMode: 'friends-only',
            },
          },
        },
      } as Parameters<typeof readTelegramConfig>[0]),
    ).toThrow('Expected one of: disabled, paired, allowlist, public');
  });

  it('rejects allowlist mode when both allowlists are empty', () => {
    expect(() =>
      readTelegramConfig({
        config: {
          extensions: {
            [PLUGIN_NAME]: {
              botToken: 'token-allowlist',
              inboundMode: 'allowlist',
              allowedUsers: [],
              allowedChats: [],
            },
          },
        },
      } as Parameters<typeof readTelegramConfig>[0]),
    ).toThrow('requires at least one allowedUsers or allowedChats entry');
  });

  it('rejects paired mode without a notification chat', () => {
    expect(() =>
      readTelegramConfig({
        config: {
          extensions: {
            [PLUGIN_NAME]: {
              botToken: 'token-paired',
              inboundMode: 'paired',
            },
          },
        },
      } as Parameters<typeof readTelegramConfig>[0]),
    ).toThrow('requires notifyChatId');
  });

  it('migrates legacy non-empty allowlists to allowlist mode without warning', () => {
    const warn = vi.fn();
    const cfg = readTelegramConfig({
      config: {
        plugins: {
          [PLUGIN_NAME]: {
            botToken: 'legacy-token',
            allowedUsers: [123],
          },
        },
      },
      log: { warn },
    } as Parameters<typeof readTelegramConfig>[0]);

    expect(cfg.inboundMode).toBe('allowlist');
    expect(warn).not.toHaveBeenCalled();
  });

  it('migrates a legacy paired chat safely and warns about allow-all removal', () => {
    const warn = vi.fn();
    const cfg = readTelegramConfig({
      config: {
        plugins: {
          [PLUGIN_NAME]: {
            botToken: 'legacy-token',
            notifyChatId: '222',
          },
        },
      },
      log: { warn },
    } as Parameters<typeof readTelegramConfig>[0]);

    expect(cfg.inboundMode).toBe('paired');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('inboundMode "public" explicitly'));
  });

  it('migrates an unpaired legacy config to disabled and warns', () => {
    const warn = vi.fn();
    const cfg = readTelegramConfig({
      config: {
        extensions: {
          [PLUGIN_NAME]: {
            botToken: 'legacy-token',
            allowedUsers: [],
            allowedChats: [],
          },
        },
      },
      log: { warn },
    } as Parameters<typeof readTelegramConfig>[0]);

    expect(cfg.inboundMode).toBe('disabled');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('publishes the inbound mode default and enum in the config schema', () => {
    expect(DEFAULT_CONFIG.inboundMode).toBe('disabled');
    expect(telegramConfigSchema.properties.inboundMode).toMatchObject({
      type: 'string',
      default: 'disabled',
      enum: ['disabled', 'paired', 'allowlist', 'public'],
    });
    expect(DEFAULT_CONFIG.allowedOutboundChats).toEqual([]);
    expect(telegramConfigSchema.properties.allowedOutboundChats).toMatchObject({
      type: 'array',
      items: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
    });
  });
});
