/**
 * Wakes roster specialists when files they own change.
 *
 * The rules and the reasoning behind them live in `specialist-trigger-rules.ts`.
 * This file is the machine around them: detect, settle, cap, emit.
 *
 * It deliberately does NOT spawn. Core has no Director, and the event boundary
 * is the same one auto-review uses (`chimera.review_needed` → the CLI handler
 * that owns the fleet). Keeping the split means the detection half stays a pure
 * unit test with no fleet, and a host without a Director simply never listens.
 */

import { areSubagentsAllowed } from '../coordination/session-subagent-policy.js';
import type { EventMap } from '../kernel/events.js';
import type { Plugin } from '../types/plugin.js';
import type { SlashCommand } from '../types/slash-command.js';
import { isGitRepo, runGit } from './auto-review-git.js';
import {
  matchSpecialistTriggers,
  type ResolvedSpecialistTriggerConfig,
  resolveSpecialistTriggerConfig,
  type SpecialistTriggerConfig,
  type SpecialistTriggerMatch,
  specialistFireKey,
  specialistTaskText,
} from './specialist-trigger-rules.js';

/** Payload of `fleet.specialist_needed`. */
export interface SpecialistNeededPayload {
  /** Roster role id to spawn. */
  role: string;
  /** Repo-relative POSIX paths that triggered it. */
  paths: string[];
  /** Task text for the woken worker. */
  task: string;
  /** Cost tier hint; the host may still override. */
  tier: 'budget' | 'standard' | 'premium';
  /** Working directory the paths are relative to. */
  cwd: string;
}

const PLUGIN_CONFIG_KEY = 'wstack-specialist-triggers';

/**
 * Changed paths, INCLUDING untracked ones.
 *
 * `getChangedFiles` — what auto-review uses — passes `--untracked-files=no`,
 * which is right for a reviewer (a file with no committed version has no diff
 * to review) and wrong here. A brand-new file is the normal shape of the work
 * these rules watch for: migrations and locale files are added far more often
 * than they are edited, and a trigger that only fires on modification would
 * miss the case it exists for. Ignored paths stay out either way, so this does
 * not drag in `node_modules` or build output.
 */
async function changedPathsIncludingNew(cwd: string): Promise<string[]> {
  const result = await runGit(['status', '--porcelain'], cwd);
  if (result.code !== 0) return [];
  const paths: string[] = [];
  for (const line of result.stdout.split('\n')) {
    if (line.length < 4) continue;
    let raw = line.slice(3).trim();
    // A rename reads `R  old -> new`; only the destination exists to inspect.
    const arrow = raw.lastIndexOf(' -> ');
    if (arrow !== -1) raw = raw.slice(arrow + 4);
    // Git quotes paths containing spaces or non-ASCII bytes.
    if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    if (raw.length > 0) paths.push(raw);
  }
  return paths;
}
/** An in-flight entry is released after this long even if nothing reports back. */
const IN_FLIGHT_TTL_MS = 10 * 60 * 1000;

function buildSpecialistTriggerCommand(
  getConfig: () => ResolvedSpecialistTriggerConfig,
  getFired: () => { key: string; at: number }[],
  getInFlight: () => number,
): SlashCommand {
  return {
    name: 'specialist-triggers',
    category: 'Agent',
    description: 'Show which file patterns wake which roster specialists.',
    help: [
      'File-pattern triggers that wake roster specialists automatically.',
      '',
      'A changed file matching a rule spawns that role in the background once',
      'the paths stop moving. Rules are plain globs — no model decides.',
      '',
      '  /specialist-triggers      Show rules, caps, and what has fired',
      '',
      `Configuration (config.json extensions.${PLUGIN_CONFIG_KEY}):`,
      '  enabled         true | false (default false)',
      '  rules           replace the shipped rules entirely',
      '  extraRules      append to whichever rules are in force',
      '  debounceMs      quiet window before firing (default 20000)',
      '  maxConcurrent   specialists in flight at once (default 2)',
      '  maxPerSession   total triggers per session (default 8)',
    ].join('\n'),
    async run() {
      const cfg = getConfig();
      const fired = getFired();
      const lines = [
        `Specialist triggers — ${cfg.enabled ? 'enabled' : 'disabled'}`,
        '',
        `  Debounce:      ${cfg.debounceMs} ms`,
        `  In flight:     ${getInFlight()} / ${cfg.maxConcurrent}`,
        `  Fired:         ${fired.length} / ${cfg.maxPerSession} this session`,
        '',
        '  Rules',
      ];
      for (const rule of cfg.rules) {
        lines.push(`    ${rule.role.padEnd(18)} ${rule.match.join(', ')}`);
      }
      if (fired.length > 0) {
        lines.push('', '  Fired this session');
        for (const entry of fired) {
          lines.push(`    ${new Date(entry.at).toISOString().slice(11, 19)}  ${entry.key}`);
        }
      }
      return { message: lines.join('\n') };
    },
  };
}

