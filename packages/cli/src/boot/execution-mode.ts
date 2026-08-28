/**
 * Canonical execution-surface selection for the CLI composition root.
 *
 * Keep precedence here instead of duplicating flag checks across boot tests,
 * launchers, and execute(): a one-shot prompt owns the process, WebUI owns
 * stdout when requested alongside TUI, and --no-tui falls back to REPL.
 */
type ExecutionMode = 'single-shot' | 'tui' | 'webui' | 'repl';

export function resolveExecutionMode(
  positional: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): ExecutionMode {
  const prompt = typeof flags['prompt'] === 'string' ? flags['prompt'] : '';
  if (positional.length > 0 || prompt.length > 0) return 'single-shot';
  if (flags.tui && flags['no-tui'] !== true && !flags.webui && !flags['webui-session-child'])
    return 'tui';
  if (flags.webui || flags['webui-session-child']) return 'webui';
  return 'repl';
}
