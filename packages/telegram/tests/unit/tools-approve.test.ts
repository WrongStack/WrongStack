import type { Logger } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramBot } from '../../src/bot.js';
import { TELEGRAM_APPROVAL_CAPABILITY } from '../../src/security/outbound.js';
import { makeTelegramApproveTool } from '../../src/tools/telegram-approve.js';

const log: Logger = {
  level: 'debug',
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child() {
    return this;
  },
};

function makeBot(overrides?: { allowedUsers?: string[]; allowedChats?: string[] }) {
  return new TelegramBot({
    token: 'test:token',
    pollIntervalSec: 60,
    allowedUsers: new Set(overrides?.allowedUsers ?? []),
    allowedChats: new Set(overrides?.allowedChats ?? []),
    bufferSize: 10,
    log,
    onMessage: vi.fn(),
  });
}

function makeTool(bot: TelegramBot, chatId = '999', userIds: string[] = [chatId]) {
  return makeTelegramApproveTool({
    bot,
    getDefaultChatId: () => chatId,
    getAllowedUserIds: () => userIds,
    maxMessageLength: 4000,
    log,
  });
}

function runApprove(
  tool: ReturnType<typeof makeTelegramApproveTool>,
  input: Parameters<(typeof tool)['execute']>[0],
) {
  return tool.execute(input, undefined as never, { signal: new AbortController().signal });
}

