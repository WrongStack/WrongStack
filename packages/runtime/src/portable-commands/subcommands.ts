/**
 * Generate a consistent "unknown subcommand" message for the `default` branch
 * of a subcommand switch.
 *
 *   unknownSubcommand('frobulate', ['status', 'kill', 'usage'], 'fleet')
 *   // -> 'Unknown subcommand "frobulate" for /fleet. Valid: status, kill, usage.'
 */
export function unknownSubcommand(cmd: string, valid: string[], name?: string): string {
  const list = valid.join(', ');
  return name
    ? `Unknown subcommand "${cmd}" for /${name}. Valid: ${list}.`
    : `Unknown subcommand "${cmd}". Valid: ${list}.`;
}
