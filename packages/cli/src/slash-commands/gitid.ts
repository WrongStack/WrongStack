import * as fs from 'node:fs/promises';
import { decryptConfigSecrets, encryptConfigSecrets, noOpVault } from '@wrongstack/core/security';
import { ConfigError, type SlashCommand } from '@wrongstack/core/types';
import {
  atomicWrite,
  color,
  configureChildEnvGitIdentity,
  getChildEnvGitIdentity,
  toErrorMessage,
} from '@wrongstack/core/utils';
import { activeProfileConfigPath } from '../profile-config-path.js';
import type { SlashCommandContext } from './command-context.js';

/** Loose email shape check — git itself accepts nearly anything, so only
 * guard against the obvious "forgot the email" argument-order mistake. */
function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(s);
}

/**
 * Read the global config, apply `mutate`, write it back atomically, and
 * return the decrypted object. Mirrors the helper in `fallback.ts` /
 * `setmodel.ts` — pure I/O, safe under both the plain REPL and the Ink TUI.
 */
async function patchGlobalConfig(
  globalConfigPath: string,
  mutate: (cfg: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  let raw = '{}';
  let fileExists = true;
  try {
    raw = await fs.readFile(globalConfigPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    fileExists = false;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if (fileExists)
      throw new ConfigError({
        message: `Config at ${globalConfigPath} is not valid JSON: ${(err as Error).message}`,
        code: 'CONFIG_PARSE_FAILED',
        context: { filePath: globalConfigPath },
        cause: err,
      });
    parsed = {};
  }
  const decrypted = decryptConfigSecrets(parsed, noOpVault) as Record<string, unknown>;
  mutate(decrypted);
  const encrypted = encryptConfigSecrets(decrypted, noOpVault);
  await atomicWrite(globalConfigPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
  return decrypted;
}

/**
 * `/gitid` — view or change the commit identity (author/committer name +
 * email) used by every git command the agent runs. Applied via the
 * `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars on child processes, so the
 * repo's and the user's own `git config` are never modified — commits made
 * outside WrongStack are unaffected.
 *
 * Subcommands:
 *   (none)                      Show the configured identity.
 *   set <name...> <email>       Set identity (email = last argument).
 *                               Add --session to apply without persisting.
 *   clear                       Remove the identity (git config applies
 *                               again). Add --session for this session only.
 *
 * Persisted to the active profile config (user-level). The in-project
 * repo-committed config can NOT set this — identity spoofing must not be
 * repo-controllable.
 */
export function buildGitIdCommand(opts: SlashCommandContext): SlashCommand {
  const help = [
    'Usage:',
    '  /gitid                            Show the commit identity in effect',
    '  /gitid set <name...> <email>      Set commit name + email (email last)',
    '  /gitid set <email>                Set commit email only',
    "  /gitid clear                      Remove — git's own config applies again",
    '',
    'Add --session to set/clear for this session only (no config write).',
    '',
    'The identity is injected as GIT_AUTHOR_*/GIT_COMMITTER_* env vars into',
    'every git process the agent spawns (git tool, bash/exec, worktrees,',
    'plugins). Your git config and terminal commits are never touched.',
    '',
    'Persisted to ~/.wrongstack/profiles/<name>/config.json.',
  ].join('\n');

  function currentView(): string {
    const active = getChildEnvGitIdentity();
    const persisted = opts.configStore.get().git?.identity;
    const lines = [`${color.bold('WrongStack')} ${color.dim('— Commit identity')}`, ''];
    if (active) {
      lines.push(
        `  ${color.bold('name')}   ${active.name ? color.cyan(active.name) : color.dim('(unset — git config applies)')}`,
        `  ${color.bold('email')}  ${active.email ? color.cyan(active.email) : color.dim('(unset — git config applies)')}`,
      );
      const isPersisted = persisted?.name === active.name && persisted?.email === active.email;
      lines.push(
        '',
        `  ${color.dim(isPersisted ? 'persisted in the active profile config' : 'session-only (not persisted)')}`,
      );
    } else {
      lines.push(
        `  ${color.dim('not set — commits use your normal git config (user.name / user.email)')}`,
      );
    }
    lines.push('', color.dim('  /gitid set <name...> <email> · /gitid clear · help'));
    return lines.join('\n');
  }

  return {
    name: 'gitid',
    category: 'Config',
    description: 'View or change the commit author identity used for agent-run git commits.',
    argsHint: '[set <name...> <email> [--session] | clear [--session]]',
    help,
    async run(args) {
      const rawParts = args.trim().split(/\s+/).filter(Boolean);
      const sessionOnly = rawParts.some((p) => p === '--session');
      const parts = rawParts.filter((p) => p !== '--session');
      const sub = (parts[0] ?? '').toLowerCase();

      if (sub === 'help' || sub === '--help') return { message: this.help ?? '' };
      if (!sub) return { message: currentView() };
      if (!opts.paths) {
        return { message: `${color.red('Error')} config paths not available.` };
      }
      const globalConfigPath = activeProfileConfigPath(opts.paths, opts.configStore.get());

      try {
        if (sub === 'set') {
          const rest = parts.slice(1);
          const email = rest[rest.length - 1];
          const name = rest.slice(0, -1).join(' ').trim() || undefined;
          if (!email || !looksLikeEmail(email)) {
            return {
              message:
                `${color.amber('Usage:')} /gitid set <name...> <email> — the email must be the last argument` +
                (email ? ` ("${email}" does not look like an email).` : '.'),
            };
          }
          const identity = { ...(name ? { name } : {}), email };
          configureChildEnvGitIdentity(identity);
          if (!sessionOnly) {
            await patchGlobalConfig(globalConfigPath, (cfg) => {
              const git = { ...((cfg.git as Record<string, unknown>) ?? {}) };
              git.identity = identity;
              cfg.git = git;
            });
            opts.configStore.update({ git: { ...opts.configStore.get().git, identity } });
          }
          return {
            message:
              `${color.green('✓')} agent commits now use ` +
              `${color.cyan(name ?? '(git config name)')} ${color.cyan(`<${email}>`)}` +
              color.dim(sessionOnly ? ' (this session only)' : ' (persisted)'),
          };
        }

        if (sub === 'clear') {
          configureChildEnvGitIdentity(null);
          if (!sessionOnly) {
            await patchGlobalConfig(globalConfigPath, (cfg) => {
              const git = { ...((cfg.git as Record<string, unknown>) ?? {}) };
              delete git.identity;
              if (Object.keys(git).length === 0) delete cfg.git;
              else cfg.git = git;
            });
            const nextGit = { ...opts.configStore.get().git };
            delete nextGit.identity;
            opts.configStore.update({
              git: Object.keys(nextGit).length > 0 ? nextGit : undefined,
            });
          }
          return {
            message:
              `${color.green('✓')} commit identity cleared — git's own config applies again` +
              color.dim(sessionOnly ? ' (this session only)' : ''),
          };
        }

        return {
          message: `${color.red('Unknown subcommand')} "${sub}". Try ${color.dim('/gitid')}, ${color.dim('/gitid set <name...> <email>')}, or ${color.dim('/gitid help')}.`,
        };
      } catch (err) {
        return { message: `${color.red('gitid error')}: ${toErrorMessage(err)}` };
      }
    },
  };
}
