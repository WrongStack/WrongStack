import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultSecretVault, decryptConfigSecrets } from '@wrongstack/core/security';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  discoverTelegramPairingCandidates,
  extractTelegramPairingCandidates,
  formatTelegramPairingCandidates,
  parseTelegramPairingChoice,
  type TelegramPairingUpdate,
} from '../src/slash-commands/telegram-pairing.js';
import { buildTelegramSetupCommand } from '../src/slash-commands/telegram-setup.js';

const TOKEN = '123456:superSecretToken';
const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

function privateUpdate(
  updateId: number,
  id: number,
  extra: Record<string, unknown> = {},
): TelegramPairingUpdate {
  return {
    update_id: updateId,
    message: {
      chat: { id, type: 'private', ...extra },
      from: { id, is_bot: false },
      ...extra,
    },
  } as TelegramPairingUpdate;
}

function groupUpdate(updateId: number, chatId: number, userId: number): TelegramPairingUpdate {
  return {
    update_id: updateId,
    message: {
      chat: { id: chatId, type: 'group' },
      from: { id: userId, is_bot: false },
    },
  };
}

async function setupRig(choice: string, useSurfacePrompt = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-tg-pairing-'));
  tempDirs.push(dir);
  const configPath = path.join(dir, 'config.json');
  const vault = new DefaultSecretVault({ keyFile: path.join(dir, '.key') });
  let config: Record<string, unknown> = {};
  const configStore = {
    get: vi.fn(() => config),
    update: vi.fn((patch: Record<string, unknown>) => {
      config = { ...config, ...patch };
    }),
  };
  const write = vi.fn();
  const readLine = vi.fn(async () => choice);
  const readText = vi.fn(async () => choice);
  const command = buildTelegramSetupCommand({
    configStore,
    paths: { globalConfig: configPath, profileConfig: () => configPath },
    readSecret: vi.fn(async () => TOKEN),
    vault,
    renderer: { write },
    reader: { readLine },
    ...(useSurfacePrompt ? { readText } : {}),
  } as never);
  return { command, configPath, vault, configStore, write, readLine, readText };
}

function mockBotApi(updates: TelegramPairingUpdate[]) {
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/getMe')) {
      return {
        json: async () => ({
          ok: true,
          result: { id: 7, is_bot: true, first_name: 'PairBot', username: 'pair_bot' },
        }),
      };
    }
    if (url.includes('/getUpdates?')) {
      return { json: async () => ({ ok: true, result: updates }) };
    }
    throw new Error('unexpected request');
  }) as unknown as typeof fetch;
}

