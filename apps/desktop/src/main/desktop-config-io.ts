/**
 * Desktop-shell read/write of the shared display language (`Config.uiLocale`).
 *
 * The desktop main process can't use the WebUI's localStorage-backed i18n, and
 * it isn't a WS client, so it resolves the active profile from the root
 * bootstrap and reads/writes that profile's `config.json` —
 * using the SAME read → decrypt → mutate → encrypt → atomicWrite cycle as the
 * WebUI server (`pref-helpers.updateGlobalConfig`) so encrypted secrets in the
 * file are preserved byte-for-byte.
 *
 * The standalone WebUI's `watchProviderConfig` (now surfacing `uiLocale`) lets
 * a running shell follow a language change written by any other process.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  decryptConfigSecrets,
  DefaultSecretVault,
  encryptConfigSecrets,
} from '@wrongstack/core/security';
import type { SecretVault } from '@wrongstack/core/types';
import { atomicWrite, wstackGlobalRoot } from '@wrongstack/core/utils';

const globalRoot = wstackGlobalRoot();
const bootstrapConfigPath = path.join(globalRoot, 'config.json');
const defaultProfileConfigPath = path.join(globalRoot, 'profiles', 'default', 'config.json');
const vault: SecretVault = new DefaultSecretVault({
  keyFile: path.join(globalRoot, '.key'),
});

function safeProfileName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'default';
  return value.replace(/[/\\:]/g, '_').replace(/\.\./g, '_') || 'default';
}

/** Resolve the current profile from the thin root bootstrap. */
export async function resolveActiveProfileConfigPath(): Promise<string> {
  try {
    const raw = await fs.readFile(bootstrapConfigPath, 'utf8');
    const parsed = JSON.parse(raw) as { activeProfile?: unknown };
    return path.join(globalRoot, 'profiles', safeProfileName(parsed.activeProfile), 'config.json');
  } catch {
    return defaultProfileConfigPath;
  }
}

/** Read the persisted display language, or undefined when unset/unreadable. */
export async function readUiLocale(): Promise<string | undefined> {
  const profileConfigPath = await resolveActiveProfileConfigPath();
  let raw: string;
  try {
    raw = await fs.readFile(profileConfigPath, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const decrypted = decryptConfigSecrets(JSON.parse(raw) as Record<string, unknown>, vault) as {
      uiLocale?: string;
    };
    const value = decrypted.uiLocale;
    return typeof value === 'string' && value ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Stable paths + vault exposed for the desktop boot watcher and tests. */
export const desktopConfigPaths = {
  bootstrapConfigPath,
  profileConfigPath: defaultProfileConfigPath,
  vault,
} as const;

/**
 * Persist a display-language change. Refuses to overwrite a corrupt config
 * (the operator should fix it). Best-effort: never throws to the caller.
 */
export async function writeUiLocale(code: string): Promise<void> {
  const profileConfigPath = await resolveActiveProfileConfigPath();
  let raw: string;
  try {
    raw = await fs.readFile(profileConfigPath, 'utf8');
  } catch {
    raw = '{}';
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return; // corrupt config — don't clobber
  }
  const decrypted = decryptConfigSecrets(parsed, vault) as Record<string, unknown>;
  decrypted.uiLocale = code;
  const encrypted = encryptConfigSecrets(decrypted, vault);
  await fs.mkdir(path.dirname(profileConfigPath), { recursive: true });
  await atomicWrite(profileConfigPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
}
