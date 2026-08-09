import type { SlashCommand } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import { activeProfileConfigPath } from '../profile-config-path.js';
import { loadConfigProviders } from '../provider-config-utils.js';
import type { SlashCommandContext } from './command-context.js';

/** Levenshtein distance, capped iteration for short provider ids. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? 0;
}

/**
 * Suggest provider ids close to a mistyped query: substring overlap in either
 * direction, or a small edit distance. Returns up to 3, best first.
 */
function closeMatches(query: string, ids: string[]): string[] {
  const q = query.toLowerCase();
  return ids
    .map((id) => {
      const lower = id.toLowerCase();
      const contains = lower.includes(q) || q.includes(lower);
      const dist = editDistance(q, lower);
      return { id, score: contains ? 0 : dist };
    })
    .filter((c) => c.score <= 2)
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)
    .map((c) => c.id);
}

/**
 * `/auth` — manage provider credentials.
 *
 * In the TUI, a bare `/auth` opens the interactive auth panel (providers,
 * key CRUD, catalog/local/custom adds, OAuth sign-in) via the panel-open
 * bridge — the same UX as `wstack auth`, embedded in the session. `/auth
 * login` jumps straight to the OAuth sign-in view.
 *
 * In the plain REPL (no TUI mounted) the command falls back to a
 * read-only dashboard and points at `wstack auth`:
 *   /auth                  Show saved providers and key status
 *   /auth login            Open OAuth sign-in (TUI) / show hint (REPL)
 *   /auth status <id>      Show detail for one provider
 *   /auth open             Open the panel (TUI) / show launch hint (REPL)
 *   /auth help             Show this help
 */
