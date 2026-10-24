/**
 * Pref-persistence helpers for the standalone WebUI server.
 *
 * Phase 1c of the god-module split (issue: God-modules >1500 lines).
 * `startWebUI` previously inlined four interlocking closures:
 *   - `PREF_KEYS` + `prefSnapshot()` — read the live context.meta subset
 *     the settings panel exposes
 *   - `updateGlobalConfig()` — unified read→decrypt→mutate→encrypt→write
 *     against config.json, serialized behind a non-poisoning lock
 *   - `persistPrefsToConfig()` — project a prefs.update payload back into
 *     config.json so a toggle made in the browser survives restarts
 *
 * All four move here. `updateGlobalConfig` returns the new lock so
 * `startWebUI` can keep its mutable `configWriteLock` reference; the other
 * two take explicit args. No behaviour change — the mutation ladder,
 * the FEATURE_MAP, and the touch-flags are preserved verbatim.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SecretVault } from '@wrongstack/contracts/types';
import { decryptConfigSecretsForRewrite, encryptConfigSecrets } from '@wrongstack/core/security';
import { atomicWrite, backupConfigFile, withFileLock } from '@wrongstack/core/utils';
import { errMessage } from './ws-utils.js';

export interface PrefHelperDeps {
  /** Path to the active profile config; the sole settings mutation target. */
  profileConfigPath: string;
  vault: SecretVault;
  logger: { warn(msg: string): void };
}

/** Mutable holder for the serialized-config-write lock. The helpers update
 *  `lock` in place so callers keep a stable reference across writes (the
 *  lock is non-poisoning: a failed write resolves the chain but logs).
 *
 *  We use a holder object rather than returning the new lock because
 *  TypeScript flattens `Promise<Promise<void>>` into `Promise<void>`,
 *  which would make `await helper(...)` yield `void` instead of the new
 *  lock value. */
export interface ConfigWriteLockHolder {
  lock: Promise<void>;
}

export function globalRootForConfigPath(filePath: string): string {
  const configDir = path.dirname(filePath);
  const profilesDir = path.dirname(configDir);
  return path.basename(profilesDir) === 'profiles' ? path.dirname(profilesDir) : configDir;
}

/**
 * Write the mutated config to a single file path. Handles read/decrypt/mutate/encrypt/write.
 */
export async function writeGlobalConfigFile(
  filePath: string,
  vault: SecretVault,
  mutate: (config: Record<string, unknown>) => void,
  errorLabel: string,
): Promise<void> {
  // G6 (RACE-003): the previous read-modify-write cycle held no
  // cross-process lock. The TUI and the WebUI server are normal,
  // concurrently-running writers of `~/.wrongstack/config.json`; a
  // user turning YOLO off in the terminal had it silently reverted
  // milliseconds later by an unrelated `prefs.update` written from
  // the WebUI from a pre-change snapshot — the same window loses
  // `tools.disabledTools`, `hq.token` rotations, and provider
  // credential changes. `withFileLock` is the cross-process
  // serialization primitive S7 hardened (token-checked release
  // prevents the steal-back failure mode).
  await withFileLock(filePath, async () => {
    // Back up the current file before overwriting
    const globalRoot = globalRootForConfigPath(filePath);
    await backupConfigFile(filePath, { globalRoot });
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      // Only a missing file starts empty. A transient read error (EBUSY from an
      // AV scan, EPERM, EIO) used to as well, and the write below replaced every
      // provider and key with the one changed preference.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`${errorLabel}: cannot read config at ${filePath}; not overwriting it`, {
          cause: err,
        });
      }
      raw = '{}';
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`${errorLabel}: refusing to overwrite corrupt config at ${filePath}`, {
        cause: err,
      });
    }
    const decrypted = decryptConfigSecretsForRewrite(parsed, vault) as Record<string, unknown>;
    mutate(decrypted);
    const encrypted = encryptConfigSecrets(decrypted, vault);
    await atomicWrite(filePath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
  });
}

