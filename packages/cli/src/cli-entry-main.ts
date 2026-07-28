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
import { initializeCli } from './cli-context.js';

export async function main(argv: string[]): Promise<number> {
  const cliCtx = await initializeCli(argv);
  // A number means a short-circuit flag or a subcommand already ran to
  // completion; the interactive stack is never touched.
  if (typeof cliCtx === 'number') return cliCtx;

  const { runInteractive } = await import('./cli-main.js');
  return runInteractive(cliCtx);
}
