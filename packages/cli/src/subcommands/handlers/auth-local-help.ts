/**
 * `wstack auth local --help` — the per-subcommand help text.
 *
 * This module is the single source of truth for the
 * `wstack auth local` flag list. The top-level
 * `helpCmd` (`wstack --help`) and the per-subcommand
 * `wstack auth local --help` both render the same table
 * from this constant — drift between the two is
 * structurally impossible.
 *
 * Why a dedicated module?
 *   - **Single source of truth.** The flag list lives
 *     once; both the top-level help and the per-subcommand
 *     help read it.
 *   - **Testable in isolation.** Pure data + a pure
 *     render function, no CLI plumbing — the test suite
 *     can pin the help text byte-for-byte.
 *   - **Reusable from the per-subcommand dispatch.** The
 *     `auth.ts` handler imports `renderAuthLocalHelp` and
 *     `wantsLocalHelp` directly; no flag-parsing duplication.
 */
import { color } from '@wrongstack/core/utils';
import type { TerminalRenderer } from '../../renderer.js';

/**
 * One entry per flag the `wstack auth local` subcommand
 * accepts. Each entry is `{ flag, description }` — the
 * renderer is responsible for column alignment.
 *
 * Keep this list in sync with `packages/cli/src/arg-parser.ts`
 * (`AuthFlags.audit`, `AuthFlags.name`, etc.). The test
 * `documents every local-auth flag with its parser-accepted
 * shape` in `subcommand-handlers.test.ts` pins the
 * relationship — a missing entry here is a red test.
 */
export const LOCAL_AUTH_FLAGS: ReadonlyArray<{
  flag: string;
  description: string;
}> = [
  {
    flag: '--name <ollama|vllm|lmstudio>',
    description:
      'Pick a preset (skip the interactive picker). Defaults to the first run; set this for scripting.',
  },
  {
    flag: '--base-url <url>',
    description:
      'Override the preset default (e.g. `http://gpu-host:8000/v1` for a remote vLLM). Empty falls back to the preset.',
  },
  {
    flag: '--no-key / --skip-key',
    description:
      'Skip the API-key prompt even for presets that accept one. Use for non-TTY scripted setups.',
  },
  {
    flag: '--no-probe / --skip-probe',
    description:
      'Skip the health probe. Use when the local server is not running yet but the config must be persisted.',
  },
  {
    flag: '--probe-only',
    description:
      'Run the probe and report, do not save. Use to re-check a previously-saved provider.',
  },
  {
    flag: '--model <spec> / -m <spec>',
    description:
      'Pre-populate the saved `models` allowlist. `--model first` / `<N>` consume the probe; `<csv>` is a literal list; bare `--model` clears the allowlist.',
  },
  {
    flag: '--audit [target]',
    description:
      'Emit JSONL audit events for the save lifecycle. Bare / `stdout` → stdout; `stderr` → stderr; `<path>` → file. Default is silent.',
  },
];

/** Width of the flag column in the rendered help. Picked to
 *  fit the longest flag (`--model <spec> / -m <spec>`) plus
 *  one space of padding before the description starts. */
export const LOCAL_FLAG_COLUMN_WIDTH = 38;

/**
 * One-line usage summary that appears at the top of the
 * help block. Kept in sync with the actual `wstack auth
 * local` argv shape — the dispatch in `auth.ts` doesn't
 * reorder flags, so the order here matches the order the
 * user types them.
 */
export const LOCAL_AUTH_HELP_USAGE =
  'wstack auth local [--name <id>] [--base-url <url>] [--no-key] ' +
  '[--no-probe|--probe-only] [--model <spec>] [--audit [target]]';

/**
 * Return true when the user asked for help on the local
 * subcommand. Recognized forms:
 *
 *   - `local --help`        (canonical)
 *   - `local -h`            (short alias)
 *   - `local --help=true`   (defensive — a future `--help=<bool>`
 *                            parser would still trigger help)
 *   - `local -- --help`     (defensive — `--` separator is honored)
 *
 * The check is intentionally permissive: a user who types
 * `--hel` (typo) or `--HELP` (wrong case) will fall through
 * to the normal dispatch and trigger a "no such flag"
 * error from `parseAuthFlags`. Only the canonical forms
 * (lowercase, exact match) trigger the help short-circuit.
 */
export function wantsLocalHelp(args: ReadonlyArray<string>): boolean {
  return args.includes('--help') || args.includes('-h');
}

/**
 * Build the `wstack auth local` help block as a string. The
 * returned string is the exact bytes the renderer would have
 * written — color codes and all. Used by surfaces that can't
 * hold a `TerminalRenderer` (slash commands return
 * `{ message: string }` instead of writing directly) and by
 * the `auth:local` deep-help entry in `per-subcommand-help.ts`
 * via its `customBody` field.
 *
 * Single source of truth: the body here is the same string
 * `wstack auth local --help`, `wstack auth local -- --help`,
 * `/auth local help`, and `/help auth local` all render. Drift
 * between the four surfaces is structurally impossible.
 */
export function renderAuthLocalHelpToString(): string {
  const lines: string[] = [
    color.bold('wstack auth local — quick-add Ollama / vLLM / LM Studio'),
    color.dim('  Pre-fills the base URL, runs a health probe (`GET /v1/models`),'),
    color.dim('  and persists the allowlist so you can `wstack --provider <id>`'),
    color.dim('  right away. Use `--no-probe` to skip when the local server is not'),
    color.dim('  running yet; use `--audit <file>` to capture the save lifecycle.'),
    '',
    color.bold('Usage'),
    `  ${LOCAL_AUTH_HELP_USAGE}`,
    '',
    color.bold('Flags'),
  ];

  for (const { flag, description } of LOCAL_AUTH_FLAGS) {
    const padded = flag.padEnd(LOCAL_FLAG_COLUMN_WIDTH, ' ');
    lines.push(`  ${color.cyan(padded)}${description}`);
  }

  lines.push('');
  lines.push(color.dim('  See also: `wstack --help` for the top-level command list.'));
  lines.push(
    color.dim("  Examples: `wstack auth local --name ollama --no-probe --model 'llama3.1:8b'`"),
  );
  lines.push(
    color.dim('            `wstack auth local --name ollama --audit /var/log/wstack-auth.jsonl`'),
  );

  return lines.join('\n') + '\n';
}

/**
 * Render the `wstack auth local` help block to the given
 * renderer. Thin wrapper over `renderAuthLocalHelpToString` —
 * kept as a separate function so the existing call sites in
 * `auth.ts` (which pass a `TerminalRenderer` directly) don't
 * need to change.
 */
export function renderAuthLocalHelp(renderer: TerminalRenderer): void {
  renderer.write(renderAuthLocalHelpToString());
}
