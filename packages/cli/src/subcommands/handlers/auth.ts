import { color } from '@wrongstack/core/utils';
import { parseAuthFlags } from '../../arg-parser.js';
import {
  type AuthMenuDeps,
  resolveOAuthKind,
  runAuthDirect,
  runAuthLocal,
  runAuthMenu,
  runOAuthLoginKind,
} from '../../auth-menu/index.js';
import { activeProfileConfigPath } from '../../profile-config-path.js';
import {
  loadConfigProviders,
  maskedKey,
  mutateConfigProviders,
  normalizeKeys,
} from '../../provider-config-utils.js';
import type { SubcommandHandler } from '../contracts.js';
import { restoreFlags } from '../flags.js';
import { renderAuthLocalHelpToString, wantsLocalHelp } from './auth-local-help.js';

export const authCmd: SubcommandHandler = async (args, deps) => {
  // `parseArgs` strips these before the dispatcher calls us — see restoreFlags.
  // Without them `auth my-proxy --family openai-compatible --base-url ...`
  // exited 1 with "Pass --family ..." — naming the flag just passed.
  args = restoreFlags(args, deps, [
    'label',
    'family',
    'base-url',
    'env',
    // `auth local` flags — see the `local` branch below.
    'name',
    'no-key',
    'skip-key',
    'no-probe',
    'skip-probe',
    'probe-only',
    'model',
    'm',
    'help',
    'h',
  ]);
  const flags = parseAuthFlags(args);
  const profileConfigPath = activeProfileConfigPath(deps.paths, deps.config);
  const menuDeps: AuthMenuDeps = {
    renderer: deps.renderer,
    reader: deps.reader,
    modelsRegistry: deps.modelsRegistry,
    vault: deps.vault,
    profileConfigPath,
  };

  // No args → interactive menu
  if (flags.positional.length === 0) {
    return runAuthMenu(menuDeps);
  }

  const first = flags.positional[0]!;

  // `wstack auth list` / `wstack auth ls` — quick listing
  if (first === 'list' || first === 'ls') {
    return runAuthList(menuDeps);
  }

  // `wstack auth local` — quick-add Ollama / vLLM / LM Studio.
  //
  // There was NO dispatch branch for this at all: `auth local` fell through to
  // `runAuthDirect({providerId: 'local'})` and exited 1 with
  // `Provider "local" not in catalog`, and `auth local --help` printed the same
  // error instead of the help block that `wstack --help` advertises and
  // `init.ts` recommends. `runAuthLocal` was reachable only from the
  // interactive menu and the WebUI panel service, so every documented
  // `LOCAL_AUTH_FLAGS` switch was unreachable from the CLI.
  if (first === 'local') {
    if (wantsLocalHelp(args)) {
      deps.renderer.write(`${renderAuthLocalHelpToString()}\n`);
      return 0;
    }
    const value = (name: string): string | undefined => {
      const i = args.indexOf(`--${name}`);
      return i >= 0 ? args[i + 1] : undefined;
    };
    const has = (...names: string[]): boolean => names.some((n) => args.includes(`--${n}`));
    const modelIdx = args.indexOf('--model') >= 0 ? args.indexOf('--model') : args.indexOf('-m');
    return runAuthLocal(menuDeps, {
      name: flags.positional[1] ?? value('name'),
      baseUrl: flags.baseUrl ?? value('base-url'),
      label: flags.label,
      skipKey: has('no-key', 'skip-key'),
      noProbe: has('no-probe', 'skip-probe'),
      probeOnly: has('probe-only'),
      // Bare `--model` (no value, or followed by another flag) clears the
      // allowlist, which is why an empty string is meaningful here.
      ...(modelIdx >= 0
        ? { models: args[modelIdx + 1]?.startsWith('-') ? '' : (args[modelIdx + 1] ?? '') }
        : {}),
    });
  }

  // `wstack auth status <provider>` — detailed view
  if (first === 'status') {
    const pid = flags.positional[1];
    if (!pid) {
      deps.renderer.writeError('Usage: wstack auth status <provider>');
      return 1;
    }
    return runAuthStatus(menuDeps, pid);
  }

  // `wstack auth remove <provider>` / `wstack auth rm <provider>` — quick delete
  if (first === 'remove' || first === 'rm') {
    const pid = flags.positional[1];
    if (!pid) {
      deps.renderer.writeError('Usage: wstack auth remove <provider> [--force]');
      return 1;
    }
    return runAuthRemove(menuDeps, pid);
  }

  // `wstack auth login <chatgpt|claude>` — subscription OAuth login.
  //   chatgpt/openai/codex → "Sign in with ChatGPT"  (provider openai-codex)
  //   claude/anthropic     → "Sign in with Claude"   (provider anthropic-oauth)
  // Both store under a canonical provider id so they never clobber a separately
  // configured API-key `openai`/`anthropic` provider.
  if (first === 'login') {
    const pid = (flags.positional[1] ?? '').toLowerCase();
    // Bare `wstack auth login` keeps its historical default: ChatGPT.
    if (!pid) return runOAuthLoginKind(menuDeps, 'chatgpt');
    // Numeric picks are a menu affordance, not a CLI one — `auth login 2`
    // is a typo, not a request to sign into Claude.
    const kind = resolveOAuthKind(pid, { allowNumeric: false });
    if (kind) return runOAuthLoginKind(menuDeps, kind);
    deps.renderer.writeError(
      'OAuth login is only supported for ChatGPT, Claude, and GitHub Copilot.',
    );
    deps.renderer.write(
      color.dim('  Sign in with ChatGPT: ') +
        color.bold('wstack auth login chatgpt') +
        '\n' +
        color.dim('  Sign in with Claude:  ') +
        color.bold('wstack auth login claude') +
        '\n' +
        color.dim('  Sign in with Copilot: ') +
        color.bold('wstack auth login copilot') +
        '\n' +
        color.dim('  For an API key instead: ') +
        color.bold(`wstack auth ${pid}`) +
        '\n',
    );
    return 1;
  }

  // `wstack auth <provider>` — direct add
  return runAuthDirect(menuDeps, {
    providerId: first,
    label: flags.label,
    family: flags.family,
    baseUrl: flags.baseUrl,
    envVars: flags.envVars,
  });
};

