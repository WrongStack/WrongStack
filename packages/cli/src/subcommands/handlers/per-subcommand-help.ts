/**
 * Per-subcommand help block.
 *
 * Each subcommand handler in `packages/cli/src/subcommands/handlers/`
 * that wants a focused `--help` block exports its help data through
 * this module. The handler invokes `renderFocusedHelp(name, renderer)`
 * at the top of its dispatch (after the `--help` short-circuit check)
 * to print the per-subcommand block and return 0.
 *
 * Why a single module:
 *   - **Single source of truth.** All per-subcommand help lives in
 *     one place; the bypass infrastructure in `cli-main.ts` just
 *     falls through to the dispatcher, and each subcommand handler
 *     imports the right helper from here.
 *   - **No circular import risk.** The handlers don't import each
 *     other — they all import from this module.
 *   - **Testable in isolation.** Pure data + a pure render function
 *     — the test suite pins the help text byte-for-byte.
 *
 * Note on `resume`: `wstack resume` is a slash command (`/resume`)
 * invoked from inside the REPL, not a top-level subcommand. The
 * `/resume` slash command has its own help rendering in
 * `slash-commands/resume.ts` — it's intentionally NOT a key in
 * this table. (The user's prompt listed it alongside the other
 * subcommands; the disambiguation lives here.)
 *
 * ────────────────────────────────────────────────────────────────────
 * Four help surfaces that must stay in sync
 * ────────────────────────────────────────────────────────────────────
 *
 * For every entry in the top-level `helpTable` AND every entry in
 * the `deepHelpTable`, the user can invoke `--help` / `-h` from
 * four different surfaces, all of which MUST produce the same
 * string:
 *
 *   1. `wstack <sub> --help`           (top-level CLI bypass)
 *   2. `wstack <sub> <deep> --help`    (deep-subcommand CLI bypass)
 *   3. `/<slash> <sub> [deep] help`    (in-REPL slash command)
 *   4. `/help <sub> [deep]`            (in-REPL dispatch help)
 *
 * The four surfaces read from the SAME data structures (this
 * module's `helpTable` + `deepHelpTable`) and the SAME renderer
 * functions (`renderFocusedHelp` / `renderDeepHelp`). Adding a
 * new flag or a new subcommand entry to this file updates all
 * four surfaces simultaneously — drift between them is
 * structurally impossible.
 *
 * ────────────────────────────────────────────────────────────────────
 * The `customBody` delegation pattern
 * ────────────────────────────────────────────────────────────────────
 *
 * The standard `PerSubcommandHelp` layout (title / description /
 * usage / subcommands / seeAlso) covers ~95% of the help surface.
 * For the remaining ~5% — deep-help entries whose help text is
 * large, column-aligned, or has its own closing "see also" / "Examples"
 * lines (e.g. a multi-row flag table) — the standard layout is
 * too rigid. The `customBody?: () => string` field is the
 * escape hatch:
 *
 *   - When set, `renderBlockToString(help)` returns the function's
 *     output **verbatim** — the standard title / usage /
 *     subcommands / seeAlso scaffolding is skipped.
 *   - The caller owns the full layout, including the title line
 *     and any closing lines.
 *   - The `title` / `description` / `usage` / `subcommands` /
 *     `seeAlso` fields are still required by the `PerSubcommandHelp`
 *     type but are **not rendered** (the `customBody` function
 *     owns the full block). They're filled in with sensible
 *     defaults so a future refactor that drops `customBody` (e.g.
 *     to use the standard layout) still has a coherent fallback.
 *
 * **When to use `customBody`**: a deep-help entry whose help text
 * is already maintained by a dedicated module elsewhere in the
 * codebase, and that module exports a string-returning renderer.
 * The canonical example is `auth:local`, which delegates to
 * `packages/cli/src/subcommands/handlers/auth-local-help.ts`'s
 * `LOCAL_AUTH_FLAGS` in exactly one place; every surface that
 * renders the help reads from it. Drift is structurally
 * impossible.
 *
 * **When NOT to use `customBody`**: a help block that fits the
 * standard layout (a title, a description, a usage line, an
 * optional subcommands table, an optional see-also). The standard
 * layout is the default — `customBody` is a last resort, used only
 * when the standard layout doesn't fit (e.g. a multi-row flag
 * table with column alignment, a list of aliases, an Examples
 * block). Adding `customBody` for a block that fits the standard
 * layout creates visual inconsistency (customBody blocks don't
 * get the standard `Tip: \`wstack --help\` lists every top-level
 * command.` footer).
 *
 * **How to add a new delegated entry** (worked example):
 *
 *   Suppose you're adding `wstack plugin official --help` (a
 *   hypothetical help block for the curated plugin registry).
 *   The flag list is small enough for the standard layout, BUT
 *   you also want a closing "Examples" block that the standard
 *   layout doesn't support. The right move is:
 *
 *     1. Create `packages/cli/src/subcommands/handlers/plugin-official-help.ts`:
 *
 *        ```ts
 *        // Single source of truth for the `wstack plugin official` flag list.
 *        const OFFICIAL_HELP_FLAGS: ReadonlyArray<{ flag: string; description: string }> = [
 *          { flag: '--include-source', description: 'Include the source URL in the output.' },
 *          { flag: '--json',          description: 'Emit the registry as JSON (default: table).' },
 *        ];
 *
 *        export function renderPluginOfficialHelpToString(): string {
 *          // ... build the block (title + description + usage + flag table + Examples) ...
 *          return lines.join('\n') + '\n';
 *        }
 *
 *        export function renderPluginOfficialHelp(renderer: TerminalRenderer): void {
 *          renderer.write(renderPluginOfficialHelpToString());
 *        }
 *        ```
 *
 *     2. Add the entry to the `deepHelpTable` in this file:
 *
 *        ```ts
 *        'plugin:official': {
 *          name: 'plugin:official',
 *          title: 'wstack plugin official — list the curated official registry',
 *          description: 'Print every plugin in the official registry. Each row shows the alias (for shorthand on the command line) and the full NPM specifier.',
 *          usage: 'wstack plugin official [--include-source] [--json]',
 *          seeAlso: 'wstack plugin list (the configured set)',
 *          customBody: renderPluginOfficialHelpToString,
 *        },
 *        ```
 *
 *     3. The new deep-help entry is automatically reachable from
 *        all four surfaces:
 *          - `wstack plugin official --help`
 *          - `/plugin official help` (if a `/plugin` slash exists)
 *          - `/help plugin official` (the two-token dispatch form)
 *          - the existing `wstack plugin` top-level entry's
 *            `Subcommands` table can mention `official` and the
 *            help will resolve when the user asks
 *            `wstack plugin official --help`.
 *
 *     4. Add a test in `per-subcommand-help.test.ts` (the deep-help
 *        suite) and a smoke test in `slash-commands.test.ts` (the
 *        dispatch test) — see the existing `auth:local` tests for
 *        the pattern.
 *
 * **Single source of truth contract**: when `customBody` is set,
 * the function MUST be the only place the body is generated. The
 * `auth-local-help.ts` module is the canonical example: the flag
 * is the only function that formats it. A future contributor who
 * adds a parallel flag array elsewhere breaks the contract; the
 * type system doesn't catch it, but the existing
 * "delegates to auth-local-help.ts (single source of truth)" test
 * would fail (it does `expect(deepOut).toBe(localHelpOut)` —
 * byte-for-byte equality).
 *
 * **Why `customBody` is a thunk, not a value**: the function is
 * called lazily, inside `renderBlockToString`. This matters
 * because:
 *   - Tests that import the data table (e.g. for the "every entry
 *     has a non-empty title" test) don't trigger the lazy
 *     evaluation. If `customBody` were a `string`, importing the
 *     table would force the body to be built.
 *   - The thunk can call back into a module that imports
 *     `PerSubcommandHelp` (e.g. `auth-local-help.ts` itself imports
 *     from this file via `renderFocusedHelpToString`'s chain). A
 *     `string` value would be evaluated at module-load time, when
 *     the import cycle hasn't resolved yet.
 *
 * In short: `customBody` is a *delegate*, not a *value*. The data
 * table stays pure data; the rendering is lazy.
 *
 * ────────────────────────────────────────────────────────────────────
 * On-ramp guide
 * ────────────────────────────────────────────────────────────────────
 *
 * For a contributor-friendly walkthrough of the full pattern —
 * when to write a help module, the canonical data shape, wiring
 * the dispatcher, testing, and a worked example — see
 * `docs/help-modules.md`. That document is the on-ramp; this
 * top-of-file JSDoc is the canonical reference; the field JSDoc
 * below is the mechanism documentation. The three together form
 * a documentation graph for new contributors.
 */