async function expectConfigAbsent(configPath: string) {
  await expect(fs.stat(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('Telegram pairing candidate safety', () => {
  it('keeps only controlled identity metadata and deduplicates the newest identity', () => {
    const hostile = privateUpdate(1, 101, {
      text: `${TOKEN} <script>alert(1)</script>`,
      title: 'untrusted title',
      username: 'untrusted username',
    });
    const candidates = extractTelegramPairingCandidates([
      hostile,
      privateUpdate(4, 101),
      {
        update_id: 5,
        message: {
          chat: { id: 999, type: 'private' },
          from: { id: 999, is_bot: true },
        },
      },
    ]);

    expect(candidates).toEqual([
      {
        chatId: 101,
        userId: 101,
        chatType: 'private',
        updateId: 4,
        eligible: true,
      },
    ]);
    expect(formatTelegramPairingCandidates(candidates)).not.toContain(TOKEN);
    expect(formatTelegramPairingCandidates(candidates)).not.toContain('script');
    expect(formatTelegramPairingCandidates(candidates)).not.toContain('untrusted');
  });

  it('marks group and mismatched private identities as ineligible', () => {
    const candidates = extractTelegramPairingCandidates([
      groupUpdate(3, -1001, 42),
      {
        update_id: 4,
        message: {
          chat: { id: 77, type: 'private' },
          from: { id: 88, is_bot: false },
        },
      },
    ]);

    expect(candidates).toEqual([
      expect.objectContaining({ chatId: 77, eligible: false, warning: 'ambiguous' }),
      expect.objectContaining({ chatId: -1001, eligible: false, warning: 'group' }),
    ]);
    expect(formatTelegramPairingCandidates(candidates)).toContain('not eligible');
  });

  it('requires an explicit valid index and treats blank input as cancel', () => {
    const candidate = extractTelegramPairingCandidates([privateUpdate(1, 101)])[0];
    if (!candidate) throw new Error('expected a pairing candidate');
    const candidates = [candidate];

    expect(parseTelegramPairingChoice('', candidates)).toEqual({ kind: 'cancel' });
    expect(parseTelegramPairingChoice('cancel', candidates)).toEqual({ kind: 'cancel' });
    expect(parseTelegramPairingChoice('0', candidates)).toEqual({ kind: 'invalid' });
    expect(parseTelegramPairingChoice('2', candidates)).toEqual({ kind: 'invalid' });
    expect(parseTelegramPairingChoice('1', candidates)).toEqual({
      kind: 'selected',
      candidate,
    });
  });

  it('uses a bounded internal Bot API request without changing allowed update subscriptions', async () => {
    mockBotApi([]);
    await discoverTelegramPairingCandidates(TOKEN);

    const requestUrl = String(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]);
    expect(requestUrl).toContain(`/bot${TOKEN}/getUpdates?`);
    expect(requestUrl).toContain('limit=25');
    expect(requestUrl).toContain('timeout=0');
    expect(requestUrl).not.toContain('allowed_updates');
  });
});

describe('/telegram-setup safe discovery pairing', () => {
  it('keeps credential-bearing Bot API URLs out of help output', async () => {
    const { command } = await setupRig('');

    const result = await command.run('help');

    expect(result?.message).not.toContain(TOKEN);
    expect(result?.message).not.toContain('<TOKEN>');
    expect(result?.message).not.toContain('api.telegram.org/bot');
  });

  it('pairs an explicitly selected private identity without rendering token or message content', async () => {
    mockBotApi([
      privateUpdate(4, 101, { text: `${TOKEN} hostile body`, username: 'hostile-name' }),
    ]);
    const { command, configPath, vault, write, readLine } = await setupRig('1');
    const flushHardening = vi.spyOn(vault, 'flushHardening');

    const result = await command.run('');

    expect(flushHardening).toHaveBeenCalledOnce();
    expect(readLine).toHaveBeenCalledWith('Pair candidate › ');
    const terminalText = `${write.mock.calls.flat().join('\n')}\n${result?.message ?? ''}`;
    expect(terminalText).toContain('chat_id=101 user_id=101');
    expect(terminalText).not.toContain(TOKEN);
    expect(terminalText).not.toContain('hostile body');
    expect(terminalText).not.toContain('hostile-name');
    expect(terminalText).not.toContain('api.telegram.org/bot');

    const raw = await fs.readFile(configPath, 'utf8');
    expect(raw).not.toContain(TOKEN);
    const decrypted = decryptConfigSecrets(JSON.parse(raw), vault) as {
      extensions: {
        telegram: {
          botToken: string;
          notifyChatId: number;
          inboundMode: string;
          allowedUsers: number[];
          allowedChats: number[];
        };
      };
    };
    expect(decrypted.extensions.telegram).toMatchObject({
      botToken: TOKEN,
      notifyChatId: 101,
      inboundMode: 'paired',
      allowedUsers: [101],
      allowedChats: [101],
    });
  });

  it('uses the surface text prompt instead of readline when the TUI bridge is available', async () => {
    mockBotApi([privateUpdate(4, 101)]);
    const { command, readLine, readText } = await setupRig('1', true);

    const result = await command.run('');

    expect(readText).toHaveBeenCalledWith('Pair candidate › ');
    expect(readLine).not.toHaveBeenCalled();
    expect(result?.message).toContain('Paired private chat');
  });

  it('cancels without changing config', async () => {
    mockBotApi([privateUpdate(1, 101)]);
    const { command, configPath, configStore } = await setupRig('');
    const originalConfig = '{\n  "preserved": true\n}\n';
    await fs.writeFile(configPath, originalConfig, 'utf8');

    const result = await command.run('');

    expect(result?.message).toContain('cancelled');
    expect(configStore.update).not.toHaveBeenCalled();
    expect(await fs.readFile(configPath, 'utf8')).toBe(originalConfig);
  });

  it('warns and refuses a selected group target without changing config', async () => {
    mockBotApi([groupUpdate(1, -1001, 42)]);
    const { command, configPath, configStore, write } = await setupRig('1');

    const result = await command.run('');

    expect(write.mock.calls.flat().join('\n')).toContain('shared/group target');
    expect(result?.message).toContain('not paired automatically');
    expect(result?.message).not.toContain(TOKEN);
    expect(configStore.update).not.toHaveBeenCalled();
    await expectConfigAbsent(configPath);
  });

  it('leaves config unchanged when discovery is empty or fails', async () => {
    mockBotApi([]);
    const empty = await setupRig('1');
    expect((await empty.command.run(''))?.message).toContain('No recent chats found');
    await expectConfigAbsent(empty.configPath);

    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/getMe')) {
        return {
          json: async () => ({
            ok: true,
            result: { id: 7, is_bot: true, first_name: 'PairBot' },
          }),
        };
      }
      throw new Error(`failure containing ${TOKEN}`);
    }) as unknown as typeof fetch;
    const failed = await setupRig('1');
    const result = await failed.command.run('');
    expect(result?.message).toContain('Could not discover');
    expect(result?.message).not.toContain(TOKEN);
    await expectConfigAbsent(failed.configPath);
  });
});