export function createSpecialistTriggerPlugin(): Plugin {
  return {
    name: PLUGIN_CONFIG_KEY,
    version: '1.0.0',
    description: 'Wakes roster specialists when files matching their patterns change.',
    apiVersion: '^0.1',
    capabilities: { slashCommands: true },
    defaultConfig: {},

    setup(api) {
      const recompute = (): ResolvedSpecialistTriggerConfig =>
        resolveSpecialistTriggerConfig(
          api.config.extensions?.[PLUGIN_CONFIG_KEY] as SpecialistTriggerConfig | undefined,
          api.config,
        );
      let resolved = recompute();

      const fired: { key: string; at: number }[] = [];
      const firedKeys = new Set<string>();
      let inFlight = 0;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      let lastSeenKeys = '';
      let sessionEnded = false;
      let scanInFlight = false;

      api.onConfigChange(() => {
        const previous = resolved.enabled;
        resolved = recompute();
        if (previous !== resolved.enabled) {
          api.log.info(`[specialist-triggers] enabled=${resolved.enabled}`);
        }
      });

      api.slashCommands.register(
        buildSpecialistTriggerCommand(
          () => resolved,
          () => [...fired],
          () => inFlight,
        ),
      );

      if (!resolved.enabled) {
        api.log.info('[specialist-triggers] disabled by config');
        return;
      }
      api.log.info(
        `[specialist-triggers] loaded — ${resolved.rules.length} rule(s), debounce=${resolved.debounceMs}ms`,
      );

      const releaseInFlight = (): void => {
        inFlight = Math.max(0, inFlight - 1);
      };

      const fire = (match: SpecialistTriggerMatch, cwd: string): void => {
        const key = specialistFireKey(match);
        if (firedKeys.has(key)) return;
        if (fired.length >= resolved.maxPerSession) return;
        if (inFlight >= resolved.maxConcurrent) return;

        firedKeys.add(key);
        fired.push({ key, at: Date.now() });
        inFlight += 1;
        // Released on a timer rather than on completion: the host that spawns
        // may die, be a version that does not report back, or simply not exist.
        // A counter that can only go up would silence the plugin for the rest
        // of the session, which is a worse failure than one extra worker.
        const timer = setTimeout(releaseInFlight, IN_FLIGHT_TTL_MS);
        timer.unref();

        const payload: SpecialistNeededPayload = {
          role: match.rule.role,
          paths: match.paths,
          task: specialistTaskText(match),
          tier: match.rule.tier ?? 'budget',
          cwd,
        };
        api.log.info(
          `[specialist-triggers] ${match.rule.role} ← ${match.paths.length} file(s): ${match.paths.slice(0, 3).join(', ')}`,
        );
        api.emitCustom('fleet.specialist_needed', payload);
      };

      /**
       * One scan: read changed paths, match, and either restart the quiet
       * window (the set is still moving) or fire (it has settled).
       */
      const scan = async (
        payload: EventMap['iteration.completed'] | undefined,
        settled: boolean,
      ): Promise<void> => {
        if (sessionEnded || !resolved.enabled) return;
        // A session that has switched subagents off has said what it wants;
        // spawning specialists behind that would be exactly the override the
        // setting exists to prevent.
        if (payload?.ctx && !areSubagentsAllowed(payload.ctx)) return;
        if (scanInFlight) return;
        scanInFlight = true;
        try {
          const cwd = api.config.cwd ?? process.cwd();
          if (!(await isGitRepo(cwd))) return;
          const paths = (await changedPathsIncludingNew(cwd)).filter(
            (filePath) => !filePath.startsWith('.wrongstack/'),
          );
          const matches = matchSpecialistTriggers(paths, resolved.rules);
          if (matches.length === 0) {
            if (settleTimer) clearTimeout(settleTimer);
            settleTimer = undefined;
            lastSeenKeys = '';
            return;
          }

          const keys = JSON.stringify(matches.map(specialistFireKey));
          if (!settled || keys !== lastSeenKeys) {
            // Still moving (or first sighting) — restart the quiet window so a
            // half-written migration is not reviewed mid-edit.
            lastSeenKeys = keys;
            if (settleTimer) clearTimeout(settleTimer);
            const timer = setTimeout(() => {
              settleTimer = undefined;
              void scan(payload, true);
            }, resolved.debounceMs);
            timer.unref();
            settleTimer = timer;
            return;
          }

          for (const match of matches) fire(match, cwd);
        } catch (err) {
          api.log.info(
            `[specialist-triggers] scan failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          scanInFlight = false;
        }
      };

      api.onEvent('iteration.completed', async (payload) => {
        await scan(payload as EventMap['iteration.completed'] | undefined, false);
      });

      api.onEvent('session.ended', () => {
        sessionEnded = true;
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = undefined;
      });
    },
  };
}