import { color } from '@wrongstack/core/utils';
import type { TerminalRenderer } from '../../renderer.js';
import { deepHelpTable, helpTable } from './per-subcommand-help-data.js';

/**
 * One entry per subcommand the user can ask `--help` for. Each
 * entry is `{ title, description, usage, subcommands?, flags? }`
 * — the renderer is responsible for the column-aligned output.
 *
 * Subcommands with no flags of their own (e.g. `init`, `version`)
 * just supply title/description/usage. Subcommands with a
 * subcommand hierarchy (e.g. `mcp`, `plugin`, `models`) supply
 * a `subcommands` table — a list of `{ name, description }` rows
 * for the dispatch tree. The user can then run
 * `wstack <subcommand> <sub-sub> --help` for the focused help of
 * any deeper level.
 */
export interface PerSubcommandHelp {
  /** The subcommand name as it appears in argv (e.g. 'init', 'mcp'). */
  name: string;
  /** Display title for the help block (e.g. 'wstack init — …'). */
  title: string;
  /** One-line description of what the command does. */
  description: string;
  /** Usage line — `wstack <subcommand> [args]`. */
  usage: string;
  /** Optional subcommand table. Empty for subcommands that take no subargs. */
  subcommands?: ReadonlyArray<{ name: string; description: string }>;
  /**
   * Optional "see also" pointer — the most common adjacent
   * subcommand the user will want to read about. Renders as
   * a single dim line at the bottom of the help block.
   */
  seeAlso?: string;
  /**
   * Optional custom body renderer. When set, the standard
   * title / description / usage / subcommands / seeAlso layout
   * is **replaced** by whatever this function returns. The
   * caller is responsible for the full layout — including
   * the title line, the usage line, and any closing "see
   * also" pointer.
   *
   * **See the top-of-file JSDoc for the full "delegation pattern"
   * documentation** (when to use, when NOT to use, a worked
   * example for adding a new delegated entry, and the
   * single-source-of-truth contract). The worked example walks
   * through creating a hypothetical `plugin-official-help.ts`
   * module and wiring it into the `deepHelpTable` via
   * `customBody`.
   *
   * **For the on-ramp guide, see `docs/help-modules.md`**. It
   * walks through the full pattern (when to write a help
   * module, the canonical data shape, wiring the dispatcher,
   * testing, and a worked example) — the canonical reference
   * for new contributors adding their first help module.
   *
   * Use case: a deep-help entry whose help text is already
   * maintained by a dedicated module (e.g. `auth-local-help.ts`
   * owns the `wstack auth local` flag list). The deep entry
   * delegates to that module's renderer so the flag list
   * stays single-source-of-truth. Setting `customBody` to a
   * thunk that calls the module's string renderer gives
   * `/auth local help`, `/help auth local`, and
   * `wstack auth local --help` the same exact block.
   *
   * Note: when `customBody` is set, the `title`, `description`,
   * `usage`, `subcommands`, and `seeAlso` fields are still
   * required by the type but are **not rendered** — the
   * `customBody` function owns the full block. The required
   * fields exist so the test infrastructure can still iterate
   * the entry shape uniformly.
   */
  customBody?: () => string;
}
const COLUMN_WIDTH = 28;

