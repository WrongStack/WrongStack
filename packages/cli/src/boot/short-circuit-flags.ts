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
import { helpCmd, versionCmd } from '../subcommands/handlers/version-help.js';

// `per-subcommand-help.js` (the deep-help table) and `subcommands/index.js`
// (the full subcommand registry) are deliberately NOT static imports here.
// cli-entry-main.ts routes --help/--version to this module BEFORE the boot
// graph loads; static registry imports would put that graph right back on
// the `wstack --version` fast path. Both are only needed for a
// subcommand-focused help (`wstack auth --help`), so they load lazily there.

/**
 * Check argv for --help / --version and dispatch directly.
 *
 * Returns 0 when a flag fired, or null when neither flag was present.
 * The renderer is a stub that writes to stdout — help text is plain
 * `write` calls, no TTY needed.
 *
 * When `--help` accompanies a known subcommand positional (e.g.
 * `wstack hq --help` or `wstack mcp add --help`), this renders the
 * focused / deep help directly for instantaneous output.
 * `--version` always fires globally — the CLI version is not
 * subcommand-specific.
 */
export async function handleHelpVersionShortCircuit(argv: string[]): Promise<number | null> {
  const { flags: earlyFlags, positional } = parseArgs(argv);
  if (earlyFlags['help'] !== true && earlyFlags['version'] !== true) {
    return null;
  }

  const stubRenderer = {
    write: (line: string) => {
      process.stdout.write(line);
    },
  } as never as Parameters<typeof helpCmd>[1]['renderer'];

  if (earlyFlags['version'] === true) {
    return await versionCmd([], { renderer: stubRenderer } as Parameters<typeof versionCmd>[1]);
  }

  if (earlyFlags['help'] === true) {
    if (positional.length > 0) {
      const { subcommandNames } = await import('../subcommands/index.js');
      if (subcommandNames.includes(positional[0]!)) {
        const first = positional[0]!;
        const deep = positional[1];
        const { renderDeepHelp, renderFocusedHelp } = await import(
          '../subcommands/handlers/per-subcommand-help.js'
        );
        if (deep && renderDeepHelp(`${first}:${deep}`, stubRenderer)) {
          return 0;
        }
        if (renderFocusedHelp(first, stubRenderer)) {
          return 0;
        }
      }
    }
    return await helpCmd([], { renderer: stubRenderer } as Parameters<typeof helpCmd>[1]);
  }

  return null;
}