/** Quick read-only listing of all saved providers and their keys. */
async function runAuthList(deps: AuthMenuDeps): Promise<number> {
  let providers: Record<string, unknown>;
  try {
    providers = await loadConfigProviders(deps.profileConfigPath, deps.vault);
  } catch (err) {
    deps.renderer.writeError(`Could not read config: ${(err as Error).message}`);
    return 1;
  }

  const ids = Object.keys(providers).sort();

  if (ids.length === 0) {
    deps.renderer.write(
      `${color.dim('No providers configured.')}\n` +
        `${color.dim('Run')} ${color.bold('wstack auth')} ${color.dim('to add one.')}\n`,
    );
    return 0;
  }

  deps.renderer.write(`\n${color.bold('Saved providers')} ${color.dim(`(${ids.length})`)}\n\n`);

  for (const id of ids) {
    const cfg = providers[id] as
      | {
          type?: string;
          family?: string;
          baseUrl?: string;
          activeKey?: string;
          apiKeys?: { label: string; apiKey: string; createdAt: string }[];
          apiKey?: string;
          models?: string[];
        }
      | undefined;
    if (!cfg) continue;

    const keys = normalizeKeys(cfg as Parameters<typeof normalizeKeys>[0]);
    const active = cfg.activeKey ?? keys[0]?.label;
    const famTag = cfg.family ? `${cfg.family}` : color.amber('no-family');
    const aliasHint = cfg.type && cfg.type !== id ? color.dim(` (→ ${cfg.type})`) : '';
    const modelHint =
      cfg.models && cfg.models.length > 0 ? color.dim(` [${cfg.models.length} models]`) : '';

    deps.renderer.write(`  ${color.bold(id)}${aliasHint}\n`);
    deps.renderer.write(
      `    family:  ${famTag}  baseUrl: ${cfg.baseUrl ?? color.dim('unset')}${modelHint}\n`,
    );

    if (keys.length === 0) {
      deps.renderer.write(`    ${color.amber('no keys')}\n`);
    } else {
      deps.renderer.write(
        `    ${color.dim(`${keys.length} key${keys.length === 1 ? '' : 's'}:`)}\n`,
      );
      for (const k of keys) {
        const marker = k.label === active ? color.green('●') : color.dim('○');
        deps.renderer.write(
          `      ${marker} ${k.label.padEnd(18)} ${maskedKey(k.apiKey)}  ${color.dim(k.createdAt)}\n`,
        );
      }
    }
    deps.renderer.write('\n');
  }

  deps.renderer.write(color.dim(`Manage: wstack auth   Add key: wstack auth <provider>\n`));
  return 0;
}

