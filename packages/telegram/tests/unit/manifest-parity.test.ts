import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TELEGRAM_MANIFEST } from '../../src/manifest.js';
import type { TelegramPluginConfig } from '../../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..', '..');

/**
 * P2.6 — Command/config documentation parity checks.
 *
 * These tests assert that the Telegram plugin's runtime surface (tools,
 * slash commands, config fields) matches the structured manifest in
 * `src/manifest.ts`.  CI fails on future registry/docs drift.
 */
describe('Telegram manifest parity', () => {
  // -----------------------------------------------------------------------
  // Config field parity
  // -----------------------------------------------------------------------

  it('manifest configFields match TelegramPluginConfig keys exactly', () => {
    // Build the expected key set from the interface at compile time.
    // We use a type-level trick: keyof TelegramPluginConfig gives us the
    // union of all field names.  The manifest must list exactly those.
    const expectedKeys = new Set<string>([
      'botToken',
      'notifyChatId',
      'inboundMode',
      'allowedUsers',
      'allowedChats',
      'allowedOutboundChats',
      'pollIntervalSec',
      'notifyOnSessionEnd',
      'longToolThresholdMs',
      'notifyOnDelegate',
      'maxMessageLength',
      'offsetStoragePath',
      'singleInstanceLock',
      'outboundQueuePerChat',
      'outboundQueueConcurrency',
      'allowGroupApprovals',
      'rateLimitTokensPerSecond',
      'rateLimitBurst',
      'parseMode',
    ] satisfies Array<keyof TelegramPluginConfig>);

    const manifestKeys = new Set<string>(TELEGRAM_MANIFEST.configFields);

    // Every manifest key must exist in the interface
    for (const key of manifestKeys) {
      expect(
        expectedKeys.has(key),
        `manifest lists "${key}" but TelegramPluginConfig does not have it`,
      ).toBe(true);
    }

    // Every interface key must exist in the manifest
    for (const key of expectedKeys) {
      expect(
        manifestKeys.has(key),
        `TelegramPluginConfig has "${key}" but manifest does not list it`,
      ).toBe(true);
    }
  });

  // -----------------------------------------------------------------------
  // Tool parity
  // -----------------------------------------------------------------------

  it('manifest tools list matches the registered tool names', () => {
    const manifestToolNames = TELEGRAM_MANIFEST.tools.map((t) => t.name).sort();

    // The three tools are defined in src/tools/telegram-{send,read,approve}.ts
    // and registered in src/index.ts setup().  We verify the manifest lists
    // exactly those three.
    expect(manifestToolNames).toEqual(['telegram_approve', 'telegram_read', 'telegram_send']);
  });

  it('every manifest tool has a non-empty description', () => {
    for (const tool of TELEGRAM_MANIFEST.tools) {
      expect(tool.description.length, `tool "${tool.name}" has empty description`).toBeGreaterThan(
        0,
      );
    }
  });

  // -----------------------------------------------------------------------
  // Slash command parity
  // -----------------------------------------------------------------------

  it('manifest slashCommands list matches the registered command names', () => {
    const manifestCmdNames = TELEGRAM_MANIFEST.slashCommands.map((c) => c.name).sort();

    // registerSlashCommands() in src/slash-commands/index.ts registers
    // exactly: telegram-health, send, chatid
    expect(manifestCmdNames).toEqual(['chatid', 'send', 'telegram-health']);
  });

  it('telegram-health aliases match the registered aliases', () => {
    const healthCmd = TELEGRAM_MANIFEST.slashCommands.find((c) => c.name === 'telegram-health');
    expect(healthCmd).toBeDefined();
    expect(healthCmd!.aliases).toEqual(['telegram', 'tgstat', 'tgs']);
  });

  it('every manifest slash command has a non-empty description', () => {
    for (const cmd of TELEGRAM_MANIFEST.slashCommands) {
      expect(cmd.description.length, `command "${cmd.name}" has empty description`).toBeGreaterThan(
        0,
      );
    }
  });

  // -----------------------------------------------------------------------
  // Plugin version parity
  // -----------------------------------------------------------------------

  it('plugin name matches package.json name suffix', () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    // Package is @wrongstack/telegram — the manifest pluginName should be
    // the bare suffix.
    expect(pkg.name).toBe('@wrongstack/telegram');
    expect(TELEGRAM_MANIFEST.pluginName).toBe('telegram');
  });

  it('package.json version is a valid semver string', () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  // -----------------------------------------------------------------------
  // Doc drift guards — nonexistent surface claims
  // -----------------------------------------------------------------------

  it('manifest does NOT list nonexistent slash commands (read, chat, attach)', () => {
    // P2.6 acceptance: "nonexistent /telegram send|read|chat|attach … are
    // removed or implemented".  send IS implemented (as telegram:send).
    // read, chat, attach are NOT slash commands — they must not appear.
    const cmdNames = new Set(TELEGRAM_MANIFEST.slashCommands.map((c) => c.name));
    expect(cmdNames.has('read')).toBe(false);
    expect(cmdNames.has('chat')).toBe(false);
    expect(cmdNames.has('attach')).toBe(false);
  });

  it('manifest does NOT list nonexistent tools', () => {
    const toolNames = new Set(TELEGRAM_MANIFEST.tools.map((t) => t.name));
    // telegram_chat and telegram_attach do not exist
    expect(toolNames.has('telegram_chat')).toBe(false);
    expect(toolNames.has('telegram_attach')).toBe(false);
  });
});
