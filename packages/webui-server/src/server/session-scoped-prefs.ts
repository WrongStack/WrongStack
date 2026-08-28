/**
 * The preference keys that belong to a CONVERSATION, not the project.
 *
 * A leaf module on purpose: this is a plain constant that both the preference
 * handlers and the per-tab agent registry need, and importing it from
 * `prefs-handlers.ts` dragged that module's dependencies (`@wrongstack/tools`
 * among them) into every consumer's module graph.
 *
 * @module session-scoped-prefs
 */

/**
 * Preferences that belong to ONE session rather than to the process.
 *
 * Every WebUI tab runs its own session with its own agent context, so these
 * have to land on the calling tab's meta bag: flipping yolo in tab 3 must not
 * hand tab 1's run blanket tool approval, and a context strategy chosen for a
 * long refactor tab must not re-shape a quick question in the tab beside it.
 *
 * Everything NOT listed here (locale, ports, HQ, telegram, feature flags,
 * breaker, proxy, log level…) is genuinely process-wide and keeps its single
 * global home.
 *
 * The browser half is `SESSION_SCOPED_PREFS` in
 * `webui/src/stores/local-prefs.ts`; the two sets must be identical and
 * `webui/tests/server/session-scoped-prefs-parity.test.ts` enforces it.
 */
export const SESSION_SCOPED_PREF_KEYS: ReadonlySet<string> = new Set([
  'autonomy',
  'autonomyDelayMs',
  'autoProceedMaxIterations',
  'yolo',
  'maxIterations',
  'contextStrategy',
  'contextMode',
  'contextAutoCompact',
  'tokenSavingTier',
  'systemPromptVariant',
  'reasoningMode',
  'reasoningEffort',
  'reasoningPreserve',
  'nextPrediction',
  'nextStepsTool',
]);