/** Detailed view of a single provider. */
async function runAuthStatus(deps: AuthMenuDeps, providerId: string): Promise<number> {
  let providers: Record<string, unknown>;
  try {
    providers = await loadConfigProviders(deps.profileConfigPath, deps.vault);
  } catch (err) {
    deps.renderer.writeError(`Could not read config: ${(err as Error).message}`);
    return 1;
  }

  const cfg = providers[providerId] as
    | {
        type?: string;
        family?: string;
        baseUrl?: string;
        activeKey?: string;
        envVars?: string[];
        models?: string[];
        apiKeys?: { label: string; apiKey: string; createdAt: string }[];
        apiKey?: string;
      }
    | undefined;

  if (!cfg) {
    deps.renderer.writeError(`Provider "${providerId}" not found in config.`);
    deps.renderer.write(
      color.dim(`Run ${color.bold('wstack auth list')} to see saved providers.\n`),
    );
    return 1;
  }

  const keys = normalizeKeys(cfg as Parameters<typeof normalizeKeys>[0]);
  const active = cfg.activeKey ?? keys[0]?.label;

  const lines: string[] = [
    `\n${color.bold(providerId)} ${cfg.family ? color.dim(`[${cfg.family}]`) : color.amber('[no family]')}`,
    '',
    `  type:    ${color.cyan(cfg.type ?? providerId)}`,
    `  family:  ${cfg.family ? color.cyan(cfg.family) : color.dim('unset')}`,
    `  baseUrl: ${cfg.baseUrl ? color.cyan(cfg.baseUrl) : color.dim('unset')}`,
  ];

  if (cfg.models?.length) {
    lines.push(`  models:  ${color.cyan(cfg.models.join(', '))}`);
  }
  if (cfg.envVars?.length) {
    lines.push(`  envVars: ${color.cyan(cfg.envVars.join(', '))}`);
  }
  lines.push('');

  if (keys.length === 0) {
    lines.push(color.amber('  (no keys saved)'));
  } else {
    lines.push(`  ${color.dim('Keys:')}`);
    for (const k of keys) {
      const marker = k.label === active ? color.green('●') : color.dim('○');
      lines.push(
        `    ${marker} ${color.bold(k.label.padEnd(18))} ${maskedKey(k.apiKey)}  ${color.dim(k.createdAt)}`,
      );
    }
  }

  lines.push('');
  lines.push(color.dim(`Manage: wstack auth → pick ${providerId}`));
  deps.renderer.write(lines.join('\n') + '\n');
  return 0;
}

/** Quick removal of a provider without the interactive menu. */
async function runAuthRemove(deps: AuthMenuDeps, providerId: string): Promise<number> {
  const providers = await loadConfigProviders(deps.profileConfigPath, deps.vault);
  if (!providers[providerId]) {
    deps.renderer.writeError(`Provider "${providerId}" not found.`);
    return 1;
  }

  // Confirm before deleting unless --force
  deps.renderer.write(
    `${color.amber('!')} This will remove "${providerId}" and all its saved keys.\n`,
  );
  const answer = (
    await deps.reader.readLine(`  ${color.amber('?')} Confirm removal? ${color.dim('[y/N]')} `)
  )
    .trim()
    .toLowerCase();

  if (answer !== 'y' && answer !== 'yes') {
    deps.renderer.write(color.dim('Cancelled.\n'));
    return 0;
  }

  try {
    await mutateConfigProviders(deps.profileConfigPath, deps.vault, (all) => {
      delete all[providerId];
    });
    deps.renderer.write(`  ${color.green('✓')} Removed ${color.bold(providerId)}.\n`);
    return 0;
  } catch (err) {
    deps.renderer.writeError(`Failed to remove: ${(err as Error).message}`);
    return 1;
  }
}
