import { describe, expect, it } from 'vitest';
import {
  resolveTelegramOutboundTarget,
  scrubTelegramOutboundText,
} from '../../src/security/outbound.js';

describe('Telegram outbound security', () => {
  it('requires a configured or requested trusted target', () => {
    expect(() =>
      resolveTelegramOutboundTarget(undefined, {
        getDefaultChatId: () => undefined,
      }),
    ).toThrow(/No chat_id provided/);
    expect(() =>
      resolveTelegramOutboundTarget('   ', {
        getDefaultChatId: () => undefined,
      }),
    ).toThrow(/No chat_id provided/);
  });

  it('accepts and normalizes paired and explicitly allowed targets', () => {
    const policy = {
      getDefaultChatId: () => ' 100 ',
      getAllowedOutboundChatIds: () => [' ', 200],
    };
    expect(resolveTelegramOutboundTarget(undefined, policy)).toBe('100');
    expect(resolveTelegramOutboundTarget(' 200 ', policy)).toBe('200');
    expect(resolveTelegramOutboundTarget(200, policy)).toBe(200);
    expect(
      resolveTelegramOutboundTarget(undefined, {
        getDefaultChatId: () => 100,
      }),
    ).toBe(100);
  });

  it('rejects targets outside the allowlist and ignores an empty default', () => {
    expect(() =>
      resolveTelegramOutboundTarget('300', {
        getDefaultChatId: () => ' ',
        getAllowedOutboundChatIds: () => [200],
      }),
    ).toThrow(/not paired/);
  });

  it('scrubs core secrets, Telegram bot tokens, and labelled flags', () => {
    const output = scrubTelegramOutboundText(
      'token 123456789:abcdefghijklmnopqrstuvwxyzABCDEF --password=hunter2',
    );
    expect(output).not.toContain('123456789:');
    expect(output).not.toContain('hunter2');
  });

  it('scrubs redis -a auth and short PASSPHRASE values through the full pipeline (canonical-parity regression)', () => {
    // Both forms were previously missed by the drifted telegram copy while
    // the canonical redactCommand set redacted them (r1-telegram-redact-drift).
    const output = scrubTelegramOutboundText(
      'redis-cli -a CANARY_REDIS_PW_GGG get key; PASSPHRASE=CANARY_PASSPHRASE_HHH openssl enc -d',
    );
    expect(output).not.toContain('CANARY_REDIS_PW_GGG');
    expect(output).not.toContain('CANARY_PASSPHRASE_HHH');
    expect(output).toContain('-a [REDACTED]');
    expect(output).toContain('PASSPHRASE=[REDACTED]');
  });
});
