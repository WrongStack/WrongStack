import type { EventBus } from '../event-bus-port.js';
import type { Config } from '../../types/config.js';
import type { Logger } from '../../types/logger.js';
import type { SecretVault } from '../../types/secret-vault.js';
import type { WstackPaths } from '../../utils/wstack-paths.js';
import type { PartialConfig } from './env-overrides.js';

/**
 * A single config source. Higher priority wins in merges.
 * Sources are applied in priority order (lowest first), so a source
 * with priority=10 overrides one with priority=1.
 */
export interface ConfigSource {
  /** Unique name for debugging and error messages. */
  name: string;
  /** Lower numbers merge first, higher numbers override lower. Default: 50. */
  priority?: number | undefined;
  /**
   * Read the raw config patch. Return an empty object if unavailable.
   * Errors are surfaced but do not abort loading - the source is skipped.
   */
  read(): Promise<Partial<Config>>;
}

export interface ConfigLoaderOptions {
  paths: WstackPaths;
  strict?: boolean | undefined;
  vault?: SecretVault | undefined;
  /** Extra sources merged after the built-in layers. */
  sources?: ConfigSource[] | undefined;
  events?: EventBus;
  traceId?: string;
  /** Logger for structured warning/error events. When omitted, falls back to console.warn. */
  logger?: Logger | undefined;
}

export interface MemoizedConfigSource {
  mtimeMs: number | null;
  value: PartialConfig;
}
