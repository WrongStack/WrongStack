import { color } from '@wrongstack/core/utils';
import type { TerminalRenderer } from '../../renderer.js';

/**
 * Per-flag help data for `wstack bench run`.
 *
 * The `BENCH_RUN_FLAGS` array is the **single source of truth** for
 * the `wstack bench run` flag list. It's consumed by:
 *
 *   - This file's `renderBenchRunHelpToString()` (renders the
 *     column-aligned help block)
 *   - `packages/cli/src/subcommands/handlers/bench.ts`'s
 *     `benchRun()` function (parses the flags — see the
 *     `flagStr` / `flagBool` reads there)
 *   - The `bench:run` deep-help entry in
 *     `per-subcommand-help.ts` via its `customBody` field
 *     (delivers the rendered block to every help surface)
 *
 * Adding a new flag to `wstack bench run` is a one-line change
 * here; the parser picks it up automatically and the help block
 * re-renders with the new flag in place. Drift between the
 * three surfaces is structurally impossible.
 *
 * The flags are organized into three semantic groups:
 *
 *   - **Suite selection** — which benchmark suite to run, plus
 *     suite-specific flags (`--suite`, `--polyglot-dir`,
 *     `--languages`, `--dataset-dir`, `--docker`)
 *   - **Model matrix** — which model cells to evaluate
 *     (`--models`)
 *   - **Run control** — scaling and output (`--limit`, `--out`,
 *     `--concurrency`)
 *
 * The grouping is reflected in the `group` field of each entry,
 * which the renderer uses to print a "Flags" section with
 * subheaders ("Suite selection:", "Model matrix:", "Run control:")
 * so the help block reads top-to-bottom in the order a user
 * would configure a run.
 *
 * The `kind` field discriminates the parser behavior:
 *
 *   - `'boolean'` — the flag accepts `--flag` (sets to true).
 *     The parser uses `flagBool(deps, name)` to read these.
 *   - `'value'` — the flag accepts a value (`--flag <value>`).
 *     The parser reads these via `flagStr(deps, name)` directly.
 */
type BenchRunFlagGroup = 'suite' | 'models' | 'control';

interface BenchRunFlag {
  /** The flag's canonical name (no `--` prefix, no value placeholder). */
  name: string;
  /**
   * The display form, with the `--` prefix and any value
   * placeholder. For boolean flags, the renderer shows just
   * `--flag` (no `--no-flag` counterpart — `bench run` flags
   * are positive-only).
   */
  flag: string;
  /** One-line description shown in the help block. */
  description: string;
  /** Which semantic group the flag belongs to. */
  group: BenchRunFlagGroup;
  /** Parser shape: `boolean` for toggles, `value` for `--flag <v>`. */
  kind: 'boolean' | 'value';
  /**
   * Default value (only for value-kind flags). Rendered in the
   * description as `(default: <value>)`. The parser's default
   * behavior matches — both surfaces stay in sync because the
   * description is data-driven from the same source.
   */
  defaultValue?: string;
  /**
   * When `true`, the flag is required (the parser errors out
   * if it's missing). Rendered as "(required)" in the
   * description. Only meaningful for value-kind flags.
   */
  required?: boolean;
}

/**
 * The flag list — the canonical source of truth for
 * `wstack bench run`. Order matters: it's the order the flags
 * render in the help block.
 */
