/**
 * `wstack hq` subcommand group — HQ command center lifecycle + browser
 * token management.
 *
 * Subcommand tree:
 *   wstack hq                      → start HQ server (alias for `wstack --hq`)
 *   wstack hq serve                → start HQ server (explicit form)
 *   wstack hq token create [label] [--ttl <duration>] → mint a browser token, write auth.json
 *   wstack hq token create --client [label] [--ttl <duration>] → mint a client token (/ws/client)
 *   wstack hq token list           → list issued browser tokens
 *   wstack hq token list --client   → list issued client tokens
 *   wstack hq token revoke <id>    → revoke a browser token (prefix match)
 *   wstack hq token revoke --client <id> → revoke a client token
 *
 * All subcommands accept `--data-dir <path>` to override the HQ data
 * directory (default `~/.wrongstack/hq`, honors `WRONGSTACK_HOME` /
 * `WRONGSTACK_HQ_DATA_DIR`).
 *
 * @module subcommands/handlers/hq
 */

import * as fs from 'node:fs/promises';
import {
  HQ_AUTH_FILE_VERSION,
  HQ_CLI_DEFAULT_HOST,
  HqInsecureExposureError,
  type HqToken,
  hqAuthAuditPath,
  hqAuthContentHash,
  hqAuthFilePath,
  logHqAuthAudit,
  mintHqToken,
  mutateHqAuthFile,
  readHqAuthFile,
  resolveHqDataDir,
} from '@wrongstack/core/hq';
import { expectDefined } from '@wrongstack/core/utils';
import { resolveAuditActor } from '../../hq-server/audit-actor.js';
import type { HqServerHandle } from '../../hq-server/handle-types.js';
import type { SubcommandDeps, SubcommandHandler } from '../contracts.js';

export { resolveAuditActor } from '../../hq-server/audit-actor.js';

/**
 * Build a free-form actor string for the auth audit log. Combines the OS
 * username (best-effort) with the hostname so an operator reviewing the
 * log can see "who minted this token" without parsing environment
 * variables. Never includes the token string.
 *
 * Shared by the `wstack hq token` create/revoke handlers and by
 * `startHqServer`'s first-run bootstrap so every audit entry point
 * produces the same actor shape.
 */
function resolveDataDir(deps: SubcommandDeps): string {
  const override =
    typeof deps.flags?.['data-dir'] === 'string' ? deps.flags['data-dir'] : undefined;
  return resolveHqDataDir(override);
}

export const hqCmd: SubcommandHandler = async (args, deps) => {
  const sub = args[0];

  // `wstack hq --help` / `wstack hq serve --help` → top-level HQ help.
  // For deep subcommands (`token`, `audit`), fall through to their handlers
  // so each level can print its own focused help. The help short-circuit in
  // short-circuit-flags.ts defers here when a known subcommand positional
  // accompanies --help.
  if (deps.flags?.['help'] === true && (!sub || sub === 'serve')) {
    printHelp(deps);
    return 0;
  }

  // `wstack hq` and `wstack hq serve` start the server.
  if (!sub || sub === 'serve') {
    return startServer(deps);
  }

  if (sub === 'token') {
    return hqTokenCmd(args.slice(1), deps);
  }

  if (sub === 'audit') {
    return hqAuditCmd(args.slice(1), deps);
  }

  if (sub === 'help' || sub === '--help') {
    printHelp(deps);
    return 0;
  }

  deps.renderer.writeError(`Unknown hq subcommand: ${sub}\n`);
  printHelp(deps);
  return 1;
};

