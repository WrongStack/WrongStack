import type { ProviderAuthRegistry } from '@wrongstack/core/registry';
import type { ModelsRegistry, SecretScrubber, SecretVault } from '@wrongstack/core/types';

/**
 * Minimal output surface the auth-menu flows need. `TerminalRenderer`
 * satisfies this structurally, and so does the TUI auth-panel adapter
 * (which forwards each line into the panel's flow log) — keeping the
 * flows reusable from both the readline CLI and the Ink TUI.
 */
interface AuthMenuRenderer {
  write(input: string): void;
  writeInfo(text: string): void;
  writeWarning(text: string): void;
  writeError(text: string): void;
}

/**
 * Minimal input surface the auth-menu flows need. `ReadlineInputReader`
 * satisfies this structurally; the TUI adapter resolves both from the
 * panel's modal prompt (masked for `readSecret`). Implementations may
 * REJECT to cancel the surrounding flow (the TUI does this on Esc) —
 * every flow treats a thrown prompt as user-cancel.
 */
interface AuthMenuReader {
  readLine(prompt?: string): Promise<string>;
  readSecret(prompt: string): Promise<string>;
}

/**
 * Dependencies shared across all auth-menu modules.
 * Kept deliberately light — each sub-module takes only the subset it needs.
 */
export interface AuthMenuDeps {
  renderer: AuthMenuRenderer;
  reader: AuthMenuReader;
  modelsRegistry: ModelsRegistry;
  vault: SecretVault;
  /** Active profile config path. Provider credentials never use the root bootstrap. */
  profileConfigPath: string;
  /** Shared registry when the runtime is active; defaults to the built-in strategies. */
  providerAuthRegistry?: ProviderAuthRegistry | undefined;
  /**
   * Optional scrubber used by `wstack auth local` to redact Bearer
   * tokens from probe logs before they reach the renderer. Falls back
   * to a fresh {@link DefaultSecretScrubber} when not supplied.
   */
  secretScrubber?: SecretScrubber | undefined;
}