/**
 * Unified global config mutation: read → decrypt → mutate → encrypt → write.
 * All config writes MUST go through this helper so encryption is always
 * preserved and writes are serialized behind the holder's `lock`.
 *
 * Mutates `holder.lock` in place to the new (non-poisoning) chain value.
 */
export async function updateGlobalConfig(
  deps: PrefHelperDeps,
  holder: ConfigWriteLockHolder,
  mutate: (config: Record<string, unknown>) => void,
  errorLabel: string,
): Promise<void> {
  const { profileConfigPath, vault, logger } = deps;
  const write = async (): Promise<void> => {
    await writeGlobalConfigFile(profileConfigPath, vault, mutate, errorLabel);
  };
  const next = holder.lock.then(write);
  holder.lock = next.then(
    () => undefined,
    () => undefined,
  );
  try {
    await next;
  } catch (err) {
    logger.warn(`${errorLabel}: failed to persist to config: ${errMessage(err)}`);
    throw err;
  }
}

/**
 * Apply `payload.tgChatId` to the `extensions.telegram` block, mirroring
 * `/telegram-settings chat <id>` (packages/cli/src/slash-commands/telegram-settings.ts:191-239).
 *
 * Setting the notification chat is not a single-field write in the CLI, and
 * copying only the ID would leave the two surfaces disagreeing about a
 * security-relevant decision. The CLI therefore also:
 *
 *  - refuses a group/supergroup/channel target (negative ID) unless
 *    `allowGroupChats` is explicitly true, because those broadcast to every
 *    member of the chat;
 *  - appends the target to `allowedOutboundChats` (deduped by string form, so a
 *    stored `'12345'` is not duplicated by an incoming `12345`);
 *  - pairs a PRIVATE chat: `inboundMode: 'paired'` + `allowedUsers` +
 *    `allowedChats`. `paired` is what lets the user drive the agent from
 *    Telegram, and `readTelegramConfig` throws if `paired` is set without a
 *    `notifyChatId` (packages/telegram/src/config.ts:257) — so a bare
 *    `notifyChatId` write would leave the config in an invalid, throwing state;
 *  - for a group target, keeps an existing inbound allowlist and otherwise
 *    pins `inboundMode: 'disabled'` so adding a broadcast target never
 *    silently opens the bot to inbound traffic.
 *
 * An empty string clears the target. Clearing must also drop `paired`,
 * otherwise the resulting `inboundMode: 'paired'` with no `notifyChatId` is
 * exactly the throwing state above.
 */
export function applyTelegramChatId(tg: Record<string, unknown>, raw: string): void {
  const normalized = raw.trim();

  if (normalized === '') {
    delete tg['notifyChatId'];
    // `paired` without a notifyChatId throws in readTelegramConfig.
    if (tg['inboundMode'] === 'paired') tg['inboundMode'] = 'disabled';
    return;
  }

  const chatId = Number(normalized);
  const isGroup = chatId < 0;
  if (isGroup && tg['allowGroupChats'] !== true) {
    // Refuse rather than write. The validator has already rejected malformed
    // IDs; this is the group broadcast guard.
    return;
  }

  tg['notifyChatId'] = chatId;

  const existing = Array.isArray(tg['allowedOutboundChats'])
    ? (tg['allowedOutboundChats'] as unknown[]).filter(
        (value): value is string | number => typeof value === 'string' || typeof value === 'number',
      )
    : [];
  if (!existing.map(String).includes(String(chatId))) {
    tg['allowedOutboundChats'] = [...existing, chatId];
  }

  if (isGroup) {
    const hasInboundAllowlist =
      (Array.isArray(tg['allowedUsers']) && tg['allowedUsers'].length > 0) ||
      (Array.isArray(tg['allowedChats']) && tg['allowedChats'].length > 0);
    tg['inboundMode'] = hasInboundAllowlist ? 'allowlist' : 'disabled';
    return;
  }

  tg['inboundMode'] = 'paired';
  tg['allowedUsers'] = [chatId];
  tg['allowedChats'] = [chatId];
}
