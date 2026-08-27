import { noOpVault } from '@wrongstack/core/security';
import {
  type FleetChatVerbosity,
  isReasoningEffort,
  REASONING_EFFORT_LEVELS,
} from '@wrongstack/core/types';
import { color, toErrorMessage } from '@wrongstack/core/utils';
import { getProcessRegistry } from '@wrongstack/tools';
import {
  deriveFsAccessPair,
  persistAutonomySetting,
  persistConfigSetting,
} from '../settings-menu.js';
import { formatDelay } from '../utils/delay-format.js';
import type { SlashCommandContext } from './command-context.js';
import { unknownSubcommand } from './helpers.js';

export const ALL_SETTINGS_KEYS = [
  'delay',
  'mode',
  'hints',
  'debug-stream',
  'config-scope',
  'fs-access',
  'refine',
  'refine-delay',
  'refine-language',
  'refiner-provider',
  'refiner-model',
  'refiner-fallback-profile',
  'refiner-clear',
  'semver-part',
  'breaker',
  'breaker-timeout',
  'context-mode',
  'context-strategy',
  'context-auto-compact',
  'token-saving',
  'max-concurrent',
  'title-animation',
  'reasoning',
  'reasoning-effort',
  'reasoning-preserve',
  'cache-ttl',
  'stream-fleet',
  'chime',
  'confirm-exit',
  'mcp',
  'plugins',
  'memory',
  'skills',
  'models-registry',
  'max-iterations',
  'auto-proceed-max-iterations',
  'index-on-start',
  'log-level',
  'audit-level',
  'thinking-word',
  'statusline',
  'animation',
  'read-symbols',
  'defaults',
];

