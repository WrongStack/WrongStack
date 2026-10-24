/** `/settings` mutations for feature flags, fleet chat, loop limits, logging and TUI presentation. */

import type { FleetChatVerbosity } from '@wrongstack/contracts/types';
import { color } from '@wrongstack/core/utils';
import { persistAutonomySetting, persistConfigSetting } from '../settings-menu.js';
import type { SlashCommandContext } from './command-context.js';
import type { SettingsPersistDeps } from './settings-persist-deps.js';

/** Feature flag, fleet, iteration, logging and presentation keys. Returns undefined for a key it does not own. */
export async function executeFeatureAndUiSettings(
  sub: string,
  rest: string[],
  persistDeps: SettingsPersistDeps,
  opts: SlashCommandContext,
  _activeProfile: string,
): Promise<{ message: string } | undefined> {
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

  if (sub === 'tool-coach') {
    const raw = (rest[0] ?? '').toLowerCase();
    if (!['on', 'off'].includes(raw))
      return { message: `${color.amber('Usage:')} /settings tool-coach on|off` };
    const on = raw === 'on';
    await persistConfigSetting(persistDeps, (cfg) => {
      const feats = (cfg.features as Record<string, unknown>) ?? {};
      feats.toolCoach = on;
      cfg.features = feats;
    });
    return {
      message: `${color.green('✓')} Tool Coach → ${on ? color.cyan('on') : color.dim('off')}   ${color.dim('applies to the next task')}`,
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
    const value = raw.trim();
    const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(n) || n < 0)
      return {
        message: `${color.red('Invalid number')}: "${raw}". Enter a non-negative integer.`,
      };
    await persistConfigSetting({ ...persistDeps, forceGlobal: true }, (cfg) => {
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
    const value = raw.trim();
    const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(n) || n < 0)
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
  return undefined;
}