async function startServer(deps: SubcommandDeps): Promise<number> {
  const { startHqServer } = await import('../../hq-server.js');
  const dataDir = resolveDataDir(deps);
  const flags = deps.flags ?? {};
  const host = typeof flags['host'] === 'string' ? flags['host'] : HQ_CLI_DEFAULT_HOST;
  const port = typeof flags['port'] === 'string' ? Number.parseInt(flags['port'], 10) : 3499;
  const strictPort = flags['strict-port'] === true;
  const open = flags['open'] === true;
  const password =
    typeof flags['password'] === 'string' ? flags['password'] : process.env.WRONGSTACK_HQ_PASSWORD;
  const allowInsecureOpen = flags['insecure-open'] === true;
  const rawTtl = typeof flags['hq-token-ttl'] === 'string' ? flags['hq-token-ttl'] : undefined;
  let tokenTtlMs: number | undefined;
  if (rawTtl !== undefined && rawTtl.length > 0) {
    const parsed = parseTtlValue(rawTtl);
    if (parsed.error) {
      deps.renderer.writeError(`Invalid --hq-token-ttl: ${parsed.error}\n`);
      return 1;
    }
    tokenTtlMs = parsed.value;
  }

  // WS-106: opt-in `X-Forwarded-For` trust for the login backoff. Absent or 0
  // means "ignore the header", which is the correct default for a direct bind
  // and the only safe one for an unknown topology.
  const rawHops =
    typeof flags['hq-trusted-proxy-hops'] === 'string' ? flags['hq-trusted-proxy-hops'] : undefined;
  let trustedProxyHops: number | undefined;
  if (rawHops !== undefined && rawHops.length > 0) {
    const parsed = Number.parseInt(rawHops, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== rawHops.trim()) {
      deps.renderer.writeError(
        '--hq-trusted-proxy-hops must be a non-negative integer (0 = ignore X-Forwarded-For).\n',
      );
      return 1;
    }
    trustedProxyHops = parsed;
  }

  if (password !== undefined && password.length < 8) {
    deps.renderer.writeError('HQ password must be at least 8 characters.\n');
    return 1;
  }

  let handle: HqServerHandle;
  try {
    handle = await startHqServer({
      host,
      port,
      strictPort,
      dataDir,
      allowInsecureOpen,
      ...(password !== undefined ? { password } : {}),
      ...(tokenTtlMs !== undefined ? { tokenTtlMs } : {}),
      ...(trustedProxyHops !== undefined ? { trustedProxyHops } : {}),
    });
  } catch (err) {
    // A refusal is operator-actionable guidance, not a crash — print the
    // remedies rather than a stack trace.
    if (err instanceof HqInsecureExposureError) {
      deps.renderer.writeError(`${err.message}\n`);
      return 1;
    }
    throw err;
  }

  if (open) {
    try {
      const { openBrowser } = await import('@wrongstack/webui-server');
      openBrowser(handle.firstRunSetup?.browserUrl ?? `http://${handle.host}:${handle.port}`);
    } catch {
      // best-effort
    }
  }

  writeStartupInfo(deps, handle);

  // Keep the process alive until SIGINT/SIGTERM
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      try {
        await handle.close();
      } catch (err) {
        deps.renderer.write(`HQ server close error: ${String(err)}\n`);
      }
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
  return 0;
}

function writeStartupInfo(deps: SubcommandDeps, handle: HqServerHandle): void {
  deps.renderer.write(`WrongStack HQ listening on http://${handle.host}:${handle.port}\n`);
  if (!handle.firstRunSetup) {
    deps.renderer.write(`Client endpoint:  ws://${handle.host}:${handle.port}/ws/client\n`);
    deps.renderer.write(`Browser endpoint: http://${handle.host}:${handle.port}\n`);
    return;
  }

  deps.renderer.write(`Browser endpoint: ${handle.firstRunSetup.browserUrl}\n`);
  deps.renderer.write(`Client endpoint:  ${handle.firstRunSetup.clientUrl}\n`);
  deps.renderer.write(
    handle.firstRunSetup.createdAuth
      ? `\nFirst-run HQ auth created in ${handle.firstRunSetup.dataDir}\n`
      : `\nHQ auth loaded from ${handle.firstRunSetup.dataDir}\n`,
  );
  deps.renderer.write(`Start clients with:\n`);
  deps.renderer.write(`  WRONGSTACK_HQ_URL=${handle.firstRunSetup.clientEnv.WRONGSTACK_HQ_URL}\n`);
  if (handle.firstRunSetup.clientEnv.WRONGSTACK_HQ_TOKEN) {
    deps.renderer.write(
      `  WRONGSTACK_HQ_TOKEN=${handle.firstRunSetup.clientEnv.WRONGSTACK_HQ_TOKEN}\n`,
    );
  }
}