export async function executeSettingsSubcommand(
  sub: string,
  rest: string[],
  opts: SlashCommandContext,
): Promise<{ message: string }> {
  const activeProfile = opts.configStore.get().activeProfile ?? 'default';
  const persistDeps = {
    configStore: opts.configStore,
    profileConfigPath: opts.paths!.profileConfig(activeProfile),
    inProjectConfigPath: opts.paths!.inProjectConfig,
    vault: noOpVault,
  };

  try {
    if (sub === 'hq') {
      const raw = (rest[0] ?? '').toLowerCase();
      if (!['on', 'off'].includes(raw)) {
        return { message: `${color.amber('Usage:')} /settings hq on|off` };
      }
      const on = raw === 'on';
      await persistConfigSetting({ ...persistDeps, forceGlobal: true }, (cfg) => {
        const hq = (cfg.hq as Record<string, unknown> | undefined) ?? {};
        hq.enabled = on;
        cfg.hq = hq;
      });
      return {
        message: `${color.green('✓')} HQ publishing → ${on ? color.cyan('on') : color.dim('off')}`,
      };
    }

    if (sub === 'hq-url') {
      const raw = rest.join(' ').trim();
      if (!raw) return { message: `${color.amber('Usage:')} /settings hq-url <http://host:3499>` };
      try {
        const url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
      } catch {
        return { message: `${color.red('Invalid URL')}: ${raw}` };
      }
      await persistConfigSetting({ ...persistDeps, forceGlobal: true }, (cfg) => {
        const hq = (cfg.hq as Record<string, unknown> | undefined) ?? {};
        hq.url = raw;
        hq.enabled = true;
        cfg.hq = hq;
      });
      return { message: `${color.green('✓')} HQ URL → ${color.cyan(raw)}` };
    }

    if (sub === 'hq-token') {
      const token = rest.join(' ').trim();
      if (!token) return { message: `${color.amber('Usage:')} /settings hq-token <client-token>` };
      await persistConfigSetting({ ...persistDeps, forceGlobal: true }, (cfg) => {
        const hq = (cfg.hq as Record<string, unknown> | undefined) ?? {};
        hq.token = token;
        hq.enabled = true;
        cfg.hq = hq;
      });
      return {
        message: `${color.green('✓')} HQ token saved ${color.dim('(active profile config)')}`,
      };
    }

    if (sub === 'hq-raw') {
      const raw = (rest[0] ?? '').toLowerCase();
      if (!['on', 'off'].includes(raw)) {
        return { message: `${color.amber('Usage:')} /settings hq-raw on|off` };
      }
      const on = raw === 'on';
      await persistConfigSetting({ ...persistDeps, forceGlobal: true }, (cfg) => {
        const hq = (cfg.hq as Record<string, unknown> | undefined) ?? {};
        hq.rawContent = on;
        cfg.hq = hq;
      });
      return {
        message: `${color.green('✓')} HQ raw content → ${on ? color.cyan('on') : color.dim('off')}`,
      };
    }

    if (sub === 'delay') {
      const raw = rest[0];
      if (raw === undefined) {
        return {
          message: `${color.amber('Usage:')} /settings delay <seconds>   ${color.dim('(0 disables)')}`,
        };
      }
      const seconds = Number.parseFloat(raw);
      if (Number.isNaN(seconds) || seconds < 0) {
        return {
          message: `${color.red('Invalid number')}: "${raw}". Enter seconds, e.g. /settings delay 30`,
        };
      }
      const ms = Math.round(seconds * 1000);
      await persistAutonomySetting(persistDeps, (autonomy) => {
        autonomy.autoProceedDelayMs = ms;
      });
      return { message: `${color.green('✓')} auto-proceed delay → ${formatDelay(ms)}` };
    }

    if (sub === 'mode') {
      const raw = (rest[0] ?? '').toLowerCase();
      const modes = ['off', 'suggest', 'auto'];
      if (!modes.includes(raw)) {
        return { message: `${color.amber('Usage:')} /settings mode off|suggest|auto` };
      }
      await persistAutonomySetting(persistDeps, (autonomy) => {
        autonomy.defaultMode = raw as 'off' | 'suggest' | 'auto';
      });
      return { message: `${color.green('✓')} default autonomy → ${color.bold(raw)}` };
    }

    if (sub === 'hints') {
      const raw = (rest[0] ?? '').toLowerCase();
      if (!['on', 'off'].includes(raw)) {
        return { message: `${color.amber('Usage:')} /settings hints on|off` };
      }
      const on = raw === 'on';
      await persistConfigSetting(persistDeps, (cfg) => {
        cfg.hints = on;
      });
      return {
        message: `${color.green('✓')} launch hints → ${on ? color.cyan('on') : color.dim('off')}`,
      };
    }

    if (sub === 'debug-stream') {
      const raw = (rest[0] ?? '').toLowerCase();
      if (!['on', 'off'].includes(raw)) {
        return { message: `${color.amber('Usage:')} /settings debug-stream on|off` };
      }
      const on = raw === 'on';
      const { setDebugStreamEnabled } = await import('@wrongstack/providers');
      setDebugStreamEnabled(on);
      await persistConfigSetting(persistDeps, (cfg) => {
        (cfg as Record<string, unknown>).debugStream = on;
      });
      return {
        message: `${color.green('✓')} debug stream → ${on ? color.cyan('on') : color.dim('off')}   ${color.dim('raw SSE hex-dump to stderr')}`,
      };
    }

    if (sub === 'config-scope') {
      const raw = (rest[0] ?? '').toLowerCase();
      if (!['global', 'project'].includes(raw)) {
        return { message: `${color.amber('Usage:')} /settings config-scope global|project` };
      }
      await persistConfigSetting(persistDeps, (cfg) => {
        cfg.configScope = raw;
      });
      const label =
        raw === 'project'
          ? `${color.cyan('project')} — settings saved to <project>/.wrongstack/config.json`
          : `${color.cyan('global')} — settings saved to ~/.wrongstack/profiles/${activeProfile}/config.json`;
      return { message: `${color.green('✓')} config scope → ${label}` };
    }

    if (sub === 'fs-access') {
      const raw = (rest[0] ?? '').toLowerCase();
      if (!['unrestricted', 'project'].includes(raw)) {
        return { message: `${color.amber('Usage:')} /settings fs-access unrestricted|project` };
      }
      const restrict = raw === 'project';
      const fsAccess = deriveFsAccessPair({ restrictFsToRoot: restrict });
      await persistConfigSetting(persistDeps, (cfg) => {
        const tools = (cfg.tools as Record<string, unknown> | undefined) ?? {};
        tools.restrictToProjectRoot = fsAccess!.restrictToProjectRoot;
        cfg.tools = tools;
        const features = (cfg.features as Record<string, unknown> | undefined) ?? {};
        features.allowOutsideProjectRoot = fsAccess!.allowOutsideProjectRoot;
        cfg.features = features;
      });
      const label = restrict
        ? `${color.cyan('project')} — file tools confined to the project root`
        : `${color.cyan('unrestricted')} — file tools may access paths outside the project root`;
      return {
        message: `${color.green('✓')} filesystem access → ${label}   ${color.dim('(restart or re-open the session to apply)')}`,
      };
    }

    if (sub === 'refine') {
      const raw = (rest[0] ?? '').toLowerCase();
      if (!['on', 'off'].includes(raw)) {
        return { message: `${color.amber('Usage:')} /settings refine on|off` };
      }
      const on = raw === 'on';
      await persistAutonomySetting(persistDeps, (autonomy) => {
        (autonomy as Record<string, unknown>).enhance = on;
      });
      if (opts.enhanceController) {
        opts.enhanceController.setEnabled(on);
      }
      return {
        message: `${color.green('✓')} refine → ${on ? color.cyan('on') : color.dim('off')}   ${color.dim(on ? 'prompts will be refined before sending' : 'prompts sent verbatim')}`,
      };
    }

    if (sub === 'refine-delay') {
      const raw = rest[0];
      if (raw === undefined) {
        return { message: `${color.amber('Usage:')} /settings refine-delay <seconds>` };
      }
      const seconds = Number.parseFloat(raw);
      if (Number.isNaN(seconds) || seconds < 0) {
        return {
          message: `${color.red('Invalid number')}: "${raw}". Enter seconds, e.g. /settings refine-delay 30`,
        };
      }
      const ms = Math.round(seconds * 1000);
      await persistAutonomySetting(persistDeps, (autonomy) => {
        (autonomy as Record<string, unknown>).enhanceDelayMs = ms;
      });
      return { message: `${color.green('✓')} refine-delay → ${formatDelay(ms)}` };
    }

    if (sub === 'refine-language') {
      const raw = (rest[0] ?? '').toLowerCase();
      if (!['original', 'english'].includes(raw)) {
        return {
          message: `${color.amber('Usage:')} /settings refine-language original|english`,
        };
      }
      await persistAutonomySetting(persistDeps, (autonomy) => {
        (autonomy as Record<string, unknown>).enhanceLanguage = raw;
      });
      const label =
        raw === 'original'
          ? `${color.cyan('original')} — use the language you wrote in`
          : `${color.cyan('english')} — translate to English`;
      return { message: `${color.green('✓')} refine-language → ${label}` };
    }

    if (sub === 'refiner-provider') {
      const raw = rest.join(' ').trim();
      const currentProvider = (
        opts.configStore.get().autonomy as Record<string, unknown> | undefined
      )?.refinerProvider as string | undefined;
      if (!raw) {
        return {
          message: `${color.amber('Usage:')} /settings refiner-provider <providerId>   ${color.dim('(e.g. "openai", "anthropic")' + (currentProvider ? ` Current: ${currentProvider}` : ''))}`,
        };
      }
      await persistAutonomySetting(persistDeps, (autonomy) => {
        (autonomy as Record<string, unknown>).refinerProvider = raw;
      });
      return {
        message: `${color.green('✓')} refiner-provider → ${color.cyan(raw)}   ${color.dim('goal refinement will use this provider when refiner-model is also set')}`,
      };
    }

    if (sub === 'refiner-model') {
      const raw = rest.join(' ').trim();
      const currentModel = (opts.configStore.get().autonomy as Record<string, unknown> | undefined)
        ?.refinerModel as string | undefined;
      if (!raw) {
        return {
          message: `${color.amber('Usage:')} /settings refiner-model <modelId>   ${color.dim('(must be a favorite or the active model; e.g. "gpt-4o-mini")' + (currentModel ? ` Current: ${currentModel}` : ''))}`,
        };
      }
      await persistAutonomySetting(persistDeps, (autonomy) => {
        (autonomy as Record<string, unknown>).refinerModel = raw;
      });
      return {
        message: `${color.green('✓')} refiner-model → ${color.cyan(raw)}   ${color.dim('goal refinement will use this model when it passes favorites/active validation')}`,
      };
    }

    if (sub === 'refiner-fallback-profile') {
      const raw = rest.join(' ').trim();
      const currentProfile = (
        opts.configStore.get().autonomy as Record<string, unknown> | undefined
      )?.refinerFallbackProfile as string | undefined;
      if (!raw) {
        return {
          message: `${color.amber('Usage:')} /settings refiner-fallback-profile <name>   ${color.dim('(e.g. "default")' + (currentProfile ? ` Current: ${currentProfile}` : ''))}`,
        };
      }
      await persistAutonomySetting(persistDeps, (autonomy) => {
        (autonomy as Record<string, unknown>).refinerFallbackProfile = raw;
      });
      return {
        message: `${color.green('✓')} refiner-fallback-profile → ${color.cyan(raw)}   ${color.dim('goal refinement will use the first valid entry from this profile chain')}`,
      };
    }

    if (sub === 'refiner-clear') {
      await persistAutonomySetting(persistDeps, (autonomy) => {
        (autonomy as Record<string, unknown>).refinerProvider = undefined;
        (autonomy as Record<string, unknown>).refinerModel = undefined;
        (autonomy as Record<string, unknown>).refinerFallbackProfile = undefined;
      });
      return {
        message: `${color.green('✓')} Refiner config cleared   ${color.dim('goal refinement will use the session provider+model')}`,
      };
    }

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
      const seconds = Number.parseFloat(raw);
      if (Number.isNaN(seconds) || seconds < 0) {
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

    if (sub === 'context-mode') {
      const raw = (rest[0] ?? '').toLowerCase();
      const modes = ['balanced', 'frugal', 'deep'];
      if (!modes.includes(raw)) {
        return {
          message: `${color.amber('Usage:')} /settings context-mode balanced|frugal|deep`,
        };
      }
      await persistConfigSetting(persistDeps, (cfg) => {
        const ctx = (cfg.context as Record<string, unknown>) ?? {};
        ctx.mode = raw;
        cfg.context = ctx;
      });
      return {
        message: `${color.green('✓')} context mode → ${color.cyan(raw)}   ${color.dim('context window policy')}`,
      };
    }

    if (sub === 'context-strategy') {
      const raw = (rest[0] ?? '').toLowerCase();
      const strategies = ['hybrid', 'intelligent', 'selective'];
      if (!strategies.includes(raw)) {
        return {
          message: `${color.amber('Usage:')} /settings context-strategy hybrid|intelligent|selective`,
        };
      }
      await persistConfigSetting(persistDeps, (cfg) => {
        const ctx = (cfg.context as Record<string, unknown>) ?? {};
        ctx.strategy = raw;
        cfg.context = ctx;
      });
      return {
        message: `${color.green('✓')} context strategy → ${color.cyan(raw)}   ${color.dim('compactor strategy')}`,
      };
    }

    if (sub === 'context-auto-compact') {
      const raw = (rest[0] ?? '').toLowerCase();
      if (!['on', 'off'].includes(raw)) {
        return { message: `${color.amber('Usage:')} /settings context-auto-compact on|off` };
      }
      const on = raw === 'on';
      await persistConfigSetting(persistDeps, (cfg) => {
        const ctx = (cfg.context as Record<string, unknown>) ?? {};
        ctx.autoCompact = on;
        cfg.context = ctx;
      });
      return {
        message: `${color.green('✓')} context auto-compact → ${on ? color.cyan('on') : color.dim('off')}   ${color.dim('auto-compact context when thresholds crossed')}`,
      };
    }

    if (sub === 'nextsteps-tool') {
      const raw = (rest[0] ?? '').toLowerCase();
      if (!['on', 'off'].includes(raw)) {
        return { message: `${color.amber('Usage:')} /settings nextsteps-tool on|off` };
      }
      const on = raw === 'on';
      await persistConfigSetting(persistDeps, (cfg) => {
        const tools = (cfg.tools as Record<string, unknown>) ?? {};
        tools.nextsteps = { enabled: on };
        cfg.tools = tools;
      });
      return {
        message: `${color.green('✓')} nextsteps tool → ${on ? color.cyan('on') : color.dim('off')}   ${color.dim('takes effect in the next session')}`,
      };
    }

    // ── Auto-thinning (tools.autoThin) ────────────────────────────────
    if (sub === 'autothin' || sub === 'auto-thin') {
      const raw = (rest[0] ?? '').toLowerCase();
      if (!['on', 'off', 'status'].includes(raw)) {
        return { message: `${color.amber('Usage:')} /settings autothin on|off|status` };
      }
      if (raw === 'status') {
        return { message: 'Use `/tool autothin status` for the live read-out.' };
      }
      const on = raw === 'on';
      await persistConfigSetting(persistDeps, (cfg) => {
        const tools = (cfg.tools as Record<string, unknown>) ?? {};
        const existing = (tools.autoThin as Record<string, unknown> | undefined) ?? {};
        tools.autoThin = { ...existing, enabled: on };
        cfg.tools = tools;
      });
      return {
        message: `${color.green('✓')} tools.autoThin.enabled → ${on ? color.cyan('true') : color.dim('false')}   ${color.dim('use /tool autothin candidates|apply|undo')}`,
      };
    }

    if (sub === 'autothin-idle') {
      const n = Number(rest[0]);
      if (!Number.isFinite(n) || n < 0) {
        return { message: `${color.amber('Usage:')} /settings autothin-idle <days>` };
      }
      await persistConfigSetting(persistDeps, (cfg) => {
        const tools = (cfg.tools as Record<string, unknown>) ?? {};
        const existing = (tools.autoThin as Record<string, unknown> | undefined) ?? {};
        tools.autoThin = { ...existing, idleDays: n };
        cfg.tools = tools;
      });
      return { message: `${color.green('✓')} tools.autoThin.idleDays → ${color.cyan(String(n))}` };
    }

    if (sub === 'autothin-min') {
      const n = Number(rest[0]);
      if (!Number.isFinite(n) || n < 0) {
        return { message: `${color.amber('Usage:')} /settings autothin-min <count>` };
      }
      await persistConfigSetting(persistDeps, (cfg) => {
        const tools = (cfg.tools as Record<string, unknown>) ?? {};
        const existing = (tools.autoThin as Record<string, unknown> | undefined) ?? {};
        tools.autoThin = { ...existing, minInvocations: n };
        cfg.tools = tools;
      });
      return {
        message: `${color.green('✓')} tools.autoThin.minInvocations → ${color.cyan(String(n))}`,
      };
    }

    if (sub === 'autothin-boot') {
      const raw = (rest[0] ?? '').toLowerCase();
      if (!['on', 'off'].includes(raw)) {
        return { message: `${color.amber('Usage:')} /settings autothin-boot on|off` };
      }
      const on = raw === 'on';
      await persistConfigSetting(persistDeps, (cfg) => {
        const tools = (cfg.tools as Record<string, unknown>) ?? {};
        const existing = (tools.autoThin as Record<string, unknown> | undefined) ?? {};
        tools.autoThin = { ...existing, applyOnBoot: on };
        cfg.tools = tools;
      });
      return {
        message: `${color.green('✓')} tools.autoThin.applyOnBoot → ${on ? color.cyan('true') : color.dim('false')}`,
      };
    }

    if (sub === 'token-saving') {
      const raw = (rest[0] ?? '').toLowerCase();
      const tiers = ['off', 'minimal', 'light', 'medium', 'aggressive'];
      if (!tiers.includes(raw)) {
        return {
          message: `${color.amber('Usage:')} /settings token-saving off|minimal|light|medium|aggressive`,
        };
      }
      await persistConfigSetting(persistDeps, (cfg) => {
        const feat = (cfg.features as Record<string, unknown>) ?? {};
        feat.tokenSavingMode = raw;
        cfg.features = feat;
      });
      return {
        message: `${color.green('✓')} token-saving → ${color.cyan(raw)}   ${color.dim('token-saving mode')}`,
      };
    }

    if (sub === 'max-concurrent') {
      const raw = rest[0];
      if (raw === undefined) {
        return {
          message: `${color.amber('Usage:')} /settings max-concurrent <n>   ${color.dim('(0 = default)')}`,
        };
      }
      const n = Number.parseInt(raw, 10);
      if (Number.isNaN(n) || n < 0) {
        return {
          message: `${color.red('Invalid number')}: "${raw}". Enter a non-negative integer (0 = default)`,
        };
      }
      await persistConfigSetting(persistDeps, (cfg) => {
        cfg.maxConcurrent = n;
      });
      return {
        message: `${color.green('✓')} max-concurrent → ${color.cyan(n === 0 ? 'default' : String(n))}   ${color.dim('max concurrent subagents')}`,
      };
    }

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

    if (sub === 'mcp') {
      const raw = (rest[0] ?? '').toLowerCase();
      if (!['on', 'off'].includes(raw))
        return { message: `${color.amber('Usage:')} /settings mcp on|off` };
      const on = raw === 'on';
      await persistConfigSetting(persistDeps, (cfg) => {
        const feats = (cfg.features as Record<string, unknown>) ?? {};
        feats.mcp = on;
        cfg.features = feats;
      });
      return {
        message: `${color.green('✓')} MCP features → ${on ? color.cyan('on') : color.dim('off')}   ${color.dim('restart to apply')}`,
      };
    }

    if (sub === 'plugins') {
      const raw = (rest[0] ?? '').toLowerCase();
      if (!['on', 'off'].includes(raw))
        return { message: `${color.amber('Usage:')} /settings plugins on|off` };
      const on = raw === 'on';
      await persistConfigSetting(persistDeps, (cfg) => {
        const feats = (cfg.features as Record<string, unknown>) ?? {};
        feats.plugins = on;
        cfg.features = feats;
      });
      return {
        message: `${color.green('✓')} Plugin features → ${on ? color.cyan('on') : color.dim('off')}   ${color.dim('restart to apply')}`,
      };
    }

    if (sub === 'memory') {
      const raw = (rest[0] ?? '').toLowerCase();
      if (!['on', 'off'].includes(raw))
        return { message: `${color.amber('Usage:')} /settings memory on|off` };
      const on = raw === 'on';
      await persistConfigSetting(persistDeps, (cfg) => {
        const feats = (cfg.features as Record<string, unknown>) ?? {};
        feats.memory = on;
        cfg.features = feats;
      });
      return {
        message: `${color.green('✓')} Memory features → ${on ? color.cyan('on') : color.dim('off')}   ${color.dim('restart to apply')}`,
      };
    }

    if (sub === 'skills') {
      const raw = (rest[0] ?? '').toLowerCase();
      if (!['on', 'off'].includes(raw))
        return { message: `${color.amber('Usage:')} /settings skills on|off` };
      const on = raw === 'on';
      await persistConfigSetting(persistDeps, (cfg) => {
        const feats = (cfg.features as Record<string, unknown>) ?? {};
        feats.skills = on;
        cfg.features = feats;
      });
      return {
        message: `${color.green('✓')} Skills features → ${on ? color.cyan('on') : color.dim('off')}   ${color.dim('restart to apply')}`,
      };
    }

    if (sub === 'models-registry') {
      const raw = (rest[0] ?? '').toLowerCase();
      if (!['on', 'off'].includes(raw))
        return { message: `${color.amber('Usage:')} /settings models-registry on|off` };
      const on = raw === 'on';
      await persistConfigSetting(persistDeps, (cfg) => {
        const feats = (cfg.features as Record<string, unknown>) ?? {};
        feats.modelsRegistry = on;
        cfg.features = feats;
      });
      return {
        message: `${color.green('✓')} Models registry → ${on ? color.cyan('on') : color.dim('off')}   ${color.dim('restart to apply')}`,
      };
    }

    if (sub === 'stream-fleet') {
      const raw = (rest[0] ?? '').toLowerCase();
      const mode: FleetChatVerbosity | undefined =
        raw === 'on'
          ? 'full'
          : raw === 'off' || raw === 'full'
            ? (raw as FleetChatVerbosity)
            : undefined;
      if (!mode)
        return {
          message: `${color.amber('Usage:')} /settings stream-fleet off|full (on = full)`,
        };
      await persistAutonomySetting(persistDeps, (autonomy) => {
        (autonomy as Record<string, unknown>).fleetChatVerbosity = mode;
      });
      opts.fleetStreamController?.setMode(mode);
      const desc =
        mode === 'full'
          ? 'every subagent tool call and message in chat'
          : 'subagent chat lines hidden (F2/F3 stay live)';
      return {
        message: `${color.green('✓')} fleet chat → ${color.cyan(mode)}   ${color.dim(desc)}`,
      };
    }

    if (sub === 'chime') {
      const raw = (rest[0] ?? '').toLowerCase();
      if (!['on', 'off'].includes(raw))
        return { message: `${color.amber('Usage:')} /settings chime on|off` };
      const on = raw === 'on';
      await persistAutonomySetting(persistDeps, (autonomy) => {
        (autonomy as Record<string, unknown>).chime = on;
      });
      return {
        message: `${color.green('✓')} completion chime → ${on ? color.cyan('on') : color.dim('off')}`,
      };
    }

    if (sub === 'confirm-exit') {
      const raw = (rest[0] ?? '').toLowerCase();
      if (!['on', 'off'].includes(raw))
        return { message: `${color.amber('Usage:')} /settings confirm-exit on|off` };
      const on = raw === 'on';
      await persistAutonomySetting(persistDeps, (autonomy) => {
        (autonomy as Record<string, unknown>).confirmExit = on;
      });
      return {
        message: `${color.green('✓')} confirm before exit → ${on ? color.cyan('on') : color.dim('off')}`,
      };
    }

    if (sub === 'max-iterations') {
      const raw = rest[0];
      if (raw === undefined)
        return {
          message: `${color.amber('Usage:')} /settings max-iterations <n>   ${color.dim('(0 = default)')}`,
        };
      const n = Number.parseInt(raw, 10);
      if (Number.isNaN(n) || n < 0)
        return {
          message: `${color.red('Invalid number')}: "${raw}". Enter a non-negative integer.`,
        };
      await persistConfigSetting(persistDeps, (cfg) => {
        const tools = (cfg.tools as Record<string, unknown>) ?? {};
        tools.maxIterations = n;
        cfg.tools = tools;
      });
      return {
        message: `${color.green('✓')} max iterations → ${color.cyan(n === 0 ? 'default' : String(n))}   ${color.dim('agent pauses after this many iterations')}`,
      };
    }

    if (sub === 'auto-proceed-max-iterations') {
      const raw = rest[0];
      if (raw === undefined)
        return {
          message: `${color.amber('Usage:')} /settings auto-proceed-max-iterations <n>   ${color.dim('(0 = unlimited)')}`,
        };
      const n = Number.parseInt(raw, 10);
      if (Number.isNaN(n) || n < 0)
        return {
          message: `${color.red('Invalid number')}: "${raw}". Enter a non-negative integer.`,
        };
      await persistAutonomySetting(persistDeps, (autonomy) => {
        (autonomy as Record<string, unknown>).autoProceedMaxIterations = n;
      });
      return {
        message: `${color.green('✓')} auto-proceed max iterations → ${color.cyan(n === 0 ? 'unlimited' : String(n))}`,
      };
    }

    if (sub === 'index-on-start') {
      const raw = (rest[0] ?? '').toLowerCase();
      if (!['on', 'off'].includes(raw))
        return { message: `${color.amber('Usage:')} /settings index-on-start on|off` };
      const on = raw === 'on';
      await persistConfigSetting(persistDeps, (cfg) => {
        const idx = (cfg.indexing as Record<string, unknown>) ?? {};
        idx.onSessionStart = on;
        cfg.indexing = idx;
      });
      return {
        message: `${color.green('✓')} index on session start → ${on ? color.cyan('on') : color.dim('off')}   ${color.dim('effective next session')}`,
      };
    }

    if (sub === 'log-level') {
      const raw = (rest[0] ?? '').toLowerCase();
      const levels = ['error', 'warn', 'info', 'debug', 'trace'];
      if (!levels.includes(raw))
        return {
          message: `${color.amber('Usage:')} /settings log-level error|warn|info|debug|trace`,
        };
      await persistConfigSetting(persistDeps, (cfg) => {
        const log = (cfg.log as Record<string, unknown>) ?? {};
        log.level = raw;
        cfg.log = log;
      });
      return { message: `${color.green('✓')} log level → ${color.cyan(raw)}` };
    }

    if (sub === 'audit-level') {
      const raw = (rest[0] ?? '').toLowerCase();
      const levels = ['minimal', 'standard', 'full'];
      if (!levels.includes(raw))
        return {
          message: `${color.amber('Usage:')} /settings audit-level minimal|standard|full`,
        };
      await persistConfigSetting(persistDeps, (cfg) => {
        const sess = (cfg.session as Record<string, unknown>) ?? {};
        sess.auditLevel = raw;
        cfg.session = sess;
      });
      return {
        message: `${color.green('✓')} audit level → ${color.cyan(raw)}   ${color.dim('restart to apply')}`,
      };
    }

    if (sub === 'thinking-word') {
      const raw = rest.join(' ').trim();
      if (!raw)
        return {
          message: `${color.amber('Usage:')} /settings thinking-word <word>   ${color.dim('single short word, e.g. "thinking", "vibing", "cooking"')}`,
        };
      if (raw.length > 16) return { message: `${color.red('Word too long')}: max 16 characters.` };
      await persistAutonomySetting(persistDeps, (autonomy) => {
        (autonomy as Record<string, unknown>).thinkingWord = raw;
      });
      return { message: `${color.green('✓')} thinking word → ${color.cyan(raw)}` };
    }

    if (sub === 'statusline') {
      const raw = (rest[0] ?? '').toLowerCase();
      const modes = ['minimum', 'detailed', 'no-color'];
      if (!modes.includes(raw))
        return {
          message: `${color.amber('Usage:')} /settings statusline minimum|detailed|no-color`,
        };
      await persistAutonomySetting(persistDeps, (autonomy) => {
        (autonomy as Record<string, unknown>).statuslineMode = raw;
      });
      return { message: `${color.green('✓')} statusline mode → ${color.cyan(raw)}` };
    }

    if (sub === 'read-symbols') {
      const raw = (rest[0] ?? '').toLowerCase();
      if (!['on', 'off'].includes(raw)) {
        return { message: `${color.amber('Usage:')} /settings read-symbols on|off` };
      }
      const on = raw === 'on';
      await persistAutonomySetting(persistDeps, (autonomy) => {
        (autonomy as Record<string, unknown>).readAdvancedMode = on;
      });
      if (opts.context?.meta) {
        opts.context.meta['tools.read.advancedMode'] = on;
      }
      return {
        message: `${color.green('✓')} read symbols → ${on ? color.cyan('on') : color.dim('off')}   ${color.dim(on ? 'codebase-index symbols will be included in read tool results' : 'read tool returns file content only')}`,
      };
    }

    if (sub === 'animation') {
      const raw = (rest[0] ?? '').toLowerCase();
      const styles = ['rainbow', 'wave', 'pulse', 'dots', 'breathe', 'static', 'cycle'];
      if (!styles.includes(raw))
        return {
          message: `${color.amber('Usage:')} /settings animation rainbow|wave|pulse|dots|breathe|static|cycle`,
        };
      await persistAutonomySetting(persistDeps, (autonomy) => {
        (autonomy as Record<string, unknown>).animationStyle = raw;
      });
      return { message: `${color.green('✓')} animation style → ${color.cyan(raw)}` };
    }

    return {
      message: `${color.red('Unknown setting')} "${sub}". ${unknownSubcommand(sub, ALL_SETTINGS_KEYS, 'settings')}`,
    };
  } catch (err) {
    return {
      message: `${color.red('Settings error')}: ${toErrorMessage(err)}`,
    };
  }
}
