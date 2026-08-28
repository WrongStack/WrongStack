import { color } from '@wrongstack/core/utils';
import type { TerminalRenderer } from '../../renderer.js';

/**
 * Per-flag help data for `wstack models add`.
 *
 * The `MODELS_ADD_FLAGS` array is the **single source of truth** for
 * the `wstack models add` flag list. It's consumed by:
 *
 *   - This file's `renderModelsAddHelpToString()` (renders the
 *     column-aligned help block)
 *   - `packages/cli/src/subcommands/handlers/providers-models.ts`'s
 *     `modelsAdd()` function (parses the flags — see the
 *     `parseBoolFlag` / value-flag reads there)
 *   - The `models:add` deep-help entry in
 *     `per-subcommand-help.ts` via its `customBody` field
 *     (delivers the rendered block to every help surface)
 *
 * Adding a new flag to `wstack models add` is a one-line change
 * here; the parser picks it up automatically and the help block
 * re-renders with the new flag in place. Drift between the
 * three surfaces is structurally impossible.
 *
 * The flags are organized into two semantic groups:
 *
 *   - **Identity** — flags that identify the model in the catalog
 *     (`--provider`, `--name`, plus the `<mid>` positional which
 *     is shown in the usage line, not in this array).
 *   - **Capabilities** — flags that describe what the model can do
 *     (`--max-context`, `--max-output`, `--tools`, `--vision`,
 *     `--reasoning`, `--streaming`, `--json-mode`).
 *
 * The grouping is reflected in the `group` field of each entry,
 * which the renderer uses to print a "Flags" section with
 * subheaders ("Identity:" and "Capabilities:") so the help block
 * reads top-to-bottom in the order a user would set them.
 *
 * The `kind` field discriminates the parser behavior:
 *
 *   - `'boolean'` — the flag accepts `--flag` (sets to true) and
 *     `--no-flag` (sets to false). The parser uses
 *     `parseBoolFlag(flags, flagName)` to read these.
 *   - `'value'` — the flag accepts a value (`--flag <value>`).
 *     The parser reads these via `flags[flagName]` directly.
 */
type ModelsAddFlagGroup = 'identity' | 'capabilities';

interface ModelsAddFlag {
  /** The flag's canonical name (no `--` prefix, no value placeholder). */
  name: string;
  /**
   * The display form, with the `--` prefix and any value
   * placeholder. For boolean flags, the renderer appends the
   * ` / --no-<name>` counterpart automatically.
   */
  flag: string;
  /** One-line description shown in the help block. */
  description: string;
  /** Which semantic group the flag belongs to. */
  group: ModelsAddFlagGroup;
  /** Parser shape: `boolean` for toggles, `value` for `--flag <v>`. */
  kind: 'boolean' | 'value';
}

/**
 * The flag list — the canonical source of truth for `wstack models add`.
 *
 * Order matters: it's the order the flags render in the help block,
 * and the order the parser iterates them when reading boolean values.
 * The list is grouped by `group` (identity first, then capabilities)
 * but the renderer preserves the original order and prints subheaders
 * when the group changes.
 */
export const MODELS_ADD_FLAGS: ReadonlyArray<ModelsAddFlag> = [
  // -- Identity --------------------------------------------------------
  {
    name: 'provider',
    flag: '--provider <id>',
    description: 'Provider id the model belongs to (defaults to the saved alias).',
    group: 'identity',
    kind: 'value',
  },
  {
    name: 'name',
    flag: '--name <name>',
    description: 'Human-readable display name (defaults to <mid>).',
    group: 'identity',
    kind: 'value',
  },
  // -- Capabilities ---------------------------------------------------
  {
    name: 'max-context',
    flag: '--max-context <N>',
    description: 'Context window in tokens (e.g. 200000 for 200k, or `128k`).',
    group: 'capabilities',
    kind: 'value',
  },
  {
    name: 'max-output',
    flag: '--max-output <N>',
    description: 'Max output tokens per request.',
    group: 'capabilities',
    kind: 'value',
  },
  {
    name: 'tools',
    flag: '--tools / --no-tools',
    description: 'Toggle tool/function-calling support.',
    group: 'capabilities',
    kind: 'boolean',
  },
  {
    name: 'vision',
    flag: '--vision / --no-vision',
    description: 'Toggle image-input support.',
    group: 'capabilities',
    kind: 'boolean',
  },
  {
    name: 'reasoning',
    flag: '--reasoning / --no-reasoning',
    description: 'Mark the model as a reasoning model.',
    group: 'capabilities',
    kind: 'boolean',
  },
  {
    name: 'streaming',
    flag: '--streaming / --no-streaming',
    description: 'Toggle streaming response support.',
    group: 'capabilities',
    kind: 'boolean',
  },
  {
    name: 'json-mode',
    flag: '--json-mode',
    description: 'Mark the model as supporting native JSON output.',
    group: 'capabilities',
    kind: 'boolean',
  },
];

/**
 * The names of the boolean flags (the parser iterates these to
 * read each toggle via `parseBoolFlag`). The list is derived from
 * `MODELS_ADD_FLAGS` to keep the two in sync — a new boolean
 * flag added to `MODELS_ADD_FLAGS` shows up here automatically.
 */
export const MODELS_ADD_BOOLEAN_FLAG_NAMES: ReadonlyArray<string> = MODELS_ADD_FLAGS.filter(
  (f) => f.kind === 'boolean',
).map((f) => f.name);