async function hqTokenCmd(args: string[], deps: SubcommandDeps): Promise<number> {
  const action = args[0];

  // `wstack hq token --help` / `wstack hq token help` → focused token help.
  if (deps.flags?.['help'] === true || action === 'help' || action === '--help') {
    printTokenHelp(deps);
    return 0;
  }

  if (action === 'create') {
    return tokenCreate(args.slice(1), deps);
  }
  if (action === 'list' || action === 'ls' || !action) {
    return tokenList(args.slice(1), deps);
  }
  if (action === 'revoke' || action === 'rm' || action === 'remove') {
    return tokenRevoke(args.slice(1), deps);
  }

  deps.renderer.writeError(`Unknown hq token subcommand: ${action ?? '(none)'}\n`);
  printTokenHelp(deps);
  return 1;
}

/**
 * `wstack hq audit verify` — re-derive the contentHash from the current
 * on-disk `auth.json` and print it so an operator can compare against a
 * `contentHash` field in an audit entry. This closes the forensic
 * tie-back loop without requiring the operator to write a script: copy
 * the hash from the audit log, run this command, eyeball (or `diff`)
 * the two values.
 *
 * Prints:
 *   - the resolved `auth.json` path (so the operator knows which file
 *     was hashed)
 *   - the SHA-256 contentHash, or `(unavailable)` if the file is
 *     missing/unreadable
 *   - the `auth-audit.jsonl` path (so the operator knows where to look
 *     for entries to compare against)
 *
 * Exit codes:
 *   0 — hash computed and printed
 *   1 — `auth.json` missing or unreadable (hash unavailable); the
 *       audit-log path is still printed so the operator can inspect
 *       historical entries
 */
async function hqAuditCmd(args: string[], deps: SubcommandDeps): Promise<number> {
  const action = args[0];

  // `wstack hq audit --help` / `wstack hq audit help` → focused audit help.
  if (deps.flags?.['help'] === true || action === 'help' || action === '--help') {
    printAuditHelp(deps);
    return 0;
  }

  if (action === 'verify' || action === undefined) {
    return hqAuditVerify(deps);
  }

  deps.renderer.writeError(`Unknown hq audit subcommand: ${action ?? '(none)'}\n`);
  printAuditHelp(deps);
  return 1;
}

async function hqAuditVerify(deps: SubcommandDeps): Promise<number> {
  const dataDir = resolveDataDir(deps);
  const authPath = hqAuthFilePath(dataDir);
  const auditPath = hqAuthAuditPath(dataDir);

  deps.renderer.write(`auth file:   ${authPath}\n`);
  deps.renderer.write(`audit log:   ${auditPath}\n`);

  // readHqAuthFile returns a synthetic default when auth.json is missing
  // (it doesn't throw), so hqAuthContentHash would still produce a hash
  // over that default — which is misleading: no audit entry corresponds
  // to a file that isn't on disk. Check existence directly so the
  // operator gets an honest "unavailable" when there's nothing to hash.
  const fileExists = await fileExistsQuiet(authPath);
  if (!fileExists) {
    deps.renderer.write(`contentHash: (unavailable — auth.json does not exist)\n`);
    deps.renderer.write(
      `Compare historical entries in the audit log above against a known-good hash.\n`,
    );
    return 1;
  }

  const authFile = await readHqAuthFile(dataDir, {
    warn: (msg) => deps.renderer.writeWarning(`${msg}\n`),
  });

  const hash = hqAuthContentHash(authFile);
  if (hash === undefined) {
    deps.renderer.write(`contentHash: (unavailable — auth.json is unreadable or malformed)\n`);
    deps.renderer.write(
      `Compare historical entries in the audit log above against a known-good hash.\n`,
    );
    return 1;
  }

  deps.renderer.write(`contentHash: ${hash}\n`);
  deps.renderer.write('\n');
  deps.renderer.write(
    `Compare this value against the 'contentHash' field of entries in the audit log.\n`,
  );
  deps.renderer.write(
    `A match means the redacted projection of auth.json is identical to when that\n`,
  );
  deps.renderer.write(
    `entry was emitted (secrets may differ — only the non-secret shape is hashed).\n`,
  );
  return 0;
}