describe('telegram_approve tool', () => {
  let _originalFetch: typeof globalThis.fetch;
  let sentBodies: string[];

  beforeEach(() => {
    _originalFetch = globalThis.fetch;
    sentBodies = [];
    // Default: sendMessage succeeds, no polls return anything.
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.body) sentBodies.push(String(init.body));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: { message_id: 42 } }),
      });
    }) as never as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = _originalFetch;
  });

  it('declares its explicit narrow approval capability and network mutation', () => {
    const tool = makeTool(makeBot());

    expect(tool.permission).toBe('auto');
    expect(tool.mutating).toBe(true);
    expect(tool.riskTier).toBe('standard');
    expect(tool.capabilities).toEqual([TELEGRAM_APPROVAL_CAPABILITY]);
  });

  it('defaults private-chat approval identity to the target when no user resolver exists', async () => {
    const awaitApproval = vi.fn().mockResolvedValue({
      approved: false,
      fromUserId: undefined,
      fromUser: 'timeout',
    });
    const bot = {
      awaitApproval,
      sendMessageWithKeyboard: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 7 } }),
      bindApprovalPrompt: vi.fn().mockReturnValue(true),
      cancelApproval: vi.fn(),
    } as never;
    const tool = makeTelegramApproveTool({
      bot,
      getDefaultChatId: () => '999',
      maxMessageLength: 4000,
      log,
    });
    await expect(runApprove(tool, { prompt: 'Private?' })).resolves.toMatchObject({
      approved: false,
      prompt_message_id: 7,
    });
    expect(awaitApproval).toHaveBeenCalledWith(
      expect.objectContaining({ expectedUserIds: ['999'] }),
    );
  });

  it('returns approved=false and fromUser=timeout when no callback arrives', async () => {
    const bot = makeBot();
    const tool = makeTool(bot);

    const start = Date.now();
    const result = await tool.execute({ prompt: 'Continue?', timeout_ms: 150 });
    const elapsed = Date.now() - start;

    expect(result.approved).toBe(false);
    expect(result.from).toBe('timeout');
    expect(result.prompt_message_id).toBe(42);
    expect(elapsed).toBeGreaterThanOrEqual(140);

    // One outbound sendMessage with the prompt + inline keyboard.
    const prompts = sentBodies.filter((b) => b.includes('Continue?'));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('inline_keyboard');
    expect(prompts[0]).toContain(':yes');
    expect(prompts[0]).toContain(':no');
  });

  it('fails promptly and removes the request when sending the prompt fails', async () => {
    const bot = makeBot();
    const tool = makeTool(bot);
    vi.spyOn(bot, 'sendMessageWithKeyboard').mockRejectedValue(new Error('send failed'));

    const start = Date.now();
    await expect(tool.execute({ prompt: 'Cannot send', timeout_ms: 5_000 })).rejects.toThrow(
      'send failed',
    );
    expect(Date.now() - start).toBeLessThan(500);
    expect((bot as unknown as { callbackWaiters: Map<string, unknown> }).callbackWaiters.size).toBe(
      0,
    );
  });

  it('rejects a prompt response without a message id', async () => {
    const bot = makeBot();
    const tool = makeTool(bot);
    vi.spyOn(bot, 'sendMessageWithKeyboard').mockResolvedValue({
      ok: true,
      result: undefined,
    } as never);
    await expect(runApprove(tool, { prompt: 'Missing id', timeout_ms: 5_000 })).rejects.toThrow(
      'did not include a message ID',
    );
    expect((bot as unknown as { callbackWaiters: Map<string, unknown> }).callbackWaiters.size).toBe(
      0,
    );
  });

  it('rejects when the approval ends before its prompt can bind', async () => {
    const bot = makeBot();
    const tool = makeTool(bot);
    vi.spyOn(bot, 'bindApprovalPrompt').mockReturnValue(false);
    await expect(runApprove(tool, { prompt: 'Ended early', timeout_ms: 5_000 })).rejects.toThrow(
      'ended before its prompt could be bound',
    );
    expect((bot as unknown as { callbackWaiters: Map<string, unknown> }).callbackWaiters.size).toBe(
      0,
    );
  });

  it('queues a callback that arrives before the send response binds message_id', async () => {
    const bot = makeBot();
    const tool = makeTool(bot);
    vi.spyOn(bot, 'sendMessageWithKeyboard').mockImplementation(async (chatId, _text, buttons) => {
      const yesKey = buttons[0]!.callback_data;
      await (
        bot.approvals as unknown as {
          dispatchCallback(cq: {
            id: string;
            from: { id: number; username: string };
            message: { message_id: number; chat: { id: number; type: string } };
            data: string;
          }): Promise<void>;
        }
      ).dispatchCallback({
        id: 'cb-before-send-response',
        from: { id: 999, username: 'alice' },
        message: { message_id: 42, chat: { id: Number(chatId), type: 'private' } },
        data: yesKey,
      });
      return { ok: true, result: { message_id: 42 } } as never;
    });

    await expect(tool.execute({ prompt: 'Immediate?', timeout_ms: 5_000 })).resolves.toMatchObject({
      approved: true,
      from: 'alice',
      prompt_message_id: 42,
    });
  });

  it('cleans up promptly when the tool signal aborts', async () => {
    const bot = makeBot();
    const tool = makeTool(bot);
    const controller = new AbortController();
    const resultPromise = tool.execute(
      { prompt: 'Abort me', timeout_ms: 5_000 },
      undefined as never,
      { signal: controller.signal },
    );
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();

    await expect(resultPromise).resolves.toMatchObject({ approved: false, from: 'aborted' });
    expect((bot as unknown as { callbackWaiters: Map<string, unknown> }).callbackWaiters.size).toBe(
      0,
    );
  });

  it('truncates details to fit Telegram', async () => {
    const bot = makeBot();
    const tool = makeTool(bot);

    await tool.execute({
      prompt: 'Go?',
      details: 'a'.repeat(2000),
      timeout_ms: 100,
    });

    const prompt = sentBodies.find((b) => b.includes('Go?'))!;
    expect(prompt.length).toBeLessThan(2000); // well under Telegram's 4096
  });

  it('throws when no chat_id is provided and no default is set', async () => {
    const bot = makeBot();
    const tool = makeTelegramApproveTool({
      bot,
      getDefaultChatId: () => undefined,
      maxMessageLength: 4000,
      log,
    });

    await expect(tool.execute({ prompt: 'x' })).rejects.toThrow('No chat_id provided');
  });

  it('rejects an untrusted chat_id before sending a prompt', async () => {
    const bot = makeBot();
    const sendSpy = vi.spyOn(bot, 'sendMessageWithKeyboard');
    const tool = makeTelegramApproveTool({
      bot,
      getDefaultChatId: () => '999',
      getAllowedOutboundChatIds: () => ['111'],
      maxMessageLength: 4000,
      log,
    });

    await expect(tool.execute({ chat_id: '222', prompt: 'x' })).rejects.toThrow(
      'not paired or included in allowedOutboundChats',
    );
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('scrubs credentials in both prompt and details before sending', async () => {
    const bot = makeBot();
    const tool = makeTool(bot);
    const raw = 'sk-' + 'b'.repeat(24);
    const botToken = `654321:${'APPROVAL_BOT_CANARY_'.repeat(2)}`;

    await tool.execute({
      prompt: `Approve ${raw}?`,
      details: `Telegram ${botToken}; TOKEN=CANARY_APPROVAL_SECRET_DDD`,
      timeout_ms: 100,
    });

    const prompt = sentBodies.find((body) => body.includes('Approve')) ?? '';
    expect(prompt).not.toContain(raw);
    expect(prompt).not.toContain(botToken);
    expect(prompt).not.toContain('CANARY_APPROVAL_SECRET_DDD');
    expect(prompt).toContain('[REDACTED');
  });

  it('caps timeout_ms to the documented 600 000 ms ceiling', async () => {
    const bot = makeBot();
    const tool = makeTool(bot);

    const start = Date.now();
    const result = await tool.execute({ prompt: 'x', timeout_ms: 10 });
    const elapsed = Date.now() - start;

    expect(result.approved).toBe(false);
    expect(result.from).toBe('timeout');
    expect(elapsed).toBeGreaterThanOrEqual(950); // not 10 ms — clamped >=1000 ms minimum
    expect(elapsed).toBeLessThan(1500);
  });

  it('resolves approved=true when a matching yes-key arrives via bot.awaitCallback', async () => {
    const bot = makeBot();
    const tool = makeTool(bot);

    // Kick off the approval request, then race a waiter that fires yes.
    const execPromise = tool.execute({ prompt: 'ok?', timeout_ms: 5_000 });

    // Wait a tick so the tool has registered its two awaitCallback keys.
    await new Promise((r) => setTimeout(r, 5));

    // Find the registered yes key from the outbound prompt body so we
    // simulate the exact key the bot will see.
    const prompt = sentBodies.find((b) => b.includes('ok?'))!;
    const yesMatch = prompt.match(/"callback_data":"(approve:[^"]+:yes)"/);
    expect(yesMatch).not.toBeNull();
    const yesKey = yesMatch![1]!;

    await (
      bot.approvals as unknown as {
        dispatchCallback(cq: {
          id: string;
          from?: { id: number; username?: string; first_name?: string };
          message?: { message_id: number; chat: { id: number; type: string } };
          data?: string;
        }): Promise<void>;
      }
    ).dispatchCallback({
      id: 'cb-approve',
      from: { id: 999, username: 'alice' },
      message: { message_id: 42, chat: { id: 999, type: 'private' } },
      data: yesKey,
    });

    const result = await execPromise;
    expect(result.approved).toBe(true);
    expect(result.user_id).toBe(999);
    expect(result.display_name).toBe('alice');
    expect(result.from).toBe('alice');
  });
});

