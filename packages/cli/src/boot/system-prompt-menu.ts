/**
 * Interactive system-prompt selection menu — Lite / Standard / Pro.
 *
 * Shown at startup when the user did not pin a variant via
 * `--system-lite`, `--system-pro`, or `--system-prompt <variant>`.
 * Each option displays the estimated token count of the identity block
 * that variant injects (resolved through the same bundled → global →
 * project instruction dirs the SystemPromptBuilder uses, so a project
 * or profile override is reflected in the count).
 *
 * Flow mirrors `runLaunchPrompts`:
 *   - no saved variant (first run)      → show the numbered menu directly
 *   - saved variant exists              → one-line "Continue with these?"
 *     gate; `n` opens the full menu, `q` aborts the launch
 *   - the caller persists the selection via `persistSystemPromptVariant`
 *     so the next boot can offer the gate instead of re-asking.
 *
 * `q` at any prompt throws `LaunchAbortedError` (the same cancellation
 * contract as the launch prompts), and the caller in boot.ts exits 0.
 */

import {
  countSystemPromptTokens,
  persistSystemPromptVariant,
  readSavedSystemPromptVariant,
  SYSTEM_PROMPT_VARIANT_OPTIONS,
  SYSTEM_PROMPT_VARIANTS,
  type SystemInstructionVariant,
  type SystemPromptVariantPaths,
} from '@wrongstack/core/agent';
import { color } from '@wrongstack/core/utils';
import type { ReadlineInputReader } from '../input-reader.js';
import { LaunchAbortedError } from '../pre-launch.js';
import type { TerminalRenderer } from '../renderer.js';
import { fmtTok } from '../utils.js';

/**
 * Menu order + display labels, re-exported from core so the CLI menu, the
 * WebUI picker, and any other surface offer the same three options in the same
 * order with the same token math.
 */
export const SYSTEM_PROMPT_OPTIONS = SYSTEM_PROMPT_VARIANT_OPTIONS;

export {
  countSystemPromptTokens,
  persistSystemPromptVariant,
  readSavedSystemPromptVariant,
  SYSTEM_PROMPT_VARIANTS,
};

/** Instruction dirs used to resolve the identity text per variant. */
export type SystemPromptMenuPaths = SystemPromptVariantPaths;

const SUMMARY_TIMEOUT_MS = 5_000;