async function fileExistsQuiet(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-read the persisted `auth.json` and return a conditional
 * `contentHash` field for embedding in an audit entry. This closes the
 * forensic tie-back loop: an operator reviewing `auth-audit.jsonl` can
 * compare the `contentHash` against the current on-disk file via
 * `wstack hq audit verify`.
 *
 * Re-reads rather than hashing the in-memory post-mutation snapshot
 * because `writeHqAuthFile` re-stamps `updatedAt` on the persisted
 * payload — hashing the in-memory `next` would diverge from what
 * `verify` computes. Matches the pattern established by the `first-run`
 * and `expired-prune` emitters in `auth-store.ts` / `hq-server.ts`.
 *
 * Returns `{}` (no `contentHash` key) when the file is unreadable, so
 * the audit entry still records the event without a tie-back — the
 * absence itself is meaningful. Conditional spread preserves
 * `exactOptionalPropertyTypes`.
 */
async function computeAuditHashField(
  dataDir: string,
  warn: (msg: string) => void,
): Promise<{ contentHash?: string }> {
  const persisted = await readHqAuthFile(dataDir, { warn });
  const hash = hqAuthContentHash(persisted);
  return hash !== undefined ? { contentHash: hash } : {};
}

/**
 * Token scope: `browser` (validated on `/ws/browser`) or `client`
 * (validated on `/ws/client`). Defaults to `browser` for backward
 * compatibility with Phase 3.
 */
type TokenScope = 'browser' | 'client';

const TOKEN_CAPABILITIES: Record<TokenScope, readonly string[]> = {
  browser: ['control.enqueue'],
  client: ['telemetry.publish', 'control.execute'],
};

const DEFAULT_TOKEN_CAPABILITIES: Record<TokenScope, readonly string[]> = {
  browser: ['control.enqueue'],
  client: ['telemetry.publish'],
};

/** Detect `--client` / `-c`, including flags already consumed by parseArgs(). */
function resolveTokenScope(args: string[], deps: SubcommandDeps): TokenScope {
  return deps.flags?.['client'] === true ||
    deps.flags?.['c'] === true ||
    args.some((a) => a === '--client' || a === '-c')
    ? 'client'
    : 'browser';
}

/** Strip token flags and their values from direct-handler args. */
function tokenPositionals(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === '--client' || arg === '-c' || arg.startsWith('--capabilities=')) continue;
    if (arg === '--capabilities') {
      i += 1;
      continue;
    }
    // Skip --ttl and its value (both bare `--ttl 1h` and inline `--ttl=1h`).
    if (arg === '--ttl') {
      i += 1;
      continue;
    }
    if (arg.startsWith('--ttl=')) continue;
    if (!arg.startsWith('-')) result.push(arg);
  }
  return result;
}

function readCapabilitiesFlag(args: string[], deps: SubcommandDeps): string | boolean | undefined {
  const parsed = deps.flags?.['capabilities'];
  if (parsed !== undefined) return parsed;
  const inline = args.find((arg) => arg.startsWith('--capabilities='));
  if (inline) return inline.slice('--capabilities='.length);
  const index = args.indexOf('--capabilities');
  return index >= 0 ? (args[index + 1] ?? true) : undefined;
}

