/** `/settings` mutations for versioning, the shell circuit breaker and model-runtime behaviour. */

import { isReasoningEffort, REASONING_EFFORT_LEVELS } from '@wrongstack/contracts/types';
import { color } from '@wrongstack/core/utils';
import { getProcessRegistry } from '@wrongstack/tools';
import { persistAutonomySetting, persistConfigSetting } from '../settings-menu.js';
import { formatDelay } from '../utils/delay-format.js';
import type { SlashCommandContext } from './command-context.js';
import type { SettingsPersistDeps } from './settings-persist-deps.js';

/** semver-part and circuit-breaker keys. Returns undefined for a key it does not own. */
export async function executeBreakerSettings(
  sub: string,
  rest: string[],
  persistDeps: SettingsPersistDeps,
  _opts: SlashCommandContext,
  _activeProfile: string,
): Promise<{ message: string } | undefined> {
  if (sub === 'semver-part') {
    const raw = (rest[0] ?? '').toLowerCase();
    const parts = ['patch', 'minor', 'major', 'auto'];
    if (!parts.includes(raw)) {
      return {
        message: `${color.amber('Usage:')} /settings semver-part patch|minor|major|auto`,
      };
    }
    await persistConfigSetting({ ...persistDeps, inProjectConfigPath: undefined }, (cfg) => {
      const ext = (cfg.extensions as Record<string, Record<string, unknown>> | undefined) ?? {};
      ext['semver-bump'] = { ...ext['semver-bump'], defaultPart: raw };
      cfg.extensions = ext;
    });
    return {
      message: `${color.green('✓')} semver default part → ${color.bold(raw)}   ${color.dim('saved to active profile config; used when /semver or semver_bump gets no explicit part')}`,
    };
  }

  if (sub === 'breaker') {
    const raw = (rest[0] ?? '').toLowerCase();
    if (!['on', 'off'].includes(raw)) {
      return { message: `${color.amber('Usage:')} /settings breaker on|off` };
    }
    const on = raw === 'on';
    await persistConfigSetting(persistDeps, (cfg) => {
      const cb = (cfg as Record<string, unknown>).circuitBreaker as
        | Record<string, unknown>
        | undefined;
      (cfg as Record<string, unknown>).circuitBreaker = { ...(cb ?? {}), enabled: on };
    });
    getProcessRegistry().setBreakerConfig({ enabled: on });
    return {
      message: `${color.green('✓')} circuit breaker → ${on ? color.cyan('on') : color.dim('off')}   ${color.dim(on ? 'bash/exec gated on repeated failures; trips arm the kill/reset countdown' : 'bash/exec always proceed')}`,
    };
  }

  if (sub === 'breaker-timeout') {
    const raw = rest[0];
    if (raw === undefined) {
      return {
        message: `${color.amber('Usage:')} /settings breaker-timeout <seconds>   ${color.dim('(0 = manual recovery only)')}`,
      };
    }
    const value = raw.trim();
    const seconds = value ? Number(value) : Number.NaN;
    if (!Number.isFinite(seconds) || seconds < 0) {
      return {
        message: `${color.red('Invalid number')}: "${raw}". Enter seconds, e.g. /settings breaker-timeout 60`,
      };
    }
    const ms = Math.round(seconds * 1000);
    await persistConfigSetting(persistDeps, (cfg) => {
      const cb = (cfg as Record<string, unknown>).circuitBreaker as
        | Record<string, unknown>
        | undefined;
      (cfg as Record<string, unknown>).circuitBreaker = {
        ...(cb ?? {}),
        autoKillResetMs: ms,
      };
    });
    getProcessRegistry().setBreakerConfig({ autoKillResetMs: ms });
    return {
      message: `${color.green('✓')} breaker kill/reset timeout → ${ms > 0 ? formatDelay(ms) : color.dim('manual')}   ${color.dim(ms > 0 ? 'statusline shows a countdown when the breaker trips' : 'breaker trips require /kill reset')}`,
    };
  }
  return undefined;
}

