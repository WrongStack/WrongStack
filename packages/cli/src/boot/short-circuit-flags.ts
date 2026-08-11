/**
 * --help / --version short-circuit — extracted from cli-main.ts.
 *
 * The baseline boot-shape test (PR 0 of Issue #29) showed that
 * `wstack --help` previously returned exit 2 because boot() ran
 * config I/O before reaching the help handler. This short-circuit
 * bypasses boot() entirely for informational flags.
 *
 * Returns the exit code (0) when a short-circuit fired, or null when
 * neither flag was present (caller should proceed to boot()).
 */
import { parseArgs } from '../arg-parser.js';
import { subcommandNames } from '../subcommands/index.js';
import { helpCmd, versionCmd } from '../subcommands/handlers/version-help.js';

/**
 * Check argv for --help / --version and dispatch directly.
 *
 * Returns 0 when a flag fired, or null when neither flag was present.
 * The renderer is a stub that writes to stdout — help text is plain
 * `write` calls, no TTY needed.
 *
 * When `--help` accompanies a known subcommand positional (e.g.
 * `wstack hq --help`), this defers to the subcommand dispatcher
 * (returns null) so the subcommand can print its own focused help.
 * `--version` always fires globally — the CLI version is not
 * subcommand-specific.
 */
export async function handleHelpVersionShortCircuit(argv: string[]): Promise<number | null> {
  const { flags: earlyFlags, positional } = parseArgs(argv);
  if (earlyFlags['help'] !== true && earlyFlags['version'] !== true) {
    return null;
  }

  // --help with a known subcommand positional: defer to boot's dispatcher.
  if (
    earlyFlags['help'] === true &&
    positional.length > 0 &&
    subcommandNames.includes(positional[0]!)
  ) {
    return null;
  }

  const stubRenderer = {
    write: (line: string) => {
      process.stdout.write(line);
    },
  } as never as Parameters<typeof helpCmd>[1]['renderer'];
  const handler = earlyFlags['help'] === true ? helpCmd : versionCmd;
  return await handler([], { renderer: stubRenderer } as Parameters<typeof helpCmd>[1]);
}
