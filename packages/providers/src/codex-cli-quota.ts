import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderQuotaSnapshot } from '@wrongstack/core/quota';
import { readChatGPTQuota } from './chatgpt-account-quota.js';
import { extractAccountId } from './openai-codex-account.js';

/** A ChatGPT access token held by the official Codex CLI, used only for quota reads. */
export interface CodexCliQuotaCredential {
  access: string;
  accountId: string | undefined;
}

/** Tokens this close to expiry are skipped: the CLI renews them, never us. */
const EXPIRY_MARGIN_MS = 60_000;

/** `$CODEX_HOME/auth.json`, else `~/.codex/auth.json` — where the Codex CLI keeps its login. */
export function codexCliAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME?.trim();
  return join(home || join(homedir(), '.codex'), 'auth.json');
}

function tokenExpiry(token: string): number | undefined {
  try {
    const exp = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    )?.exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse the Codex CLI's `auth.json`. Only a ChatGPT login with an unexpired
 * access token qualifies. The refresh token is never read: refreshing would
 * rotate it and sign the Codex CLI out.
 */
export function parseCodexCliAuth(
  raw: unknown,
  now: number = Date.now(),
): CodexCliQuotaCredential | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { auth_mode: mode, tokens } = raw as { auth_mode?: unknown; tokens?: unknown };
  if (mode !== undefined && mode !== 'chatgpt') return undefined;
  if (!tokens || typeof tokens !== 'object') return undefined;
  const { access_token: access, account_id: account } = tokens as Record<string, unknown>;
  if (typeof access !== 'string' || access.split('.').length !== 3) return undefined;
  const expiresAt = tokenExpiry(access);
  if (expiresAt === undefined || expiresAt <= now + EXPIRY_MARGIN_MS) return undefined;
  const accountId =
    typeof account === 'string' && account.trim()
      ? account.trim()
      : (extractAccountId(access) ?? undefined);
  return { access, accountId };
}

export async function loadCodexCliQuotaCredential(
  path: string = codexCliAuthPath(),
): Promise<CodexCliQuotaCredential | undefined> {
  try {
    return parseCodexCliAuth(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return undefined;
  }
}

/**
 * Read a direct `openai-chatgpt` account's quota through the Codex CLI login
 * on this machine. The same `chatpass/apps` registration match as a saved
 * `openai-codex` companion applies, so a Codex CLI signed in to a different
 * ChatGPT account yields nothing. A `401` is not retried with a refresh.
 */
export async function readChatGPTQuotaViaCodexCli(
  providerId: string,
  clientId: string,
  credential: CodexCliQuotaCredential,
  opts: { signal?: AbortSignal | undefined; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ProviderQuotaSnapshot[]> {
  const host = {
    baseUrl: '',
    fetchImpl: opts.fetchImpl ?? fetch,
    access: credential.access,
    accountId: credential.accountId,
    ensureFreshToken: async () => {},
    doRefresh: async () => {
      throw new Error('The Codex CLI login is renewed by the Codex CLI only.');
    },
  };
  return readChatGPTQuota.call(host, providerId, clientId, opts);
}
