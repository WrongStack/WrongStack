/**
 * The CLI's outermost entry.
 *
 * This module exists to keep the interactive graph out of the boot graph.
 * `initializeCli()` handles everything that can short-circuit — `--help`,
 * `--hq`, and every `wstack <subcommand>` — and returns a plain
 * exit code in those cases. Only when it returns a live `CliContext` does the
 * session actually need the interactive machinery.
 *
 * `cli-main.ts` delegates to boot, orchestration, and execution builders.
 * Their transitive dependencies include the interactive domains and host
 * integrations; keeping that graph behind the dynamic import lets short-lived
 * commands finish without loading it. The boundary is about the transitive
 * graph, not the number of direct imports in the orchestrator.
 *
 * IMPORTANT: this boundary only works because `@wrongstack/cli` is built with
 * `splitting: true` (scripts/build-package.mjs). With splitting off, esbuild
 * inlines the dynamically imported module into the same output file and hoists
 * its external imports to the top — the `await import()` below would then defer
 * nothing at all. `packages/cli/tests/architecture/boot-graph-boundary.test.ts`
 * pins both halves of that contract.
 */
import { parseArgs } from './arg-parser.js';
import { shouldCaptureTuiStartup, startTuiStartupOutput } from './boot/tui-startup-output.js';
import { applyNodeEnvDefault, applySessionShellDefault } from './preflight.js';

export async function main(argv: string[]): Promise<number> {
  // Pre-boot side effects, in the same order (and with the same idempotency)
  // initializeCli() applies them. The NODE_ENV default is pinned on the
  // --help path by cli-main-flag-content.test.ts, so it must run before ANY
  // short-circuit returns — including the informational-flag one below.
  applyNodeEnvDefault();
  applySessionShellDefault();

  // --help / --version print text and exit; they need none of the boot graph.
  // cli-context.ts statically imports boot.ts (@wrongstack/runtime, the core
  // model/registry barrels, picker, pre-launch, the full subcommand
  // registry), so importing it before knowing what was asked put ~510ms of
  // module load on every invocation. Route the two informational flags
  // through a dynamic import BEFORE cli-context.js is fetched;
  // initializeCli keeps its own short-circuit for direct callers and for
  // every other flag.
  const earlyFlags = parseArgs(argv).flags;
  // `--ascii` wraps stdout before anything prints (help included). Loaded
  // only when asked for, so the default path keeps its module budget.
  if (earlyFlags['ascii'] === true || process.env['WRONGSTACK_TUI_ICON_STYLE']) {
    const { applyAsciiMode } = await import('./boot/ascii-mode.js');
    applyAsciiMode(earlyFlags);
  }
  if (earlyFlags['help'] === true || earlyFlags['version'] === true) {
    const { handleHelpVersionShortCircuit } = await import('./boot/short-circuit-flags.js');
    const earlyExit = await handleHelpVersionShortCircuit(argv);
    if (earlyExit !== null) return earlyExit;
  }

  const parsed = parseArgs(argv);
  const startupOutput = startTuiStartupOutput(
    shouldCaptureTuiStartup(parsed.flags, parsed.positional),
  );
  try {
    const { initializeCli } = await import('./cli-context.js');
    const cliCtx = await initializeCli(argv, {
      onNonTuiLaunch: () => startupOutput.stop(),
    });
    // A number means a short-circuit flag or a subcommand already ran to
    // completion; the interactive stack is never touched.
    if (typeof cliCtx === 'number') return cliCtx;

    if (cliCtx.flags['tui'] === true && cliCtx.flags['no-tui'] !== true) {
      startupOutput.acceptTui(cliCtx.logger);
    } else {
      startupOutput.stop();
    }

    const { runInteractive } = await import('./cli-main.js');
    return await runInteractive(cliCtx);
  } finally {
    startupOutput.stop();
  }
}
