import type { Config } from '../types/config.js';
import type { Logger } from '../types/logger.js';

export interface FallbackManageToolOptions {
  /** Returns the live config (re-read each call so changes are honored). */
  getConfig: () => Config;
  /**
   * Persist config mutations and let the host mirror the result into its
   * in-memory store.
   */
  updateConfig: (mutate: (cfg: Record<string, unknown>) => void) => Promise<void>;
  /** Optional secure interactive input callback for secrets such as API keys. */
  requestInput?: ((prompt: string) => Promise<string>) | undefined;
  /** Optional logger for internal warnings. */
  logger?: Logger | undefined;
}
