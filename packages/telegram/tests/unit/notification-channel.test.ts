import type { Logger } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { TelegramNotificationChannel } from '../../src/notification-channel.js';

const log = { debug: vi.fn() } as never as Logger;

function bot(overrides: Record<string, unknown> = {}) {
  return {
    sendMessage: vi.fn().mockResolvedValue({ ok: true }),
    health: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as never;
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    level: 'info',
    body: 'Body',
    ...overrides,
  } as never;
}

describe('TelegramNotificationChannel', () => {
  it('queues scrubbed, truncated notifications when a queue is supplied', async () => {
    const enqueue = vi.fn();
    const channel = new TelegramNotificationChannel({
      bot: bot(),
      chatId: 42,
      maxMessageLength: 40,
      enqueueNotification: enqueue,
      log,
    });
    const result = await channel.deliver(
      message({
        level: 'warning',
        title: 'Warning',
        body: `--password=hunter2 ${'x'.repeat(100)}`,
      }),
    );
    expect(result.ok).toBe(true);
    expect(enqueue).toHaveBeenCalledWith(42, expect.not.stringContaining('hunter2'));
    expect(String(enqueue.mock.calls[0]?.[1]).length).toBeLessThanOrEqual(40);
  });

  it('delivers directly and supports critical messages without titles', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    const channel = new TelegramNotificationChannel({
      bot: bot({ sendMessage }),
      chatId: 'chat',
    });
    await expect(channel.deliver(message({ level: 'critical' }))).resolves.toMatchObject({
      ok: true,
      channel: 'telegram',
    });
    expect(sendMessage).toHaveBeenCalledWith('chat', expect.stringContaining('🚨 Body'));
  });

  it('maps API ok=false responses to a channel error', async () => {
    const channel = new TelegramNotificationChannel({
      bot: bot({ sendMessage: vi.fn().mockResolvedValue({ ok: false }) }),
      chatId: 1,
      log,
    });
    await expect(channel.deliver(message({ level: 'unexpected' }))).resolves.toMatchObject({
      ok: false,
      error: 'Telegram API returned ok=false',
    });
  });

  it.each([
    [new Error('transport failed'), 'transport failed'],
    ['string failure', 'string failure'],
  ])('captures direct-delivery exceptions', async (failure, expected) => {
    const channel = new TelegramNotificationChannel({
      bot: bot({ sendMessage: vi.fn().mockRejectedValue(failure) }),
      chatId: 1,
      log,
    });
    await expect(channel.deliver(message())).resolves.toMatchObject({
      ok: false,
      error: expected,
    });
  });

  it('reports healthy and unhealthy ping results', async () => {
    await expect(
      new TelegramNotificationChannel({ bot: bot(), chatId: 1 }).ping(),
    ).resolves.toEqual({ ok: true });
    await expect(
      new TelegramNotificationChannel({
        bot: bot({ health: vi.fn().mockResolvedValue({ ok: false, error: 'bad token' }) }),
        chatId: 1,
      }).ping(),
    ).resolves.toEqual({ ok: false, error: 'bad token' });
    await expect(
      new TelegramNotificationChannel({
        bot: bot({ health: vi.fn().mockResolvedValue({ ok: false }) }),
        chatId: 1,
      }).ping(),
    ).resolves.toEqual({ ok: false, error: 'health check failed' });
  });

  it.each([
    [new Error('health failed'), 'health failed'],
    ['health string', 'health string'],
  ])('captures health-check exceptions', async (failure, expected) => {
    const channel = new TelegramNotificationChannel({
      bot: bot({ health: vi.fn().mockRejectedValue(failure) }),
      chatId: 1,
    });
    await expect(channel.ping()).resolves.toEqual({ ok: false, error: expected });
  });
});
