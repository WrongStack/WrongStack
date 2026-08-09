import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SlashCommand } from '@wrongstack/core/types';
import { atomicWrite, color, toErrorMessage } from '@wrongstack/core/utils';
import { type DoctorFinding, diagnoseConfig, type PluginSchemaInfo } from '../config-doctor.js';
import { appendHistory } from '../config-history.js';
import { activeProfileConfigPath } from '../profile-config-path.js';
import { filterSafeForProject } from '../settings-menu.js';
import type { SlashCommandContext } from './command-context.js';
import { parseSubcommand } from './helpers.js';

/**
 * `/doctor` — diagnose and auto-repair the persisted config files.
 *
 * Report mode (bare `/doctor`) never writes anything. `/doctor fix` backs the
 * file up first (config.json.last + a timestamped .bak, the same convention
 * config-history uses), then writes the repaired config and mirrors it into
 * the in-memory store. A config that fails to parse at all is restored from
 * the newest parsable backup.
 */
export function buildDoctorCommand(opts: SlashCommandContext): SlashCommand {
  const help = [
    'Usage:',
    '  /doctor        Diagnose the config files (read-only)',
    '  /doctor fix    Apply all auto-fixes (backs up first)',
    '',
    'Checks: JSON validity (restores from backup when corrupt), field types',
    '(booleans, numbers, enums like autonomy.defaultMode), plugins/extensions',
    'shape, plugin option schemas, unknown-key typos, plaintext secrets, and',
    'credential fields leaked into the per-project config.',
    '',
    'Fix safety: invalid values are removed so built-in / plugin defaults',
    'apply; values are only rewritten when unambiguous (e.g. "true" → true).',
  ].join('\n');

  /** Best-effort load of builtin plugin schemas for extensions validation. */
  async function loadPluginSchemas(): Promise<PluginSchemaInfo[]> {
    try {
      const { BUILTIN_PLUGIN_FACTORIES } = await import('../wiring/plugins.js');
      const settled = await Promise.allSettled(BUILTIN_PLUGIN_FACTORIES.map((f) => f()));
      const loaded: PluginSchemaInfo[] = [];
      for (const s of settled) {
        if (s.status === 'fulfilled' && s.value?.configSchema) {
          loaded.push({ name: s.value.name, configSchema: s.value.configSchema });
        }
      }
      return loaded;
    } catch {
      return [];
    }
  }

  function formatFinding(f: DoctorFinding, applied: boolean): string {
    const icon = f.severity === 'error' ? color.red('✗') : color.amber('!');
    const fix = f.fix
      ? color.dim(applied ? ` → ${f.fix}` : ` → fixable: ${f.fix}`)
      : f.severity === 'error'
        ? color.dim(' → needs manual fix')
        : '';
    return `  ${icon} ${color.cyan(f.path)} — ${f.problem}${fix}`;
  }

  /** Find the newest sibling backup of `file` that parses as JSON. */
  async function findParsableBackup(file: string): Promise<{ name: string; raw: string } | null> {
    const dir = path.dirname(file);
    const base = path.basename(file);
    const candidates: string[] = [`${base}.last`];
    try {
      const siblings = await fs.readdir(dir);
      candidates.push(
        ...siblings
          .filter((f) => f.startsWith(`${base}.`) && f.endsWith('.bak'))
          .sort()
          .reverse(),
      );
    } catch {
      // directory unreadable — .last candidate may still work
    }
    for (const name of candidates) {
      try {
        const raw = await fs.readFile(path.join(dir, name), 'utf8');
        JSON.parse(raw);
        return { name, raw };
      } catch {
        // missing or also corrupt — try the next one
      }
    }
    return null;
  }

  /** Snapshot `raw` next to `file` using the config-history naming convention. */
  async function backupSibling(file: string, raw: string, suffix = 'bak'): Promise<void> {
    try {
      await atomicWrite(`${file}.last`, raw);
      await atomicWrite(`${file}.${Date.now()}.${suffix}`, raw);
    } catch {
      // backup is best-effort; the atomic main write below is the safety net
    }
  }

  return {
    name: 'doctor',
    category: 'Config',
    description: 'Diagnose and auto-fix problems in the persisted config files.',
    argsHint: '[fix]',
    help,
    async run(args) {
      const { cmd } = parseSubcommand(args);
      if (cmd === 'help' || cmd === '--help') return { message: help };
      const applyFixes = cmd === 'fix';
      if (cmd && !applyFixes) {
        return { message: `${color.amber('Usage:')} /doctor [fix]` };
      }
      if (!opts.paths) {
        return { message: `${color.red('Error')} config paths not available.` };
      }

      const targets: { label: string; file: string; isProject: boolean }[] = [
        {
          label: 'active profile config',
          file: activeProfileConfigPath(opts.paths, opts.configStore?.get() ?? {}),
          isProject: false,
        },
      ];
      if (opts.paths.inProjectConfig) {
        targets.push({
          label: 'project config',
          file: opts.paths.inProjectConfig,
          isProject: true,
        });
      }

      const lines: string[] = [`${color.bold('WrongStack')} ${color.dim('— Config Doctor')}`];
      let errorCount = 0;
      let warningCount = 0;
      let fixableCount = 0;
      const pluginSchemas = await loadPluginSchemas();

      for (const target of targets) {
        let raw: string;
        try {
          raw = await fs.readFile(target.file, 'utf8');
        } catch {
          if (!target.isProject) {
            lines.push(
              '',
              `${color.bold(target.label)} ${color.dim(target.file)}`,
              color.dim('  no config file — built-in defaults apply'),
            );
          }
          continue;
        }

        lines.push('', `${color.bold(target.label)} ${color.dim(target.file)}`);

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch (err) {
          errorCount++;
          const msg = toErrorMessage(err);
          lines.push(`  ${color.red('✗')} invalid JSON — ${msg}`);
          if (!applyFixes) {
            fixableCount++;
            lines.push(
              color.dim('    → run /doctor fix to restore from the newest parsable backup'),
            );
            continue;
          }
          const backup = await findParsableBackup(target.file);
          if (!backup) {
            lines.push(`  ${color.red('✗')} no parsable backup found — restore the file manually`);
            continue;
          }
          await backupSibling(target.file, raw, 'broken.bak');
          await atomicWrite(target.file, backup.raw);
          lines.push(
            `  ${color.green('✓')} restored from ${backup.name} ${color.dim('(corrupt file kept as *.broken.bak)')}`,
          );
          raw = backup.raw;
          parsed = JSON.parse(raw) as Record<string, unknown>;
        }

        const report = diagnoseConfig(parsed, pluginSchemas);

        // Credential-bearing fields must never live in the project config —
        // flag anything filterSafeForProject would refuse to write there.
        if (target.isProject) {
          const safe = filterSafeForProject(parsed);
          for (const key of Object.keys(parsed)) {
            if (!(key in safe)) {
              report.findings.push({
                path: key,
                problem:
                  'not project-safe — belongs in the active profile config (move it manually)',
                severity: 'warning',
              });
            }
          }
        }

        if (report.findings.length === 0) {
          lines.push(`  ${color.green('✓')} healthy`);
          continue;
        }

        const willWrite = applyFixes && report.changed;
        for (const f of report.findings) {
          if (f.severity === 'error') errorCount++;
          else warningCount++;
          if (f.fix) fixableCount++;
          lines.push(formatFinding(f, willWrite && !!f.fix));
        }

        if (willWrite) {
          await backupSibling(target.file, raw);
          await atomicWrite(target.file, JSON.stringify(report.fixed, null, 2));
          if (!target.isProject) {
            try {
              // History entry + in-memory mirror follow the /settings persist
              // convention so the change shows up in config-history and takes
              // effect without a restart.
              const homeFn = () => path.dirname(path.dirname(target.file));
              await appendHistory(
                parsed,
                report.fixed,
                'config doctor auto-fix',
                homeFn,
                target.file,
              );
            } catch {
              // history is best-effort
            }
            opts.configStore?.update(report.fixed as never);
          }
          lines.push(
            `  ${color.green('✓')} fixes written ${color.dim('(backup: config.json.last + timestamped .bak)')}`,
          );
        }
      }

      lines.push(
        '',
        errorCount + warningCount === 0
          ? `${color.green('✓')} config is healthy`
          : `${errorCount} error(s), ${warningCount} warning(s)` +
              (applyFixes
                ? ''
                : `, ${fixableCount} auto-fixable ${color.dim('— run /doctor fix')}`),
      );
      return { message: lines.join('\n') };
    },
  };
}