/** Title animation, reasoning, cache TTL and stream-watchdog keys. Returns undefined for a key it does not own. */
export async function executeModelRuntimeSettings(
  sub: string,
  rest: string[],
  persistDeps: SettingsPersistDeps,
  _opts: SlashCommandContext,
  _activeProfile: string,
): Promise<{ message: string } | undefined> {
  if (sub === 'title-animation') {
    const raw = (rest[0] ?? '').toLowerCase();
    if (!['on', 'off'].includes(raw)) {
      return { message: `${color.amber('Usage:')} /settings title-animation on|off` };
    }
    const on = raw === 'on';
    await persistAutonomySetting(persistDeps, (autonomy) => {
      (autonomy as Record<string, unknown>).terminalTitleAnimation = on;
    });
    return {
      message: `${color.green('✓')} title animation → ${on ? color.cyan('on') : color.dim('off')}   ${color.dim('terminal title animation')}`,
    };
  }

  if (sub === 'reasoning') {
    const raw = (rest[0] ?? '').toLowerCase();
    const modes = ['auto', 'on', 'off'];
    if (!modes.includes(raw)) {
      return { message: `${color.amber('Usage:')} /settings reasoning auto|on|off` };
    }
    await persistConfigSetting(persistDeps, (cfg) => {
      const mr = (cfg as Record<string, unknown>).modelRuntime as
        | Record<string, unknown>
        | undefined;
      const reasoning = (mr?.reasoning as Record<string, unknown> | undefined) ?? {};
      reasoning.mode = raw;
      (cfg as Record<string, unknown>).modelRuntime = { ...mr, reasoning };
    });
    return { message: `${color.green('✓')} reasoning mode → ${color.bold(raw)}` };
  }

  if (sub === 'reasoning-effort') {
    const raw = (rest[0] ?? '').toLowerCase();
    if (!isReasoningEffort(raw)) {
      return {
        message: `${color.amber('Usage:')} /settings reasoning-effort ${REASONING_EFFORT_LEVELS.join('|')}`,
      };
    }
    await persistConfigSetting(persistDeps, (cfg) => {
      const mr = (cfg as Record<string, unknown>).modelRuntime as
        | Record<string, unknown>
        | undefined;
      const reasoning = (mr?.reasoning as Record<string, unknown> | undefined) ?? {};
      reasoning.effort = raw;
      (cfg as Record<string, unknown>).modelRuntime = { ...mr, reasoning };
    });
    return { message: `${color.green('✓')} reasoning effort → ${color.bold(raw)}` };
  }

  if (sub === 'reasoning-preserve') {
    const raw = (rest[0] ?? '').toLowerCase();
    if (!['on', 'off'].includes(raw)) {
      return { message: `${color.amber('Usage:')} /settings reasoning-preserve on|off` };
    }
    const on = raw === 'on';
    await persistConfigSetting(persistDeps, (cfg) => {
      const mr = (cfg as Record<string, unknown>).modelRuntime as
        | Record<string, unknown>
        | undefined;
      const reasoning = (mr?.reasoning as Record<string, unknown> | undefined) ?? {};
      reasoning.preserve = on;
      (cfg as Record<string, unknown>).modelRuntime = { ...mr, reasoning };
    });
    return {
      message: `${color.green('✓')} reasoning preserve → ${on ? color.cyan('on') : color.dim('off')}`,
    };
  }

  if (sub === 'cache-ttl') {
    const raw = (rest[0] ?? '').toLowerCase();
    if (!['5m', '1h'].includes(raw)) {
      return { message: `${color.amber('Usage:')} /settings cache-ttl 5m|1h` };
    }
    await persistConfigSetting(persistDeps, (cfg) => {
      const mr = (cfg as Record<string, unknown>).modelRuntime as
        | Record<string, unknown>
        | undefined;
      (cfg as Record<string, unknown>).modelRuntime = { ...mr, cache: { ttl: raw } };
    });
    return { message: `${color.green('✓')} cache TTL → ${color.bold(raw)}` };
  }

  if (sub === 'stream-watchdog') {
    // Two watchdogs, one setting: the gap between stream chunks and the wait
    // for response headers. Seconds because that is the scale users reason
    // in; `off` disables a watchdog, leaving only the caller's own abort.
    const parse = (raw: string | undefined): number | 'invalid' | undefined => {
      if (raw === undefined || raw === '') return undefined;
      const lower = raw.toLowerCase();
      if (lower === 'off' || lower === '0') return 0;
      const secs = Number(lower.replace(/s$/, ''));
      if (!Number.isFinite(secs) || secs < 1 || secs > 3_600) return 'invalid';
      return Math.round(secs) * 1000;
    };
    const usage = {
      message:
        `${color.amber('Usage:')} /settings stream-watchdog <gap-seconds|off> [headers-seconds|off]` +
        `   ${color.dim('e.g. 300 (5 min gap), or 300 30')}`,
    };
    const gap = parse(rest[0]);
    const headers = parse(rest[1]);
    if (gap === 'invalid' || headers === 'invalid' || gap === undefined) return usage;
    await persistConfigSetting(persistDeps, (cfg) => {
      const mr = ((cfg as Record<string, unknown>).modelRuntime ?? {}) as Record<string, unknown>;
      const streaming = { ...((mr.streaming as Record<string, unknown>) ?? {}) };
      streaming.hangTimeoutMs = gap;
      if (headers !== undefined) streaming.headersTimeoutMs = headers;
      (cfg as Record<string, unknown>).modelRuntime = { ...mr, streaming };
    });
    const show = (ms: number): string => (ms === 0 ? 'off' : `${Math.round(ms / 1000)}s`);
    const tail = headers !== undefined ? ` / headers ${color.bold(show(headers))}` : '';
    return {
      message:
        `${color.green('✓')} stream watchdog → gap ${color.bold(show(gap))}${tail}` +
        `   ${color.dim('applies to providers built from here on (new session to be safe)')}`,
    };
  }
  return undefined;
}