export function buildAuthCommand(opts: SlashCommandContext): SlashCommand {
  const help = [
    'Usage:',
    '  /auth                      Open the interactive key manager (TUI) or show key status',
    '  /auth login                Sign in with OAuth (ChatGPT / Claude / Copilot)',
    '  /auth status <provider>    Show detail for one provider',
    '  /auth open                 Open the interactive key manager',
    '',
    'In the plain REPL, run `wstack auth` for the full interactive key manager.',
  ].join('\n');

  return {
    name: 'auth',
    category: 'Config',
    description: 'Manage API keys & OAuth sign-in: /auth [login|status <id>]',
    help,
    async run(args) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? '').toLowerCase();

      if (sub === 'help' || sub === '--help') {
        return { message: this.help ?? '' };
      }

      if (!opts.paths?.globalConfig) {
        return { message: `${color.red('Error')} auth not available — config path missing.` };
      }

      // Bare /auth (or /auth open) → open the interactive TUI panel when the
      // bridge is live; fall through to the text views in the plain REPL.
      if ((sub === '' || sub === 'open' || sub === 'menu') && opts.onPanelOpen?.current) {
        if (opts.onPanelOpen.current('authOpen')) {
          return { message: 'Opened the auth panel.' };
        }
      }

      // /auth login|oauth|signin → jump straight to the OAuth view.
      if (sub === 'login' || sub === 'oauth' || sub === 'signin') {
        if (opts.onPanelOpen?.current?.('authOauthOpen')) {
          return { message: 'Opened OAuth sign-in.' };
        }
        return {
          message: [
            `${color.bold('OAuth sign-in')}`,
            '',
            `  Run ${color.cyan('wstack auth login chatgpt')} — ChatGPT Plus/Pro (→ openai-codex)`,
            `  Run ${color.cyan('wstack auth login claude')}  — Claude Pro/Max (→ anthropic-oauth)`,
            `  Run ${color.cyan('wstack auth login copilot')} — GitHub Copilot (→ github-copilot)`,
          ].join('\n'),
        };
      }

      if (sub === 'open' || sub === 'menu') {
        return {
          message: [
            `${color.bold('API Key Manager')}`,
            '',
            `  Run ${color.bold('wstack auth')} in a separate terminal to manage API keys interactively:`,
            '',
            `    ${color.cyan('wstack auth')}                 Interactive menu`,
            `    ${color.cyan('wstack auth <provider>')}      Add a key for <provider>`,
            `    ${color.cyan('wstack auth <p> --label <l>')}  Add with custom label`,
            '',
            color.dim('  (In the TUI, /auth opens the same manager as an interactive panel.)'),
          ].join('\n'),
        };
      }

      // Load providers — use a no-op vault fallback since config may not have secrets.
      let providers: Record<string, unknown>;
      try {
        providers = await loadConfigProviders(
          activeProfileConfigPath(opts.paths, opts.configStore.get()),
          // We don't have a full vault reference in slash commands;
          // use a simple passthrough vault since keys won't decrypt anyway
          // in this read-only view and the config may not have encrypted fields.
          {
            encrypt: (v: string) => v,
            decrypt: (v: string) => v,
            isEncrypted: () => false,
            keyVersion: 1,
          },
        );
      } catch {
        return { message: `${color.red('Error')} could not read config file.` };
      }

      // ── /auth status <provider> ──
      if (sub === 'status') {
        const pid = parts[1];
        if (!pid) {
          return { message: `${color.amber('Usage:')} /auth status <provider>` };
        }
        const cfg = providers[pid] as
          | {
              type?: string;
              family?: string;
              baseUrl?: string;
              models?: string[];
              envVars?: string[];
              apiKeys?: { label: string; createdAt: string }[];
            }
          | undefined;
        if (!cfg) {
          const suggestions = closeMatches(pid, Object.keys(providers));
          const hint =
            suggestions.length > 0
              ? ` Did you mean ${suggestions.map((s) => color.cyan(s)).join(', ')}?`
              : ` Run ${color.dim('/auth')} to see configured providers.`;
          return {
            message: `${color.yellow('Provider')} "${pid}" not found in saved config.${hint}`,
          };
        }
        const keys = cfg.apiKeys ?? [];
        const active =
          keys.find((k) => cfg && (cfg as { activeKey?: string }).activeKey === k.label) ?? keys[0];

        const lines: string[] = [
          `${color.bold(pid)} ${cfg.family ? color.dim(`[${cfg.family}]`) : color.amber('[no family]')}`,
          '',
          `  type:    ${color.cyan(cfg.type ?? pid)}`,
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
          lines.push(color.dim('  (no keys saved)'));
        } else {
          lines.push(`  ${color.dim('Keys:')}`);
          for (const k of keys) {
            const marker = k.label === active?.label ? color.green('●') : color.dim('○');
            const masked =
              k.label === active?.label ? color.dim('(active — masked)') : color.dim('(masked)');
            lines.push(
              `    ${marker} ${color.bold(k.label.padEnd(18))} ${masked}  ${color.dim(k.createdAt)}`,
            );
          }
        }

        lines.push('', color.dim(`  Manage: wstack auth → pick ${pid}`));
        return { message: lines.join('\n') };
      }

      // ── /auth (no args) — list all providers ──
      const ids = Object.keys(providers).sort();

      if (ids.length === 0) {
        return {
          message: [
            `${color.bold('API Keys')} ${color.dim('— No providers configured')}`,
            '',
            color.dim('  Run `wstack auth` to add a provider with an API key.'),
            '',
            color.dim('  Quick start:'),
            `    ${color.cyan('wstack auth')}              Interactive menu`,
            `    ${color.cyan('wstack auth anthropic')}    Direct add`,
            '',
            color.dim('  Or /auth help for more commands.'),
          ].join('\n'),
        };
      }

      const lines: string[] = [
        `${color.bold('API Keys')} ${color.dim(`— ${ids.length} provider${ids.length === 1 ? '' : 's'}`)}`,
        '',
      ];

      for (const id of ids) {
        const cfg = providers[id] as
          | { type?: string; family?: string; apiKeys?: { label: string; apiKey?: string }[] }
          | undefined;
        if (!cfg) continue;
        const keys = cfg.apiKeys ?? [];
        const famTag = cfg.family ? color.dim(`[${cfg.family}]`) : '';
        const aliasTag = cfg.type && cfg.type !== id ? color.dim(`→ ${cfg.type}`) : '';

        let status: string;
        if (keys.length === 0) {
          status = color.amber('no keys');
        } else if (keys.length === 1) {
          status = color.green(`1 key`);
        } else {
          status = color.green(`${keys.length} keys`);
        }

        lines.push(`  ${color.bold(id.padEnd(22))} ${famTag} ${aliasTag} ${status}`);
      }

      lines.push('');
      lines.push(color.dim('  /auth status <id>  Detail    /auth open  Full menu'));
      return { message: lines.join('\n') };
    },
  };
}
