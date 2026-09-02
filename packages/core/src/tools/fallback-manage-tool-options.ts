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
  /**
   * Optional live provider/model switch (the host's switchProviderAndModel).
   * When present, `leader_model_set` routes leader changes through it so the
   * live agent context (provider instance, model, context caps) follows the
   * config write. Returns an error string on failure, null on success —
   * mirroring cli-main's switch callback. When absent, the tool persists the
   * config and reports that the live session keeps its current model.
   */
  switchProviderAndModel?:
    | ((providerId: string, modelId: string) => Promise<string | null>)
    | undefined;
  /** Optional logger for internal warnings. */
  logger?: Logger | undefined;
}
