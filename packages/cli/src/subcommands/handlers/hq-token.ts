import {
  type HqToken,
  logHqAuthAudit,
  mintHqToken,
  mutateHqAuthFile,
  readHqAuthFile,
} from '@wrongstack/hq';
import { expectDefined } from '@wrongstack/core/utils';
import { resolveAuditActor } from '../../hq-server/audit-actor.js';
import { parseTokenTtlValue as parseTtlValue } from '../../utils/hq-ttl.js';
import type { SubcommandDeps } from '../contracts.js';
import { computeAuditHashField } from './hq-audit.js';
import { resolveDataDir } from './hq-data-dir.js';

export async function hqTokenCmd(args: string[], deps: SubcommandDeps): Promise<number> {
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
 * Token scope: `browser` (validated on `/ws/browser`) or `client`
 * (validated on `/ws/client`). Defaults to `browser` for backward
 * compatibility with Phase 3.
 */
type TokenScope = 'browser' | 'client';

const TOKEN_CAPABILITIES: Record<TokenScope, readonly string[]> = {
  // `control.approve` is grantable but never default — see
  // DEFAULT_TOKEN_CAPABILITIES below. `control.approve.once` is the narrower
  // grant: yes/no on a single prompt, no persistent `always`/`deny` policy.
  browser: ['control.enqueue', 'control.approve', 'control.approve.once'],
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
    // WS-2026-09-15-01: `/ws/client` is only open when HQ holds no credential of
    // any kind. With a password or a browser token, zero client tokens means
    // every publisher is REJECTED — reporting OPEN MODE there was both wrong and
    // the reason nobody noticed the channel used to stay open.
    const browserCredential =
      authFile.passwordHash !== undefined || (authFile.browserTokens ?? []).length > 0;
    if (scope === 'client' && browserCredential) {
      deps.renderer.write(
        'No client tokens issued. HQ has a browser credential, so /ws/client REJECTS every publisher.\n',
      );
      deps.renderer.write(
        'Run `wstack hq token create --client [label]` to let publishers connect.\n',
      );
      return 0;
    }
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
  let ambiguous: HqToken[] = [];
  try {
    await mutateHqAuthFile(
      dataDir,
      (current) => {
        const tokens = current[tokenField] ?? [];
        // Prefix match: revoke the first token whose id starts with the
        // supplied prefix. The full id is long; users usually paste the
        // first 8 chars.
        const matches = tokens.filter((t) => t.id.startsWith(idPrefix));
        ambiguous = [];
        if (matches.length === 0) {
          revoked = undefined;
          return current;
        }
        if (matches.length > 1) {
          // Revoke nothing: the prefix does not say which token to revoke.
          revoked = undefined;
          ambiguous = matches;
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

  if (ambiguous.length > 0) {
    deps.renderer.writeError(
      `Id-prefix "${idPrefix}" matches ${ambiguous.length} ${scope} tokens (${ambiguous.map((t) => t.id).join(', ')}); nothing revoked. Use a longer prefix.\n`,
    );
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
    `  --capabilities <csv>  Comma-separated capability grants (browser: control.enqueue,control.approve; client: telemetry.publish,control.execute).\n`,
  );
  deps.renderer.write(
    `  --ttl <duration>    Stamp an expiresAt on the token (e.g. --ttl 1h, --ttl 7d, --ttl 3600s).\n`,
  );
  deps.renderer.write('\n');
  deps.renderer.write(`Run \`wstack hq --help\` for the full HQ command list.\n`);
}