export const BENCH_RUN_FLAGS: ReadonlyArray<BenchRunFlag> = [
  // -- Suite selection ------------------------------------------------
  {
    name: 'suite',
    flag: '--suite <id>',
    description: 'Benchmark suite id (`core`, `smoke`, `local`, `polyglot`, or `swebench`).',
    group: 'suite',
    kind: 'value',
    defaultValue: 'core',
  },
  {
    name: 'polyglot-dir',
    flag: '--polyglot-dir <path>',
    description: 'Path to the Aider polyglot dataset (required when --suite polyglot).',
    group: 'suite',
    kind: 'value',
  },
  {
    name: 'languages',
    flag: '--languages <csv>',
    description: 'Comma-separated language list to filter the polyglot suite (e.g. `python,go`).',
    group: 'suite',
    kind: 'value',
  },
  {
    name: 'dataset-dir',
    flag: '--dataset-dir <path>',
    description:
      'Path to the SWE-bench Verified dataset (optional, defaults to the official cache).',
    group: 'suite',
    kind: 'value',
  },
  {
    name: 'docker',
    flag: '--docker',
    description: 'Enable the SWE-bench Docker runtime (required for live grading).',
    group: 'suite',
    kind: 'boolean',
  },
  {
    name: 'suite-dir',
    flag: '--suite-dir <path>',
    description: 'Directory containing bench.local.json (required when --suite local).',
    group: 'suite',
    kind: 'value',
  },
  {
    name: 'manifest',
    flag: '--manifest <file>',
    description: 'Explicit local-manifest path (alternative to --suite-dir).',
    group: 'suite',
    kind: 'value',
  },
  // -- Model matrix ---------------------------------------------------
  {
    name: 'models',
    flag: '--models <config>',
    description:
      'Path to the model-cells config (JSON). Optional when --cell or a saved model is set.',
    group: 'models',
    kind: 'value',
    defaultValue: 'bench.config.json',
  },
  {
    name: 'cell',
    flag: '--cell <spec>',
    description:
      'Comma-separated model cells (`provider/model` or `label=provider/model`). Skips the config file.',
    group: 'models',
    kind: 'value',
  },
  // -- Run control ----------------------------------------------------
  {
    name: 'limit',
    flag: '--limit <N>',
    description: 'Cap the number of tasks per cell (useful for smoke tests).',
    group: 'control',
    kind: 'value',
  },
  {
    name: 'out',
    flag: '--out <dir>',
    description: 'Base directory for run output (each run gets a timestamped subdir).',
    group: 'control',
    kind: 'value',
    defaultValue: 'bench-results',
  },
  {
    name: 'concurrency',
    flag: '--concurrency <N>',
    description: 'Override the per-cell concurrency from the model config.',
    group: 'control',
    kind: 'value',
  },
  {
    name: 'repeats',
    flag: '--repeats <N>',
    description:
      'Attempts per (task x model). >1 adds pass@k and a flakiness count so run-to-run noise is visible.',
    group: 'control',
    kind: 'value',
    defaultValue: '1',
  },
  {
    name: 'keep-sandbox',
    flag: '--keep-sandbox',
    description: 'Keep the temporary sandbox (workdirs + isolated home) on disk for debugging.',
    group: 'control',
    kind: 'boolean',
  },
];

/**
 * The names of the boolean flags (the parser iterates these to
 * read each toggle via `flagBool`). The list is derived from
 * `BENCH_RUN_FLAGS` to keep the two in sync — a new boolean
 * flag added to `BENCH_RUN_FLAGS` shows up here automatically.
 */
export const BENCH_RUN_BOOLEAN_FLAG_NAMES: ReadonlyArray<string> = BENCH_RUN_FLAGS.filter(
  (f) => f.kind === 'boolean',
).map((f) => f.name);

/**
 * The names of the value flags (the parser reads these via
 * `flagStr` directly). Same derivation strategy as the
 * boolean list.
 */
export const BENCH_RUN_VALUE_FLAG_NAMES: ReadonlyArray<string> = BENCH_RUN_FLAGS.filter(
  (f) => f.kind === 'value',
).map((f) => f.name);

/**
 * The width of the flag column in the rendered help block.
 * Chosen so the longest flag (`--polyglot-dir <path>`) fits
 * with one space of padding before the description starts.
 */
const BENCH_RUN_FLAG_COLUMN_WIDTH = 28;

/**
 * Build the `wstack bench run` help block as a string. The
 * returned string is the exact bytes the renderer would have
 * written — color codes and all. Used by surfaces that can't
 * hold a `TerminalRenderer` (slash commands return
 * `{ message: string }` instead of writing directly) and by
 * the `bench:run` deep-help entry in `per-subcommand-help.ts`
 * via its `customBody` field.
 *
 * Single source of truth: the body here is the same string
 * `wstack bench run --help`, `wstack bench run -- --help`,
 * `/bench run help`, and `/help bench run` all render. Drift
 * between the four surfaces is structurally impossible.
 *
 * The block layout is:
 *   1. Bold title line
 *   2. Dimmed description (1-2 lines, wrapped at the call site)
 *   3. Empty line
 *   4. Bold "Usage" + the usage line (constructed from
 *      `BENCH_RUN_FLAGS` so the flag ordering matches the list)
 *   5. Empty line
 *   6. Bold "Flags" + the flags, grouped by `group` with
 *      subheaders ("Suite selection:" / "Model matrix:" /
 *      "Run control:") when the group changes
 *   7. Empty line
 *   8. Dimmed "See also:" line (single line, hardcoded)
 */