/**
 * Build the rendered help text for one entry — the same string that
 * `renderBlock` would write to a renderer, returned instead of being
 * emitted. Used by surfaces that can't write directly (slash commands
 * return `{ message: string }` instead of holding a `TerminalRenderer`).
 *
 * Note: the title/description/usage are formatted with ANSI color
 * codes (from `@wrongstack/core/color`). Surfaces that display the
 * returned string in a non-ANSI context (a log file, a test assertion)
 * will see the raw escape codes. Tests should match on substrings,
 * not the full block; UI surfaces should render to a TTY.
 */
export function renderBlockToString(help: PerSubcommandHelp): string {
  // Custom-body entries own the full layout. The renderer
  // calls the function and returns its output verbatim — the
  // standard title/usage/subcommands/seeAlso scaffolding is
  // skipped. This is how the `auth:local` deep entry delegates
  // to `auth-local-help.ts` for the flag list (single source
  // of truth across the slash-command surface and the
  // top-level help).
  if (help.customBody) {
    return help.customBody();
  }
  const lines: string[] = [
    color.bold(help.title),
    color.dim(`  ${help.description}`),
    '',
    color.bold('Usage'),
    `  ${help.usage}`,
  ];
  if (help.subcommands && help.subcommands.length > 0) {
    lines.push('');
    lines.push(color.bold('Subcommands'));
    for (const { name, description } of help.subcommands) {
      const padded = name.padEnd(COLUMN_WIDTH, ' ');
      lines.push(`  ${color.cyan(padded)}${description}`);
    }
  }
  if (help.seeAlso) {
    lines.push('');
    lines.push(color.dim(`  See also: ${help.seeAlso}`));
  }
  lines.push('');
  lines.push(color.dim('  Tip: `wstack --help` lists every top-level command.'));
  return lines.join('\n') + '\n';
}

