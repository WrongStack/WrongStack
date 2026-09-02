/**
 * Thin back-compat re-export — the canonical implementation lives in
 * `@wrongstack/tools/next-steps` and is shared by the TUI, CLI, and WebUI.
 *
 * @deprecated import from `@wrongstack/tools/next-steps` directly. This
 * back-compat shim will be removed in the next minor release.
 */
export {
  parseNextSteps,
  stripNextStepsBlock,
  type ParsedNextStep,
  type ParseNextStepsResult,
} from '@wrongstack/tools/next-steps';
