/**
 * `--goal` / `--ask` without a prompt run in the TUI (`--no-tui` still wins).
 *
 * Decided in `boot`, before the composition root reads `flags.tui`: this used
 * to happen in execution.ts, after cli-main had already derived screen
 * ownership and the HQ client kind from it — a goal run painted the TUI but
 * announced itself to HQ as `cli`, with non-TUI stderr behaviour.
 */
export function applyGoalTuiDefault(
  flags: Record<string, string | boolean>,
  positional: readonly string[],
): void {
  const prompt = flags['prompt'];
  if (
    (typeof flags['goal'] === 'string' || typeof flags['ask'] === 'string') &&
    positional.length === 0 &&
    !(typeof prompt === 'string' && prompt.length > 0)
  ) {
    flags['tui'] = true;
  }
}