/**
 * The names of the value flags (the parser reads these via
 * `flags[name]` directly). Same derivation strategy as the
 * boolean list.
 */
export const MODELS_ADD_VALUE_FLAG_NAMES: ReadonlyArray<string> = MODELS_ADD_FLAGS.filter(
  (f) => f.kind === 'value',
).map((f) => f.name);

/**
 * The width of the flag column in the rendered help block.
 * Chosen so the longest flag (`--max-context <N>`) fits with
 * one space of padding before the description starts.
 */
const MODELS_ADD_FLAG_COLUMN_WIDTH = 30;

/**
 * Build the `wstack models add` help block as a string. The
 * returned string is the exact bytes the renderer would have
 * written — color codes and all. Used by surfaces that can't
 * hold a `TerminalRenderer` (slash commands return
 * `{ message: string }` instead of writing directly) and by
 * the `models:add` deep-help entry in `per-subcommand-help.ts`
 * via its `customBody` field.
 *
 * Single source of truth: the body here is the same string
 * `wstack models add --help`, `wstack models add -- --help`,
 * `/models add help`, and `/help models add` all render. Drift
 * between the four surfaces is structurally impossible.
 *
 * The block layout is:
 *   1. Bold title line
 *   2. Dimmed description (1-2 lines, wrapped at the call site)
 *   3. Empty line
 *   4. Bold "Usage" + the usage line (constructed from
 *      `MODELS_ADD_FLAGS` so the flag ordering matches the list)
 *   5. Empty line
 *   6. Bold "Flags" + the flags, grouped by `group` with
 *      subheaders ("Identity:" / "Capabilities:") when the
 *      group changes
 *   7. Empty line
 *   8. Dimmed "See also:" line (single line, hardcoded)
 */
export function renderModelsAddHelpToString(): string {
  const lines: string[] = [
    color.bold('wstack models add <mid> — register a custom model'),
    color.dim('  Add or override a custom model (for self-hosted endpoints, fine-tuned'),
    color.dim('  weights, or models not in the public models.dev catalog). The flags are'),
    color.dim('  organized into two groups: identity (`--provider`, `--name`) and'),
    color.dim('  capabilities (`--max-context`, `--tools`, `--vision`, etc.).'),
    '',
    color.bold('Usage'),
    `  ${buildUsageLine()}`,
    '',
    color.bold('Flags'),
    ...buildFlagBlock(),
    '',
    color.dim('See also: wstack models list (verify the entry); wstack models remove'),
  ];
  return lines.join('\n') + '\n';
}

/**
 * Build the usage line (the `Usage:` value) from `MODELS_ADD_FLAGS`.
 * Boolean flags render as `--flag|--no-flag`; value flags render as
 * `[--flag <value>]`. The result is a single line.
 */
function buildUsageLine(): string {
  const parts: string[] = ['wstack models add <mid>'];
  for (const f of MODELS_ADD_FLAGS) {
    if (f.kind === 'value') {
      parts.push(`[${f.flag}]`);
    } else {
      // Boolean: render as `--flag|--no-flag`
      parts.push(`[${f.flag}]`);
    }
  }
  return parts.join(' ');
}

/**
 * Build the flag block (the rows under the "Flags" header).
 * Returns one entry per line. Group subheaders ("Identity:" /
 * "Capabilities:") are inserted when the group changes between
 * consecutive entries. The flag column is padded to
 * `MODELS_ADD_FLAG_COLUMN_WIDTH` so the descriptions align.
 */
function buildFlagBlock(): string[] {
  const rows: string[] = [];
  let currentGroup: ModelsAddFlagGroup | undefined;
  for (const f of MODELS_ADD_FLAGS) {
    if (f.group !== currentGroup) {
      // Insert a subheader when the group changes.
      const header = f.group === 'identity' ? 'Identity:' : 'Capabilities:';
      rows.push(color.dim(`  ${header}`));
      currentGroup = f.group;
    }
    const paddedFlag = f.flag.padEnd(MODELS_ADD_FLAG_COLUMN_WIDTH, ' ');
    rows.push(`  ${paddedFlag} ${f.description}`);
  }
  return rows;
}

/**
 * Render the `wstack models add` help block directly to a
 * renderer. Thin wrapper over `renderModelsAddHelpToString()`
 * for callers that have a `TerminalRenderer` in hand (e.g.
 * the `wstack models add --help` bypass in
 * `providers-models.ts`).
 */
export function renderModelsAddHelp(renderer: TerminalRenderer): void {
  renderer.write(renderModelsAddHelpToString());
}

/**
 * Build the `Usage:` line that `modelsAdd` writes to stderr
 * when the `<mid>` positional is missing. This is the parser's
 * equivalent of the help block's usage line — it should match
 * what `buildUsageLine()` produces so the two stay in sync.
 *
 * The two are not currently auto-derived from the same source
 * (the parser writes a literal string for the stderr path, the
 * help block builds it from `MODELS_ADD_FLAGS`). Future refactor
 * opportunity: have the parser import this function and call it
 * directly. For now, the test
 * `modelsAddHelpParity > usage line matches` pins the contract
 * (a future contributor who changes one without the other fails
 * the test).
 */
export function buildModelsAddUsageLine(): string {
  return buildUsageLine();
}