export function renderBenchRunHelpToString(): string {
  const lines: string[] = [
    color.bold('wstack bench run — execute a benchmark suite across a model matrix'),
    color.dim('  Default suite is bundled core (6 agent-edit tasks with tests). Pass --cell'),
    color.dim('  provider/model to start immediately. Output is a per-run directory'),
    color.dim('  with `report.md` (leaderboard + per-task matrix), JSON artifacts,'),
    color.dim('  and (for swebench) per-cell predictions for the official harness.'),
    '',
    color.bold('Usage'),
    `  ${buildUsageLine()}`,
    '',
    color.bold('Flags'),
    ...buildFlagBlock(),
    '',
    color.dim(
      'See also: wstack bench list; wstack bench report <dir>; wstack bench compare <a> <b>',
    ),
  ];
  return lines.join('\n') + '\n';
}

/**
 * Build the usage line (the `Usage:` value) from
 * `BENCH_RUN_FLAGS`. Boolean flags render as `[--flag]`;
 * value flags render as `[--flag <value>]` (with the value
 * placeholder from the `flag` field). The result is a single
 * line.
 */
function buildUsageLine(): string {
  const parts: string[] = ['wstack bench run'];
  for (const f of BENCH_RUN_FLAGS) {
    if (f.kind === 'value') {
      parts.push(`[${f.flag}]`);
    } else {
      parts.push(`[${f.flag}]`);
    }
  }
  return parts.join(' ');
}

/**
 * Build the flag block (the rows under the "Flags" header).
 * Returns one entry per line. Group subheaders ("Suite
 * selection:" / "Model matrix:" / "Run control:") are
 * inserted when the group changes between consecutive entries.
 * The flag column is padded to `BENCH_RUN_FLAG_COLUMN_WIDTH`
 * so the descriptions align.
 */
function buildFlagBlock(): string[] {
  const rows: string[] = [];
  let currentGroup: BenchRunFlagGroup | undefined;
  for (const f of BENCH_RUN_FLAGS) {
    if (f.group !== currentGroup) {
      // Insert a subheader when the group changes.
      const header =
        f.group === 'suite'
          ? 'Suite selection:'
          : f.group === 'models'
            ? 'Model matrix:'
            : 'Run control:';
      rows.push(color.dim(`  ${header}`));
      currentGroup = f.group;
    }
    const paddedFlag = f.flag.padEnd(BENCH_RUN_FLAG_COLUMN_WIDTH, ' ');
    // Build the description with inline annotations for
    // required flags and defaults. Both annotations are
    // data-driven from the entry's `required` / `defaultValue`
    // fields — the parser uses the same defaults (see
    // `bench.ts`'s `flagStr(deps, 'suite') ?? 'core'`).
    let desc = f.description;
    if (f.required) {
      desc = desc + ' ' + color.bold('(required)');
    } else if (f.defaultValue !== undefined) {
      desc = desc + ' ' + color.dim(`(default: ${f.defaultValue})`);
    }
    rows.push(`  ${paddedFlag} ${desc}`);
  }
  return rows;
}

/**
 * Render the `wstack bench run` help block directly to a
 * renderer. Thin wrapper over `renderBenchRunHelpToString()`
 * for callers that have a `TerminalRenderer` in hand (e.g.
 * the `wstack bench run --help` bypass in `bench.ts`).
 */
export function renderBenchRunHelp(renderer: TerminalRenderer): void {
  renderer.write(renderBenchRunHelpToString());
}

/**
 * Build the `Usage:` line that `benchRun` could write to
 * stderr if the `--suite polyglot` path is missing the
 * required `--polyglot-dir` flag. This is a parser-side
 * fallback; the help block's usage line is the canonical
 * version. Future refactor opportunity: have the parser
 * import this function and call it directly.
 */
export function buildBenchRunUsageLine(): string {
  return buildUsageLine();
}
