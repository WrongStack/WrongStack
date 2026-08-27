/**
 * The identity-prompt picker surface: which variants exist, what each costs,
 * which one this session is running, and whether the user has ever chosen.
 *
 * `chosen` is the non-obvious field. The config loader materializes
 * `systemPrompt: { variant: 'default' }` for every config, so the live Config
 * cannot tell "the user picked Standard" from "nobody has ever asked". Only the
 * raw profile config file can — the key is written explicitly on selection — so
 * `chosen: false` is what lets the browser open the picker once on a fresh
 * install and never nag again. It is the same signal the CLI startup menu uses
 * to decide between the full menu and the one-line confirmation.
 */

import {
  countSystemPromptTokens,
  readSavedSystemPromptVariant,
  SYSTEM_PROMPT_VARIANT_OPTIONS,
  type SystemInstructionVariant,
  type SystemPromptVariantPaths,
} from '@wrongstack/core/agent';

/** Everything the picker needs from the host, injected so both WS hosts share it. */
export interface SystemPromptSurface {
  /** Instruction dirs, resolved the way the SystemPromptBuilder resolves them. */
  paths: () => SystemPromptVariantPaths;
  /** Active profile config — the file whose `systemPrompt.variant` marks a choice. */
  profileConfigPath: string;
  /** The variant the running session is currently built from. */
  current: () => SystemInstructionVariant;
  /**
   * Recompose the live system prompt for the new variant. Persistence is the
   * prefs layer's job; this only refreshes the in-memory prompt so the change
   * takes effect on the next turn instead of the next boot.
   */
  /**
   * Rebuild the live identity prompt. `sessionId` names the tab that asked —
   * each WebUI tab runs its own context, so the rebuild has to land on that
   * one rather than on whichever session the runtime is currently pointing at.
   */
  applyVariant?:
    | ((variant: SystemInstructionVariant, sessionId?: string) => void | Promise<void>)
    | undefined;
}

export interface SystemPromptVariantInfo {
  variant: SystemInstructionVariant;
  label: string;
  hint: string;
  /** Upper-bound token estimate of the identity block this variant injects. */
  tokens: number;
}

export interface SystemPromptInfoPayload {
  current: SystemInstructionVariant;
  /** False until the user has explicitly picked a variant at least once. */
  chosen: boolean;
  variants: SystemPromptVariantInfo[];
  /** Set when the token estimate could not be computed; variants still list. */
  error?: string | undefined;
}

/**
 * Compose the picker payload. Token counting reads the bundled/global/project
 * instruction files, so a failure there (unreadable override dir, for instance)
 * degrades to zero counts rather than denying the user the picker entirely.
 */
/**
 * The variant catalogue, plus which variant is live.
 *
 * The catalogue (labels, token costs, whether the user has ever chosen) is a
 * project fact and the same for every tab. `current` is NOT: the identity
 * variant is a per-session preference, so a tab that picked "lite" must not be
 * told it is on the "pro" another tab just selected. `currentOverride` carries
 * the asking session's own value; without one the config default stands, which
 * is what a single-session host wants.
 */
export async function buildSystemPromptInfo(
  surface: SystemPromptSurface,
  currentOverride?: string | undefined,
): Promise<SystemPromptInfoPayload> {
  let tokens: Partial<Record<SystemInstructionVariant, number>> = {};
  let error: string | undefined;
  try {
    tokens = await countSystemPromptTokens(surface.paths());
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  let chosen = false;
  try {
    chosen = (await readSavedSystemPromptVariant(surface.profileConfigPath)) !== undefined;
  } catch {
    chosen = false;
  }
  return {
    current: (currentOverride as SystemInstructionVariant | undefined) ?? surface.current(),
    chosen,
    variants: SYSTEM_PROMPT_VARIANT_OPTIONS.map((option) => ({
      variant: option.variant,
      label: option.label,
      hint: option.hint,
      tokens: tokens[option.variant] ?? 0,
    })),
    ...(error !== undefined ? { error } : {}),
  };
}

/** Payload for a host that never wired the picker — the browser hides it. */
export function unavailableSystemPromptInfo(): SystemPromptInfoPayload {
  return {
    current: 'default',
    chosen: true,
    variants: [],
    error: 'system prompt selection unavailable on this server',
  };
}
