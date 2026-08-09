/**
 * Slash-command deep help — mirrors the per-subcommand-help table
 * for slash commands that correspond to top-level subcommands.
 *
 * Why this module exists:
 *   - `/help <slash>` should render the same block as `wstack <sub> --help`
 *     so the in-REPL and the top-level surfaces can't drift.
 *   - `/<slash> <deep> help` (or `/<slash> <deep> --help` or `-h`) should
 *     render the same block as `wstack <slash> <deep> --help`.
 *   - The `SlashCommand.help` field is the *inline* short form (e.g.
 *     `/mcp` lists the subcommands inline); the per-subcommand-help
 *     table is the *focused* long form. Both can coexist, but the
 *     focused form wins for the `help` request.
 *
 * Architecture:
 *   - `slashToSubcommand` maps slash names to their top-level subcommand
 *     counterpart. Slash commands that have no top-level mirror
 *     (e.g. `/btw`, `/collab`, `/interrupt`) are *not* in this map —
 *     they fall back to the inline `help` field.
 *   - `renderSlashFocusedHelp(slash)` looks up the slash's top-level
 *     counterpart and renders the focused help block as a string.
 *     Returns `undefined` when the slash has no top-level mirror
 *     (callers fall through to the inline `help` field).
 *   - `renderSlashDeepHelp(slash, deep)` renders the deep help
 *     block for the given slash + deep subcommand. Returns
 *     `undefined` when no `<top>:<deep>` entry exists.
 *   - `wantsDeepHelp(args)` returns true when the last token in
 *     `args` is `help`, `--help`, or `-h` — the standard pattern
 *     for "show me help for the previous subcommand".
 *
 * The dispatcher functions are pure (no side effects on the
 * renderer) so the slash command can return the rendered string
 * as `{ message }` directly, matching the `SlashCommand.run`
 * contract.
 */
import {
  renderDeepHelpToString,
  renderFocusedHelpToString,
} from '../subcommands/handlers/per-subcommand-help.js';

/**
 * Slash command → top-level subcommand counterpart.
 *
 * The map is split into two sections:
 *
 *   - **Existing slash commands** — slash commands that are
 *     already registered in the REPL. Each entry is a real
 *     binding: a slash command named `auth` exists in
 *     `packages/cli/src/slash-commands/auth.ts`, and the
 *     entry here makes `/help auth` and `/auth help` render
 *     the same string `wstack auth --help` would write.
 *
 *   - **Forward-compatible bindings** — slash commands that
 *     DON'T exist yet but likely will. Each entry pre-registers
 *     a mapping so that when a future contributor adds e.g.
 *     `packages/cli/src/slash-commands/config.ts` with
 *     `name: 'config'`, the focused-help wiring "just works"
 *     without needing to remember to update this file.
 *
 * Only slash commands that have a clean `wstack <name>` mirror
 * belong in this map. Slash commands that have no top-level
 * surface (e.g. `/btw`, `/interrupt`, `/fleet`) are intentionally
 * absent — they fall through to the inline `help` field.
 *
 * Aliases: the slash command's `aliases` field is also looked up
 * at call time, so a slash command with `aliases: ['plugins']`
 * will resolve via both `'plugin'` and `'plugins'`.
 */