function resolveTokenCapabilities(
  scope: TokenScope,
  args: string[],
  deps: SubcommandDeps,
): { capabilities?: string[]; error?: string } {
  const raw = readCapabilitiesFlag(args, deps);
  if (raw === undefined) return { capabilities: [...DEFAULT_TOKEN_CAPABILITIES[scope]] };
  if (typeof raw !== 'string') {
    return { error: '--capabilities requires a comma-separated value.' };
  }

  const capabilities = [
    ...new Set(
      raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  const allowed = new Set(TOKEN_CAPABILITIES[scope]);
  const invalid = capabilities.filter((capability) => !allowed.has(capability));
  if (invalid.length > 0) {
    return {
      error: `Invalid ${scope} token capabilities: ${invalid.join(', ')}. Allowed: ${[...allowed].join(', ')}.`,
    };
  }
  return { capabilities };
}

async function tokenCreate(args: string[], deps: SubcommandDeps): Promise<number> {
  const scope = resolveTokenScope(args, deps);
  const resolvedCapabilities = resolveTokenCapabilities(scope, args, deps);
  if (resolvedCapabilities.error) {
    deps.renderer.writeError(`${resolvedCapabilities.error}\n`);
    return 1;
  }
  const ttlMs = resolveTokenTtl(args, deps);
  if (ttlMs?.error) {
    deps.renderer.writeError(`${ttlMs.error}\n`);
    return 1;
  }
  const pos = tokenPositionals(args);
  const label = pos[0]; // first positional is the label
  const dataDir = resolveDataDir(deps);
  const tokenField = scope === 'client' ? 'clientTokens' : 'browserTokens';

  try {
    const next = await mutateHqAuthFile(
      dataDir,
      (current) => {
        const tokens = current[tokenField] ?? [];
        const newToken = {
          ...mintHqToken({ label, ttlMs: ttlMs?.value }),
          capabilities: resolvedCapabilities.capabilities,
        };
        return {
          ...current,
          [tokenField]: [...tokens, newToken],
        };
      },
      { warn: (msg) => deps.renderer.writeWarning(`${msg}\n`) },
    );
    const list = next[tokenField] ?? [];
    const token = expectDefined(list[list.length - 1]);
    const hashField = await computeAuditHashField(dataDir, (msg) =>
      deps.renderer.writeWarning(`${msg}\n`),
    );
    logHqAuthAudit(
      dataDir,
      {
        kind: 'create',
        scope,
        tokenId: token.id,
        ...(token.label ? { label: token.label } : {}),
        ...(token.capabilities ? { capabilities: token.capabilities } : {}),
        ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
        actor: resolveAuditActor(),
        ...hashField,
      },
      {
        onError: (err) => deps.renderer.writeWarning(`(audit write failed: ${err.message})\n`),
      },
    );
    const endpoint = scope === 'client' ? '/ws/client' : '/ws/browser';
    deps.renderer.write(`Created ${scope} token.\n`);
    deps.renderer.write(`  id:         ${token.id}\n`);
    if (token.label) deps.renderer.write(`  label:      ${token.label}\n`);
    deps.renderer.write(`  capabilities: ${(token.capabilities ?? []).join(', ') || '(none)'}\n`);
    deps.renderer.write(`  token:      ${token.token}\n`);
    deps.renderer.write(`  createdAt:  ${token.createdAt}\n`);
    if (token.expiresAt) deps.renderer.write(`  expiresAt:  ${token.expiresAt}\n`);
    deps.renderer.write(`\n`);
    deps.renderer.write(`Connect with: ws://localhost:3499${endpoint}?token=${token.token}\n`);
    deps.renderer.write(`(Copy the token now — it will not be shown again in full.)\n`);
    return 0;
  } catch (err) {
    deps.renderer.writeError(`Failed to write auth.json: ${(err as Error).message}\n`);
    return 1;
  }
}

// ── --ttl parsing ──────────────────────────────────────────────────────────
//
// Delegates to the shared `parseTokenTtlValue` from utils/hq-ttl.ts so the
// same syntax (1h, 7d, 3600s, bare ms) is accepted here and in the
// server-startup `--hq-token-ttl` flag.

import { parseTokenTtlValue as parseTtlValue } from '../../utils/hq-ttl.js';

interface ResolvedTtl {
  value?: number | undefined;
  error?: string | undefined;
}

function resolveTokenTtl(args: string[], deps: SubcommandDeps): ResolvedTtl {
  // parseArgs may have already lifted `--ttl <value>` into deps.flags.
  const flagValue = deps.flags?.['ttl'];
  if (typeof flagValue === 'string' && flagValue.length > 0) {
    return parseTtlValue(flagValue);
  }
  // Inline `--ttl=1h`.
  const inline = args.find((a) => a?.startsWith('--ttl='));
  if (inline) {
    return parseTtlValue(inline.slice('--ttl='.length));
  }
  // Bare `--ttl <value>` — scan args manually so we don't depend on parseArgs.
  const idx = args.indexOf('--ttl');
  if (idx >= 0) {
    const raw = args[idx + 1];
    if (raw === undefined || raw.startsWith('-')) {
      return { error: '--ttl requires a value (e.g. --ttl 1h, --ttl 7d, --ttl 3600s)' };
    }
    return parseTtlValue(raw);
  }
  return {};
}

async function tokenList(args: string[], deps: SubcommandDeps): Promise<number> {
  const scope = resolveTokenScope(args, deps);
  const dataDir = resolveDataDir(deps);
  const tokenField = scope === 'client' ? 'clientTokens' : 'browserTokens';
  const authFile = await readHqAuthFile(dataDir, {
    warn: (msg) => deps.renderer.writeWarning(`${msg}\n`),
  });
  const tokens: HqToken[] = authFile[tokenField] ?? [];

  if (tokens.length === 0) {
    deps.renderer.write(
      `No ${scope} tokens issued. ${scope === 'browser' ? 'Browsers' : 'Clients'} are in OPEN MODE.\n`,
    );
    deps.renderer.write(
      `Run \`wstack hq token create ${scope === 'client' ? '--client ' : ''}[label]\` to enter TOKEN MODE.\n`,
    );
    return 0;
  }

  deps.renderer.write(
    `${scope === 'client' ? 'Client' : 'Browser'} tokens (${tokens.length}) — TOKEN MODE:\n`,
  );
  deps.renderer.write('\n');
  for (const t of tokens) {
    const masked = `${t.token.slice(0, 6)}…${t.token.slice(-4)} (${t.token.length} chars)`;
    const capabilities =
      t.capabilities === undefined ? 'legacy-unscoped' : t.capabilities.join(',') || 'none';
    const expires = t.expiresAt ?? '(never)';
    deps.renderer.write(
      `  ${t.id}  ${masked}  ${t.createdAt}  expires ${expires}${t.label ? `  "${t.label}"` : ''}  [${capabilities}]${t.lastUsedAt ? `  lastUsed ${t.lastUsedAt}` : ''}\n`,
    );
  }
  deps.renderer.write('\n');
  deps.renderer.write(
    `${scope === 'client' ? 'Clients' : 'Browsers'} must append ?token=<full-token> to /ws/${scope}.\n`,
  );
  return 0;
}

async function tokenRevoke(args: string[], deps: SubcommandDeps): Promise<number> {
  const scope = resolveTokenScope(args, deps);
  const pos = tokenPositionals(args);
  const idPrefix = pos[0];
  if (!idPrefix) {
    deps.renderer.writeError(
      `Usage: wstack hq token revoke ${scope === 'client' ? '--client ' : ''}<id-prefix>\n`,
    );
    return 1;
  }

  const dataDir = resolveDataDir(deps);
  const tokenField = scope === 'client' ? 'clientTokens' : 'browserTokens';
  let revoked: HqToken | undefined;
  try {
    await mutateHqAuthFile(
      dataDir,
      (current) => {
        const tokens = current[tokenField] ?? [];
        // Prefix match: revoke the first token whose id starts with the
        // supplied prefix. The full id is long; users usually paste the
        // first 8 chars.
        const matches = tokens.filter((t) => t.id.startsWith(idPrefix));
        if (matches.length === 0) {
          revoked = undefined;
          return current;
        }
        if (matches.length > 1) {
          revoked = matches[0]; // caller will surface ambiguity below
          return current;
        }
        revoked = matches[0];
        return {
          ...current,
          [tokenField]: tokens.filter((t) => t.id !== (revoked as HqToken).id),
        };
      },
      { warn: (msg) => deps.renderer.writeWarning(`${msg}\n`) },
    );
  } catch (err) {
    deps.renderer.writeError(`Failed to write auth.json: ${(err as Error).message}\n`);
    return 1;
  }

  if (!revoked) {
    deps.renderer.writeError(`No ${scope} token found matching id-prefix "${idPrefix}".\n`);
    return 1;
  }
  deps.renderer.write(
    `Revoked ${scope} token ${revoked.id}${revoked.label ? ` ("${revoked.label}")` : ''}.\n`,
  );
  const hashField = await computeAuditHashField(dataDir, (msg) =>
    deps.renderer.writeWarning(`${msg}\n`),
  );
  logHqAuthAudit(
    dataDir,
    {
      kind: 'revoke',
      scope,
      tokenId: revoked.id,
      ...(revoked.label ? { label: revoked.label } : {}),
      ...(revoked.capabilities ? { capabilities: revoked.capabilities } : {}),
      actor: resolveAuditActor(),
      ...hashField,
    },
    {
      onError: (err) => deps.renderer.writeWarning(`(audit write failed: ${err.message})\n`),
    },
  );
  return 0;
}

function printHelp(deps: SubcommandDeps): void {
  deps.renderer.write(`Usage: wstack hq <serve | token | audit>\n`);
  deps.renderer.write('\n');
  deps.renderer.write(`  wstack hq                      Start the HQ command center server.\n`);
  deps.renderer.write(`  wstack hq serve                Same as above (explicit form).\n`);
  deps.renderer.write(
    `  wstack hq token create [label] [--ttl <dur>] Mint a browser token, enter token mode.\n`,
  );
  deps.renderer.write(
    `  wstack hq token create --client [label] [--ttl <dur>]  Mint a client token (/ws/client).\n`,
  );
  deps.renderer.write(`  wstack hq token list           List issued browser tokens.\n`);
  deps.renderer.write(`  wstack hq token list --client   List issued client tokens.\n`);
  deps.renderer.write(
    `  wstack hq token revoke <id>    Revoke a browser token (id prefix match).\n`,
  );
  deps.renderer.write(`  wstack hq token revoke --client <id>  Revoke a client token.\n`);
  deps.renderer.write(
    `  wstack hq audit verify         Re-derive auth.json contentHash for forensic comparison.\n`,
  );
  deps.renderer.write('\n');
  deps.renderer.write(`Flags (apply to all subcommands):\n`);
  deps.renderer.write(
    `  --data-dir <path>   Override HQ data directory (default ~/.wrongstack/hq).\n`,
  );
  deps.renderer.write(
    `  --host <ip>         Bind host (default 0.0.0.0; use 127.0.0.1 for local-only).\n`,
  );
  deps.renderer.write(
    `  --tunnel            Publish a temporary *.trycloudflare.com URL (requires cloudflared).\n`,
  );
  deps.renderer.write(`  --password <value>  Set or rotate the browser login password.\n`);
  deps.renderer.write(
    `  --insecure-open     Allow a non-loopback bind with no token/password set.\n`,
  );
  deps.renderer.write(`  --port <n>          Bind port (default 3499).\n`);
  deps.renderer.write(`  --strict-port       Fail if port is in use.\n`);
  deps.renderer.write(
    `  --hq-token-ttl <dur>  Stamp an expiresAt on first-run tokens (e.g. 1h, 7d, 3600s).\n`,
  );
  deps.renderer.write(
    `  --hq-trusted-proxy-hops <n>  Trust the rightmost n X-Forwarded-For entries when rate-limiting logins.\n` +
      `                        Default 0 (ignore the header). Set to the real hop count behind a tunnel,\n` +
      `                        otherwise every user shares one backoff bucket. Never guess high.\n`,
  );
  deps.renderer.write(`  --open              Open the dashboard in the default browser.\n`);
  deps.renderer.write(
    `  --client, -c        Operate on client tokens instead of browser tokens.\n`,
  );
  deps.renderer.write(
    `  --capabilities <csv>  Token grants (browser: control.enqueue; client: telemetry.publish,control.execute).\n`,
  );
  deps.renderer.write(
    `  --ttl <duration>    Stamp an expiresAt on the token (e.g. --ttl 1h, --ttl 7d, --ttl 3600s).\n`,
  );
  deps.renderer.write('\n');
  deps.renderer.write(`auth.json schema version: ${HQ_AUTH_FILE_VERSION}.\n`);
}

/** Focused help for `wstack hq token --help`. */
function printTokenHelp(deps: SubcommandDeps): void {
  deps.renderer.write(`Usage: wstack hq token <create | list | revoke>\n`);
  deps.renderer.write('\n');
  deps.renderer.write(
    `  wstack hq token create [label] [--ttl <dur>]          Mint a browser token (enters token mode).\n`,
  );
  deps.renderer.write(
    `  wstack hq token create --client [label] [--ttl <dur>] Mint a client token (/ws/client).\n`,
  );
  deps.renderer.write(
    `  wstack hq token list                                 List issued browser tokens (alias: ls).\n`,
  );
  deps.renderer.write(
    `  wstack hq token list --client                         List issued client tokens.\n`,
  );
  deps.renderer.write(
    `  wstack hq token revoke <id>                           Revoke a browser token (id prefix match).\n`,
  );
  deps.renderer.write(
    `  wstack hq token revoke --client <id>                  Revoke a client token.\n`,
  );
  deps.renderer.write('\n');
  deps.renderer.write(`The token secret is printed once at create time and cannot be recovered\n`);
  deps.renderer.write(`from auth.json (only its SHA-256 verifier is persisted). Tokens live in\n`);
  deps.renderer.write(`<dataDir>/auth.json (default ~/.wrongstack/hq/auth.json).\n`);
  deps.renderer.write('\n');
  deps.renderer.write(`Flags:\n`);
  deps.renderer.write(
    `  --data-dir <path>   Override HQ data directory (default ~/.wrongstack/hq).\n`,
  );
  deps.renderer.write(
    `  --client, -c        Operate on client tokens instead of browser tokens.\n`,
  );
  deps.renderer.write(
    `  --capabilities <csv>  Comma-separated capability grants (browser: control.enqueue; client: telemetry.publish,control.execute).\n`,
  );
  deps.renderer.write(
    `  --ttl <duration>    Stamp an expiresAt on the token (e.g. --ttl 1h, --ttl 7d, --ttl 3600s).\n`,
  );
  deps.renderer.write('\n');
  deps.renderer.write(`Run \`wstack hq --help\` for the full HQ command list.\n`);
}

/** Focused help for `wstack hq audit --help`. */
function printAuditHelp(deps: SubcommandDeps): void {
  deps.renderer.write(`Usage: wstack hq audit <verify>\n`);
  deps.renderer.write('\n');
  deps.renderer.write(
    `  wstack hq audit verify   Re-derive the SHA-256 contentHash from the current\n`,
  );
  deps.renderer.write(
    `                           auth.json and print it so an operator can compare\n`,
  );
  deps.renderer.write(
    `                           it against a contentHash field in an audit-log entry.\n`,
  );
  deps.renderer.write('\n');
  deps.renderer.write(`Flags:\n`);
  deps.renderer.write(
    `  --data-dir <path>   Override HQ data directory (default ~/.wrongstack/hq).\n`,
  );
  deps.renderer.write('\n');
  deps.renderer.write(`Run \`wstack hq --help\` for the full HQ command list.\n`);
}
