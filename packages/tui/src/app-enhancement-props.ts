export interface TuiEnhancementProps {
  /**
   * When true, free-text prompts are run through the prompt refiner
   * ("did you mean this?") before reaching the main agent. Default on;
   * toggled live via the `/enhance` slash command + `enhanceController`.
   */
  enhanceEnabled?: boolean | undefined;
  /**
   * Shared controller for the `/enhance on|off` toggle. The TUI rebinds
   * `setEnabled` on mount to a dispatch-backed setter so the slash command
   * (handled in the CLI) flips the reducer flag. Mirrors `fleetStreamController`.
   */
  enhanceController?:
    | {
        enabled: boolean;
        setEnabled: (enabled: boolean) => void;
      }
    | undefined;
  /**
   * When true (default), submitting a plain message while the agent is busy
   * pops the send-mode picker (queue / by-the-way / steer) instead of silently
   * queueing. Toggled live via `/queue picker on|off`; persisted to
   * `autonomy.midRunSendPicker`.
   */
  midRunSendPicker?: boolean | undefined;
  /** Auto-send countdown (ms) for the refinement preview panel. Default 4000. */
  enhanceDelayMs?: number | undefined;
  /**
   * Returns a capability-gated low-effort reasoning hint for the prompt
   * refiner (or undefined when nothing can be safely reduced). Forwarded to
   * `enhanceUserPrompt` so a slow reasoning model does not burn thinking
   * tokens on this shallow rewrite. Absent → the refiner sends no reasoning
   * field, exactly as before.
   */
  getEnhancerReasoning?:
    | ((
        providerId?: string,
        modelId?: string,
      ) =>
        | import('@wrongstack/contracts/types').ReasoningRequest
        | undefined
        | Promise<import('@wrongstack/contracts/types').ReasoningRequest | undefined>)
    | undefined;
  /**
   * Effort levels the ACTIVE model documents (models.dev reasoningConfig),
   * for the model-aware /settings reasoning-effort cycle (WebUI parity).
   * Undefined = vocabulary undocumented; the picker cycles the full set.
   */
  getActiveModelReasoningEffortLevels?: (() => string[] | undefined) | undefined;
  /**
   * Build a Provider for a (providerId, modelId) pair WITHOUT switching the
   * session — used to retry a failed refinement on the fallback/another model
   * ephemerally. Returns undefined when the host can't build the provider
   * (missing key, unknown id), in which case that recovery option is skipped.
   */
  buildEnhancerProvider?:
    | ((
        providerId: string,
        modelId: string,
      ) => Promise<import('@wrongstack/contracts/types').Provider | undefined>)
    | undefined;
  /**
   * Resolve the one-key "retry with another model" fallback ref
   * (`provider/model`) offered on a refine failure, or undefined when none is
   * configured/derivable. Recomputed per call so `/fallback` and `/model`
   * changes are reflected.
   */
  getEnhanceFallbackRef?: (() => string | undefined) | undefined;
  /** Resolve the dedicated refiner target (`provider/model`) for the initial attempt. */
  getConfiguredRefinerRef?: (() => string | undefined) | undefined;
}