const slashToSubcommand: Record<string, string> = {
  // ── Existing slash commands ───────────────────────────────────────
  // These slash commands ARE registered today. The wiring on the
  // slash side imports `renderSlashFocusedHelp` from this module
  // and short-circuits `help` / `--help` / `-h` to the focused
  // block. The entries here are the bridge that wires each
  // slash command to its top-level subcommand counterpart.
  auth: 'auth',
  mcp: 'mcp',
  plugin: 'plugin',
  models: 'models',
  sessions: 'sessions',
  tools: 'tools',
  init: 'init',
  doctor: 'doctor',

  // ── Forward-compatible bindings ───────────────────────────────────
  // No slash command with this name exists yet. When a future
  // contributor adds one (e.g. `packages/cli/src/slash-commands/config.ts`
  // with `name: 'config'`), the entry below is the wiring point
  // for `/help <name>` to render the same block `wstack <name> --help`
  // would write. The contributor still has to add the
  // `wantsDeepHelp` / focused-help short-circuit to the new slash
  // command's `run()` method (mirroring the pattern in
  // `auth.ts` / `mcp.ts` / etc.) — this map just registers the
  // dispatch target for the existing `/help <name>` renderer.
  //
  // Adding an entry here is a one-line, type-checked change.
  // There's no runtime cost when the slash command doesn't exist
  // yet — `renderSlashFocusedHelp` only fires when the user types
  // `/help <name>`, and if the slash command isn't registered,
  // the existing inline-help path is the fallback.
  config: 'config',
  audit: 'audit',
  replay: 'replay',
  rewind: 'rewind',
  export: 'export',
  usage: 'usage',
  providers: 'providers',
  skills: 'skills',
  update: 'update',
  projects: 'projects',
  acp: 'acp',
  modeldiag: 'modeldiag',
  bench: 'bench',
  diag: 'diag',
  version: 'version',
  // `quick` is intercepted by `boot()` for the TUI launch, but
  // its focused-help entry (`wstack quick --help`) still resolves
  // through the per-subcommand-help table. Including it here
  // means a future `/quick` slash command (if one is ever added)
  // gets the focused-help wiring automatically.
  quick: 'quick',
};

/**
 * The list of slash command names that have a top-level counterpart.
 * Used by `/help <name>` to decide whether to render the focused
 * help block (preferred) or fall back to the inline `help` field.
 */
export const slashesWithFocusedHelp: ReadonlyArray<string> = Object.keys(slashToSubcommand);

/**
 * Resolve a slash command name to its top-level subcommand
 * counterpart, or `undefined` if the slash has no mirror.
 * Accepts the primary name OR any alias — caller passes the
 * resolved name (the slash command's `name` field, which is
 * already canonical).
 */
export function resolveSlashSubcommand(slashName: string): string | undefined {
  return slashToSubcommand[slashName];
}

/**
 * Render the focused help block for a slash command. Returns
 * the rendered string, or `undefined` if the slash has no
 * top-level mirror (callers fall through to the inline `help`
 * field).
 *
 *   /help auth   →  renderSlashFocusedHelp('auth')
 *                 →  renderFocusedHelpToString('auth')
 *                 →  the same string `wstack auth --help` would write
 */
export function renderSlashFocusedHelp(slashName: string): string | undefined {
  const sub = resolveSlashSubcommand(slashName);
  if (!sub) return undefined;
  return renderFocusedHelpToString(sub);
}

/**
 * Render the deep help block for a slash command's deep subcommand.
 * Returns the rendered string, or `undefined` if either the slash
 * has no top-level mirror OR the deep subcommand has no deep help
 * entry.
 *
 *   /help mcp add       →  renderSlashDeepHelp('mcp', 'add')
 *                        →  renderDeepHelpToString('mcp:add')
 *                        →  the same string `wstack mcp add --help` writes
 */
export function renderSlashDeepHelp(slashName: string, deep: string): string | undefined {
  const sub = resolveSlashSubcommand(slashName);
  if (!sub) return undefined;
  return renderDeepHelpToString(`${sub}:${deep}`);
}

/**
 * Detect whether `args` ends with a help request — the
 * user-facing convention is "the LAST token is `help`,
 * `--help`, or `-h`" (e.g. `/mcp add help`, `/mcp restart --help`,
 * `/mcp list -h`). Trailing whitespace is allowed.
 *
 * This is the function slash commands should call at the top
 * of their `run()` method to short-circuit to the deep-help
 * block BEFORE any other routing.
 */
export function wantsDeepHelp(args: string): { sub: string; help: true } | null {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1]?.toLowerCase();
  if (last !== 'help' && last !== '--help' && last !== '-h') return null;
  // The deep subcommand is everything between the start and the help token.
  // We pick the FIRST token as the candidate deep — deep subcommands
  // are single-word (`add`, `remove`, `list`, `restart`, etc.) so this
  // matches the deep-help table key shape.
  const sub = parts[0]?.toLowerCase();
  if (!sub) return null;
  return { sub, help: true };
}
