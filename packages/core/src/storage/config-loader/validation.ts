import {
  DEFAULT_CONTEXT_WINDOW_MODE_ID,
  isContextWindowModeSelectionId,
  listContextWindowModes,
  normalizeContextWindowModeId,
} from '../../types/context-window.js';
import { ConfigError, ERROR_CODES } from '../../types/errors.js';
import type { PartialConfig } from './env-overrides.js';

type LogWarn = (msg: string, ctx?: Record<string, unknown>) => void;

export function validateConfigBehavior(cfg: PartialConfig, logWarn: LogWarn): void {
  /* v8 ignore start -- defensive: config defaults always seed version:1 before validation */
  if (cfg.version === undefined)
    throw new ConfigError({
      message: 'Config: missing version field',
      code: ERROR_CODES.CONFIG_INVALID,
      context: { field: 'version' },
    });
  /* v8 ignore stop */
  if (cfg.version !== 1)
    throw new ConfigError({
      message: `Config: unsupported version ${cfg.version}`,
      code: ERROR_CODES.CONFIG_INVALID,
      context: { field: 'version', actual: cfg.version },
    });
  const c = cfg.context;
  if (!c)
    throw new ConfigError({
      message: 'Config: missing context section',
      code: ERROR_CODES.CONFIG_INVALID,
      context: { field: 'context' },
    });

  const fields: Array<keyof typeof c> = ['warnThreshold', 'softThreshold', 'hardThreshold'];
  for (const f of fields) {
    const v = c[f];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new ConfigError({
        message: `Config: context.${String(f)} must be a finite number (got ${typeof v})`,
        code: ERROR_CODES.CONFIG_INVALID,
        context: { field: `context.${String(f)}`, actualType: typeof v },
      });
    }
  }
  if (c.warnThreshold >= c.softThreshold || c.softThreshold >= c.hardThreshold) {
    throw new ConfigError({
      message: 'Config: context thresholds must satisfy warn < soft < hard',
      code: ERROR_CODES.CONFIG_INVALID,
      context: { warn: c.warnThreshold, soft: c.softThreshold, hard: c.hardThreshold },
    });
  }
  if (c.mode !== undefined && !isContextWindowModeSelectionId(c.mode)) {
    const known = listContextWindowModes()
      .map((m) => m.id)
      .join(', ');
    logWarn(
      `Ignoring unknown context.mode "${c.mode}" — falling back to "${DEFAULT_CONTEXT_WINDOW_MODE_ID}"`,
      { event: 'config.unknown_context_mode', mode: c.mode, known },
    );
    c.mode = DEFAULT_CONTEXT_WINDOW_MODE_ID;
  } else if (c.mode !== undefined) {
    c.mode = normalizeContextWindowModeId(c.mode) ?? DEFAULT_CONTEXT_WINDOW_MODE_ID;
  }

  // Sage.embeddings.enabled is reserved for a future durable vector index /
  // external embed API. Soft hybrid re-rank (offline hashing) already runs on
  // multi-token searches without this flag — no warning required.
}

export function validateConfigIdentity(cfg: PartialConfig): void {
  if (!cfg.provider) {
    throw new ConfigError({
      message: 'Config: no provider configured. Run `wstack init` or set WRONGSTACK_PROVIDER.',
      code: ERROR_CODES.CONFIG_INVALID,
      context: { field: 'provider' },
    });
  }
  if (!cfg.model) {
    throw new ConfigError({
      message: 'Config: no model configured. Run `wstack init` or set WRONGSTACK_MODEL.',
      code: ERROR_CODES.CONFIG_INVALID,
      context: { field: 'model' },
    });
  }
}