function renderBlock(help: PerSubcommandHelp, renderer: TerminalRenderer): void {
  renderer.write(renderBlockToString(help));
}

export function renderDeepHelp(key: string, renderer: TerminalRenderer): boolean {
  const help = deepHelpTable[key];
  if (!help) return false;
  renderBlock(help, renderer);
  return true;
}

/**
 * String-returning variant of `renderDeepHelp` for slash commands.
 * Returns the rendered deep-help text, or `undefined` if the
 * `<top>:<deep>` key is not in the table.
 */
export function renderDeepHelpToString(key: string): string | undefined {
  const help = deepHelpTable[key];
  return help ? renderBlockToString(help) : undefined;
}

/**
 * The list of deep-subcommand keys that have focused help blocks.
 * Same shape as `subcommandsWithFocusedHelp` but for the
 * `<top>:<deep>` table. Used by tests to assert the contract.
 */
export const deepSubcommandsWithFocusedHelp: ReadonlyArray<string> = Object.keys(deepHelpTable);

/**
 * Render the focused help block for the given subcommand. Returns
 * `true` if a block was rendered (the subcommand was found in
 * the table) and `false` if no focused help exists — callers can
 * fall back to the generic "see top-level help" message.
 */
export function renderFocusedHelp(subcommand: string, renderer: TerminalRenderer): boolean {
  const help = helpTable[subcommand];
  if (!help) return false;
  renderBlock(help, renderer);
  return true;
}

/**
 * String-returning variant of `renderFocusedHelp` for surfaces that
 * can't hold a `TerminalRenderer` — slash commands return
 * `{ message: string }` instead of writing directly. Returns the
 * rendered help text, or `undefined` if the subcommand is not in
 * the table (callers fall back to the inline `help` field).
 */
export function renderFocusedHelpToString(subcommand: string): string | undefined {
  const help = helpTable[subcommand];
  return help ? renderBlockToString(help) : undefined;
}

/**
 * The list of subcommand names that have a focused help block.
 * Subcommands not in this list fall back to the generic
 * `renderGenericHelp` message — the bypass still works (the user
 * gets something) but the output is terser.
 */
export const subcommandsWithFocusedHelp: ReadonlyArray<string> = Object.keys(helpTable);

/**
 * Generic help block for subcommands that don't have a focused
 * entry in the help table. Tells the user that the subcommand
 * takes no flags and points at the top-level help for the rest.
 */
export function renderGenericHelp(subcommand: string, renderer: TerminalRenderer): void {
  const lines: string[] = [
    color.bold(`wstack ${subcommand}`),
    color.dim(
      `  No focused help block is registered for this subcommand. ` +
        `Run \`wstack ${subcommand}\` for the interactive surface, or ` +
        `\`wstack --help\` for the top-level command list.`,
    ),
    '',
    color.dim("  Tip: each subcommand's help is data-driven; see"),
    color.dim('  `per-subcommand-help.ts` for the focused entries.'),
  ];
  renderer.write(lines.join('\n') + '\n');
}
