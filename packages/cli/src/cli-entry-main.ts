/**
 * The CLI's outermost entry.
 *
 * This module exists to keep the interactive graph out of the boot graph.
 * `initializeCli()` handles everything that can short-circuit — `--help`,
 * `--desktop`, `--hq`, and every `wstack <subcommand>` — and returns a plain
 * exit code in those cases. Only when it returns a live `CliContext` does the
 * session actually need the interactive machinery.
 *
 * That machinery is large: `cli-main.ts` statically imports ~30 wiring modules,
 * which transitively reach `@wrongstack/sdd`, `/acp`, `/sage`, `/mcp` and
 * `/security-scanner` — measured at 21, 21, 20, 11 and 7.5MB RSS respectively.
 * Measured with the static edge in place, the CLI's always-loaded graph was 270
 * modules; `cli-context.ts` and `boot.ts` on their own reach 64 and 31 modules
 * and NONE of those five packages. So `wstack version` and
 * `wstack mailbox serve` were paying for the whole interactive stack.
 *
 * IMPORTANT: this boundary only works because `@wrongstack/cli` is built with
 * `splitting: true` (scripts/build-package.mjs). With splitting off, esbuild
 * inlines the dynamically imported module into the same output file and hoists
 * its external imports to the top — the `await import()` below would then defer
 * nothing at all. `packages/cli/tests/architecture/boot-graph-boundary.test.ts`
 * pins both halves of that contract.
 */
import { parseArgs } from './arg-parser.js';
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
  if (earlyFlags['help'] === true || earlyFlags['version'] === true) {
    const { handleHelpVersionShortCircuit } = await import('./boot/short-circuit-flags.js');
    const earlyExit = await handleHelpVersionShortCircuit(argv);
    if (earlyExit !== null) return earlyExit;
  }

  const { initializeCli } = await import('./cli-context.js');
  const cliCtx = await initializeCli(argv);
  // A number means a short-circuit flag or a subcommand already ran to
  // completion; the interactive stack is never touched.
  if (typeof cliCtx === 'number') return cliCtx;

  const { runInteractive } = await import('./cli-main.js');
  return runInteractive(cliCtx);
}