// ---------------------------------------------------------------------------
// Allowlist enforcement end-to-end (tool + dispatchCallback integration)
// ---------------------------------------------------------------------------

describe('telegram_approve with bot allowlist', () => {
  let _originalFetch: typeof globalThis.fetch;
  let sentBodies: string[];
  let ackCalls: Array<{ url: string; body: string }>;

  beforeEach(() => {
    _originalFetch = globalThis.fetch;
    sentBodies = [];
    ackCalls = [];
    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      const b = String(init?.body ?? '');
      if (b) sentBodies.push(b);
      if (u.endsWith('/answerCallbackQuery')) {
        ackCalls.push({ url: u, body: b });
      }
      // sendMessage needs a real-looking response so the tool picks up
      // prompt_message_id; answerCallbackQuery can return anything.
      if (u.endsWith('/sendMessage')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, result: { message_id: 42 } }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: true }),
      });
    }) as never as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = _originalFetch;
  });

  it('an allowlisted user gets approved=true', async () => {
    // Allowlist ONLY user 1; chat 999 is also on the allowlist so
    // the chat-side check passes for the test setup.
    const bot = makeBot({ allowedUsers: ['1'], allowedChats: ['999'] });
    const tool = makeTool(bot, '999', ['1']);
    const execPromise = tool.execute({ prompt: 'ok?', timeout_ms: 5_000 });
    await new Promise((r) => setTimeout(r, 5));
    const prompt = sentBodies.find((b) => b.includes('ok?'))!;
    const yesMatch = prompt.match(/"callback_data":"(approve:[^"]+:yes)"/);
    expect(yesMatch).not.toBeNull();
    const yesKey = yesMatch![1]!;

    await (
      bot.approvals as unknown as {
        dispatchCallback(cq: {
          id: string;
          from?: { id: number; username?: string };
          message?: { message_id: number; chat: { id: number; type: string } };
          data?: string;
        }): Promise<void>;
      }
    ).dispatchCallback({
      id: 'cb-ok',
      from: { id: 1, username: 'alice' },
      message: { message_id: 42, chat: { id: 999, type: 'private' } },
      data: yesKey,
    });

    const result = await execPromise;
    expect(result.approved).toBe(true);
    expect(result.from).toBe('alice');
    // No "Not authorized" toast was sent — the allowlist check passed.
    expect(ackCalls.find((c) => c.body.includes('Not authorized'))).toBeUndefined();
    bot.stop();
  });

  it('a non-allowlisted user gets a denial toast without consuming the request', async () => {
    const bot = makeBot({ allowedUsers: ['1'], allowedChats: ['999'] });
    const tool = makeTool(bot, '999', ['1']);
    const execPromise = tool.execute({ prompt: 'Sensitive op?', timeout_ms: 1_000 });
    await new Promise((r) => setTimeout(r, 5));
    const prompt = sentBodies.find((b) => b.includes('Sensitive op?'))!;
    const yesKey = prompt.match(/"callback_data":"(approve:[^"]+:yes)"/)![1]!;

    const dispatch = (
      bot.approvals as unknown as {
        dispatchCallback(cq: {
          id: string;
          from: { id: number; username?: string };
          message: { message_id: number; chat: { id: number; type: string } };
          data: string;
        }): Promise<void>;
      }
    ).dispatchCallback.bind(bot.approvals);
    await dispatch({
      id: 'cb-hijack',
      from: { id: 2, username: 'mallory' },
      message: { message_id: 42, chat: { id: 999, type: 'private' } },
      data: yesKey,
    });
    const denied = ackCalls.find((c) => c.body.includes('Not authorized'));
    expect(denied?.body).toContain('"show_alert":true');

    await dispatch({
      id: 'cb-intended',
      from: { id: 1, username: 'alice' },
      message: { message_id: 42, chat: { id: 999, type: 'private' } },
      data: yesKey,
    });
    await expect(execPromise).resolves.toMatchObject({ approved: true, from: 'alice' });
    bot.stop();
  });

  it('a non-allowlisted chat cannot consume the valid chat’s request', async () => {
    const bot = makeBot({ allowedUsers: ['42'], allowedChats: ['999'] });
    const tool = makeTool(bot, '999', ['42']);
    const execPromise = tool.execute({ prompt: 'Cross-chat?', timeout_ms: 1_000 });
    await new Promise((r) => setTimeout(r, 5));
    const prompt = sentBodies.find((b) => b.includes('Cross-chat?'))!;
    const yesKey = prompt.match(/"callback_data":"(approve:[^"]+:yes)"/)![1]!;
    const dispatch = (
      bot.approvals as unknown as {
        dispatchCallback(cq: {
          id: string;
          from: { id: number; username?: string };
          message: { message_id: number; chat: { id: number; type: string } };
          data: string;
        }): Promise<void>;
      }
    ).dispatchCallback.bind(bot.approvals);

    await dispatch({
      id: 'cb-cross-chat',
      from: { id: 42, username: 'bob' },
      message: { message_id: 1, chat: { id: 7, type: 'group' } },
      data: yesKey,
    });
    expect(ackCalls.at(-1)?.body).toContain('Not authorized');
    await dispatch({
      id: 'cb-valid-chat',
      from: { id: 42, username: 'bob' },
      message: { message_id: 42, chat: { id: 999, type: 'private' } },
      data: yesKey,
    });

    await expect(execPromise).resolves.toMatchObject({ approved: true, from: 'bob' });
    bot.stop();
  });

  it('an allowlisted but unintended user cannot consume another user’s request', async () => {
    const bot = makeBot({ allowedUsers: ['1', '2'], allowedChats: ['999'] });
    const tool = makeTool(bot, '999', ['1']);
    const execPromise = tool.execute({ prompt: 'Identity-bound?', timeout_ms: 1_000 });
    await new Promise((r) => setTimeout(r, 5));
    const prompt = sentBodies.find((b) => b.includes('Identity-bound?'))!;
    const yesKey = prompt.match(/"callback_data":"(approve:[^"]+:yes)"/)![1]!;
    const dispatch = (
      bot.approvals as unknown as {
        dispatchCallback(cq: {
          id: string;
          from: { id: number; username?: string };
          message: { message_id: number; chat: { id: number; type: string } };
          data: string;
        }): Promise<void>;
      }
    ).dispatchCallback.bind(bot.approvals);

    await dispatch({
      id: 'cb-wrong-allowlisted-user',
      from: { id: 2, username: 'other-allowed-user' },
      message: { message_id: 42, chat: { id: 999, type: 'private' } },
      data: yesKey,
    });
    expect(ackCalls.at(-1)?.body).toContain('Not authorized for this approval');
    await dispatch({
      id: 'cb-intended-user',
      from: { id: 1, username: 'alice' },
      message: { message_id: 42, chat: { id: 999, type: 'private' } },
      data: yesKey,
    });

    await expect(execPromise).resolves.toMatchObject({ approved: true, from: 'alice' });
    bot.stop();
  });

  it('a callback for a different prompt message cannot consume the request', async () => {
    const bot = makeBot({ allowedUsers: ['1'], allowedChats: ['999'] });
    const tool = makeTool(bot, '999', ['1']);
    const execPromise = tool.execute({ prompt: 'Message-bound?', timeout_ms: 1_000 });
    await new Promise((r) => setTimeout(r, 5));
    const prompt = sentBodies.find((b) => b.includes('Message-bound?'))!;
    const yesKey = prompt.match(/"callback_data":"(approve:[^"]+:yes)"/)![1]!;
    const dispatch = (
      bot.approvals as unknown as {
        dispatchCallback(cq: {
          id: string;
          from: { id: number; username?: string };
          message: { message_id: number; chat: { id: number; type: string } };
          data: string;
        }): Promise<void>;
      }
    ).dispatchCallback.bind(bot.approvals);

    await dispatch({
      id: 'cb-wrong-message',
      from: { id: 1, username: 'alice' },
      message: { message_id: 41, chat: { id: 999, type: 'private' } },
      data: yesKey,
    });
    await dispatch({
      id: 'cb-right-message',
      from: { id: 1, username: 'alice' },
      message: { message_id: 42, chat: { id: 999, type: 'private' } },
      data: yesKey,
    });

    await expect(execPromise).resolves.toMatchObject({ approved: true, from: 'alice' });
    bot.stop();
  });

  it('denies group approval without explicit per-user group configuration before sending', async () => {
    const bot = makeBot({ allowedUsers: ['1'], allowedChats: ['-100'] });
    const sendSpy = vi.spyOn(bot, 'sendMessageWithKeyboard');
    const tool = makeTool(bot, '-100', ['1']);

    await expect(tool.execute({ prompt: 'Group op?' })).rejects.toThrow(
      'group approvals require explicit per-user configuration',
    );
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('allows group approval when getAllowGroupApprovals resolves true with configured users', async () => {
    const bot = makeBot({ allowedUsers: ['1'], allowedChats: ['-100'] });
    const sendSpy = vi.spyOn(bot, 'sendMessageWithKeyboard');
    const tool = makeTelegramApproveTool({
      bot,
      getDefaultChatId: () => '-100',
      getAllowedUserIds: () => ['1'],
      getAllowGroupApprovals: () => true,
      maxMessageLength: 4000,
      log,
    });

    // Positive path: the group gate passes and the prompt is actually sent,
    // and the tool settles cleanly (no callback → approved=false, timeout).
    const result = await tool.execute(
      { prompt: 'Group ok?', timeout_ms: 100 },
      { session: { id: 'telegram-test' } } as never,
      { signal: new AbortController().signal },
    );

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(result.prompt_message_id).toBe(42);
    expect(result.approved).toBe(false);
    expect(result.from).toBe('timeout');
    bot.stop();
  });

  it('a non-allowlisted user pressing Deny cannot consume the request', async () => {
    const bot = makeBot({ allowedUsers: ['1'], allowedChats: ['999'] });
    const tool = makeTool(bot, '999', ['1']);
    const execPromise = tool.execute({ prompt: 'Deny-bot?', timeout_ms: 1_000 });
    await new Promise((r) => setTimeout(r, 5));
    const prompt = sentBodies.find((b) => b.includes('Deny-bot?'))!;
    const noKey = prompt.match(/"callback_data":"(approve:[^"]+:no)"/)![1]!;
    const dispatch = (
      bot.approvals as unknown as {
        dispatchCallback(cq: {
          id: string;
          from: { id: number; username?: string };
          message: { message_id: number; chat: { id: number; type: string } };
          data: string;
        }): Promise<void>;
      }
    ).dispatchCallback.bind(bot.approvals);

    await dispatch({
      id: 'cb-deny-hijack',
      from: { id: 2, username: 'mallory' },
      message: { message_id: 42, chat: { id: 999, type: 'private' } },
      data: noKey,
    });
    await dispatch({
      id: 'cb-intended-deny',
      from: { id: 1, username: 'alice' },
      message: { message_id: 42, chat: { id: 999, type: 'private' } },
      data: noKey,
    });

    await expect(execPromise).resolves.toMatchObject({ approved: false, from: 'alice' });
    bot.stop();
  });

  it('unauthorized first, legitimate second, then duplicate cannot double-resolve', async () => {
    const bot = makeBot({ allowedUsers: ['1'], allowedChats: ['999'] });
    const tool = makeTool(bot, '999', ['1']);
    const execPromise = tool.execute({ prompt: 'Race?', timeout_ms: 1_000 });
    await new Promise((r) => setTimeout(r, 5));
    const prompt = sentBodies.find((b) => b.includes('Race?'))!;
    const yesKey = prompt.match(/"callback_data":"(approve:[^"]+:yes)"/)![1]!;
    const dispatch = (
      bot.approvals as unknown as {
        dispatchCallback(cq: {
          id: string;
          from: { id: number; username?: string };
          message: { message_id: number; chat: { id: number; type: string } };
          data: string;
        }): Promise<void>;
      }
    ).dispatchCallback.bind(bot.approvals);

    await dispatch({
      id: 'cb-unauthorized',
      from: { id: 2, username: 'mallory' },
      message: { message_id: 42, chat: { id: 999, type: 'private' } },
      data: yesKey,
    });
    await dispatch({
      id: 'cb-legitimate',
      from: { id: 1, username: 'alice' },
      message: { message_id: 42, chat: { id: 999, type: 'private' } },
      data: yesKey,
    });
    const result = await execPromise;
    expect(result).toMatchObject({ approved: true, from: 'alice' });
    expect((bot as unknown as { callbackWaiters: Map<string, unknown> }).callbackWaiters.size).toBe(
      0,
    );

    await dispatch({
      id: 'cb-duplicate',
      from: { id: 1, username: 'alice' },
      message: { message_id: 42, chat: { id: 999, type: 'private' } },
      data: yesKey,
    });
    expect(ackCalls).toHaveLength(3);
    expect(ackCalls[0]!.body).toContain('Not authorized');
    expect(ackCalls[1]!.body).toContain('Approved');
    expect(ackCalls[2]!.body).toContain('unavailable');
    expect(result).toMatchObject({ approved: true, from: 'alice' });
    bot.stop();
  });
});