/** Loose `--flag=true/1/yes/on` boolean mirror of core's `isEnabledFlag`. */
function flagOn(value: string | boolean | undefined): boolean {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

/** True when any `--system-*` flag pins a variant (menu must not show). */
export function isSystemPromptPinned(flags: Record<string, string | boolean>): boolean {
  return (
    flagOn(flags['system-pro']) ||
    flagOn(flags['system-lite']) ||
    typeof flags['system-prompt'] === 'string'
  );
}

/**
 * Pure predicate — when to skip the system-prompt menu entirely. The boot
 * caller additionally gates on interactive-TTY conditions; this covers the
 * flag-level reasons so scripts can opt out with `--no-menu`/`--skip` and
 * flag-pinned launches never prompt.
 */
export function shouldSkipSystemPromptMenu(flags: Record<string, string | boolean>): boolean {
  if (isSystemPromptPinned(flags)) return true;
  if (flags['no-menu'] === true) return true;
  if (flags['no-interactive'] === true) return true;
  if (flags['skip'] === true) return true;
  if (flags['webui'] === true) return true;
  return false;
}

function labelFor(variant: SystemInstructionVariant): string {
  return SYSTEM_PROMPT_OPTIONS.find((o) => o.variant === variant)?.label ?? variant;
}

/**
 * Run the interactive system-prompt selection. Returns the chosen variant.
 * Throws {@link LaunchAbortedError} when the user presses `q` (the caller
 * exits 0, matching the launch-prompts contract).
 *
 * @throws LaunchAbortedError when the user cancels.
 */
export async function runSystemPromptMenu(deps: {
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  paths: SystemPromptMenuPaths;
  /** Saved variant from config — enables the summary gate. */
  lastVariant?: SystemInstructionVariant | undefined;
}): Promise<SystemInstructionVariant> {
  const { renderer, reader, paths, lastVariant } = deps;
  const tokens = await countSystemPromptTokens(paths);
  const defaultVariant: SystemInstructionVariant = lastVariant ?? 'default';

  // Summary gate — reuse the persisted selection when one exists.
  if (lastVariant) {
    const answer = (
      await reader.readLine(
        `  ${color.amber('?')} Continue with ${color.bold(labelFor(lastVariant))} system prompt ${color.dim(`(~${fmtTok(tokens[lastVariant])} tokens)`)}? ${color.dim('[Y/n/q]')} ${color.dim('(auto Y in 5s)')} `,
        { timeoutMs: SUMMARY_TIMEOUT_MS, defaultAnswer: 'y' },
      )
    )
      .trim()
      .toLowerCase();
    if (answer === 'q' || answer === 'quit') throw new LaunchAbortedError();
    if (answer !== 'n' && answer !== 'no') return lastVariant;
    // `n` — fall through to the full menu.
  }

  renderer.write(`\n  ${color.amber('?')} System prompt:\n`);
  for (const [index, opt] of SYSTEM_PROMPT_OPTIONS.entries()) {
    const num = index + 1;
    const isDefault = opt.variant === defaultVariant;
    const marker = isDefault ? color.cyan('●') : color.dim('○');
    const label = isDefault ? color.bold(opt.label) : opt.label;
    renderer.write(
      `    ${color.dim(`${num}.`)} ${marker} ${label.padEnd(9)} ${color.dim(`~${fmtTok(tokens[opt.variant])} tokens`)}  ${color.dim(opt.hint)}\n`,
    );
  }

  const answer = (
    await reader.readLine(
      `\n  ${color.amber('?')} Select system prompt ${color.dim(`[1-${SYSTEM_PROMPT_OPTIONS.length}, Enter = ${labelFor(defaultVariant)}, q to quit]`)}: `,
    )
  )
    .trim()
    .toLowerCase();
  if (answer === 'q' || answer === 'quit') throw new LaunchAbortedError();
  if (!answer) return defaultVariant;

  const num = Number.parseInt(answer, 10);
  if (!Number.isNaN(num) && num >= 1 && num <= SYSTEM_PROMPT_OPTIONS.length) {
    return SYSTEM_PROMPT_OPTIONS[num - 1]!.variant;
  }
  // Accept labels or variant ids directly (e.g. "pro", "standard").
  const byName = SYSTEM_PROMPT_OPTIONS.find(
    (o) => o.label.toLowerCase() === answer || o.variant === answer,
  );
  if (byName) return byName.variant;

  // Anything unrecognized falls back to the default — the menu is best-effort.
  return defaultVariant;
}

/** Outcome of {@link maybeRunSystemPromptMenu}. */
export interface SystemPromptMenuOutcome {
  /**
   * The variant the user selected, or `undefined` when the menu did not run
   * (non-TTY / flag-skipped) or was aborted. `undefined` means "caller must
   * not patch config" — it is not a synonym for `'default'`.
   */
  variant?: SystemInstructionVariant | undefined;
  /** True when the user pressed `q`. The caller should exit cleanly. */
  aborted: boolean;
  /** True when the selection differs from what was saved on disk. */
  changed: boolean;
  /** Set when persistence failed; the caller surfaces it as a warning. */
  persistError?: unknown;
}

/**
 * The real enforcement point for the startup system-prompt menu.
 *
 * `isInteractiveTTY` is an explicit **parameter**, not read from
 * `process.stdin` — that is the entire reason this function exists. While the
 * gate lived as a bare `if (isInteractiveTTY)` wrapping an inline block in
 * `boot.ts`, no test could reach it: the only importable symbol was
 * `shouldSkipSystemPromptMenu`, which covers the *flag-level* reasons and is
 * nested one level deeper. Coverage therefore stopped at the predicate and
 * never touched the condition that actually suppresses the prompt.
 *
 * Behavior is intentionally identical to the inline block it replaces:
 *   - non-TTY or flag-skipped  → return early, touch nothing, read nothing
 *   - `q` at the prompt        → `aborted: true` (caller closes + exits 0)
 *   - selection === saved      → `changed: false`, no config write
 *   - persistence throws       → captured in `persistError`, never rethrown
 *
 * Persistence failure is deliberately non-fatal: a read-only config must not
 * prevent the session from starting.
 */
export async function maybeRunSystemPromptMenu(opts: {
  isInteractiveTTY: boolean;
  flags: Record<string, string | boolean>;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  profileConfigPath: string;
  paths: SystemPromptMenuPaths;
  /**
   * Persistence override — defaults to the real `persistSystemPromptVariant`.
   * Test seam: lets the persistence-failure path be exercised deterministically
   * on every platform instead of relying on chmod semantics, which Windows
   * does not reliably honor for directory renames.
   */
  persist?: typeof persistSystemPromptVariant | undefined;
}): Promise<SystemPromptMenuOutcome> {
  if (!opts.isInteractiveTTY) return { aborted: false, changed: false };
  if (shouldSkipSystemPromptMenu(opts.flags)) return { aborted: false, changed: false };

  let savedVariant: SystemInstructionVariant | undefined;
  try {
    // The config loader always materializes `variant: 'default'` in memory, so
    // the gate signal must come from the raw config file: presence of
    // `systemPrompt.variant` on disk = the user explicitly selected it before.
    savedVariant = await readSavedSystemPromptVariant(opts.profileConfigPath);
    const chosen = await runSystemPromptMenu({
      renderer: opts.renderer,
      reader: opts.reader,
      lastVariant: savedVariant,
      paths: opts.paths,
    });
    if (chosen === savedVariant) return { variant: chosen, aborted: false, changed: false };
    try {
      await (opts.persist ?? persistSystemPromptVariant)(opts.profileConfigPath, chosen);
    } catch (err) {
      return { variant: chosen, aborted: false, changed: true, persistError: err };
    }
    return { variant: chosen, aborted: false, changed: true };
  } catch (err) {
    if (err instanceof LaunchAbortedError) return { aborted: true, changed: false };
    throw err;
  }
}
