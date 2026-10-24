/**
 * Interactive launch menu — surfaced when `wstack` is invoked with no
 * mode flag (no `--webui`, `--simpleui`, `--hq`, or `--desktop`) and no
 * positional subcommand, on an interactive TTY.
 *
 * The menu asks the user **once** which top-level surface to launch:
 *   1) TUI / REPL  — interactive terminal (the historical default)
 *   2) WebUI       — browser-based project UI (port 3456 by default)
 *   3) SimpleUI    — lightweight browser UI  (port 3466 by default)
 *   4) HQ          — project-independent HQ dashboard (port 3499)
 *   5) Desktop     — Electron desktop shell (`wstack --desktop`)
 *
 * It returns either:
 *   - `null`         — caller should fall through to the historical
 *                       boot() flow unchanged (menu skipped).
 *   - `LaunchChoice` — caller should honor the selection:
 *                       * `tui-repl` → proceed to boot() with no flag
 *                         changes (the inner pre-launch prompts still
 *                         ask TUI vs REPL + YOLO + autonomy).
 *                       * `webui` / `simpleui` → caller injects the
 *                         surface flag + chosen port into argv.
 *                       * `hq` → caller dispatches to the HQ
 *                         short-circuit with the chosen port/host.
 *                       * `desktop` → caller injects `--desktop` and
 *                         dispatches to the desktop short-circuit.
 *
 * Why this lives in `boot/`: it sits next to the other entry-point
 * short-circuits (`short-circuit-{flags,desktop,hq}.ts`) and is
 * consumed by `cli-context.ts` between those short-circuits and
 * `boot()`. It deliberately does NOT take any DI container, agent,
 * or session — those are owned by the post-boot phase.
 */
import * as fs from 'node:fs/promises';
import type { LaunchMenuChoice } from '@wrongstack/contracts/types';
import { HQ_CLI_DEFAULT_HOST } from '@wrongstack/hq';
import { atomicWrite, color, isStdinTTY, withFileLock } from '@wrongstack/core/utils';
import type { TerminalRenderer } from '../renderer.js';
import { CLI_VERSION } from '../version.js';
import { launchBannerLines } from './launch-banner.js';
import { promptModeArrow } from './launch-menu-arrow.js';
import type { LaunchMenuMode, NetworkLaunchMode, RunLaunchMenuDeps } from './launch-menu-types.js';
import { DEFAULT_PORTS, MENU_TIMEOUT_MS, MODE_OPTIONS } from './launch-menu-types.js';

/** Resolved menu result — the caller must act on this, not re-derive. */
interface LaunchMenuResult extends LaunchMenuChoice {
  /**
   * True when the user typed `q` (or pressed Ctrl+C) at any prompt.
   * Caller should exit gracefully with code 0.
   */
  cancelled: boolean;
}

const DEFAULT_HOST = '127.0.0.1';
/** Shared with the other HQ entry points so the two cannot drift apart. */
const HQ_DEFAULT_HOST = HQ_CLI_DEFAULT_HOST;

function bindsPort(mode: LaunchMenuMode): mode is NetworkLaunchMode {
  return mode !== 'tui-repl' && mode !== 'desktop';
}

function defaultHostFor(mode: NetworkLaunchMode): string {
  return mode === 'hq' ? HQ_DEFAULT_HOST : DEFAULT_HOST;
}
const SUMMARY_TIMEOUT_MS = 5_000;
const PORT_TIMEOUT_MS = 8_000;

/**
 * Pure predicate — extracted so unit tests can lock the skip
 * conditions down without booting a renderer or reader.
 *
 * Menu is skipped when ANY of these are true:
 *   - `--no-menu` flag is set
 *   - `--webui`, `--simpleui`, `--hq`, or `--desktop` flag is set
 *     (the user already chose a surface)
 *   - stdin is not a TTY (CI, pipes, redirects)
 *   - `--no-interactive` or `--skip` (existing "skip all prompts"
 *     contract from boot.ts)
 *   - a one-shot prompt (`--prompt <x>`) is supplied
 *   - ANY positional argument is present — a subcommand or a one-shot
 *     query. The user already said what they wanted.
 */
export function shouldSkipMenu(
  argv: string[],
  flags: Record<string, string | boolean>,
  positional: string[],
): boolean {
  if (flags['no-menu'] === true) return true;
  if (flags['webui'] === true) return true;
  if (flags['webui-session-child'] === true) return true;
  if (flags['simpleui'] === true) return true;
  if (flags['vibeui'] === true) return true;
  if (flags['hq'] === true) return true;
  if (flags['desktop'] === true) return true;
  if (flags['no-interactive'] === true) return true;
  if (flags['skip'] === true) return true;
  if (typeof flags['prompt'] === 'string') return true;
  if (!isStdinTTY()) return true;
  // ANY leading positional means the user asked for something specific —
  // a subcommand or a one-shot query — so never ambush them with a menu.
  //
  // This used to gate on a hand-maintained name set that had drifted from the
  // real dispatcher table, so `mailbox`, `hq`, `acp`, `chronicle`,
  // `permissions`, `diag`, `models`, `providers`, `plugins`, `projects`,
  // `usage`, `config` and every one-shot query printed the banner and a
  // numbered menu to STDOUT after an 8 s countdown. That breaks the capture
  // contract `handlers/mailbox-serve.ts` documents: `URL=$(wstack mailbox
  // serve)` swallowed the menu instead of the URL.
  if (positional.length > 0) return true;
  // Silence unused-arg lint without dropping the parameter — argv is
  // reserved for future deep argv parsing (e.g. recognizing
  // `wstack mcp add …` after subcommand-stripping).
  void argv;
  return false;
}

/**
 * Run the interactive launch menu.
 *
 * Returns `null` when the menu should be skipped (see
 * {@link shouldSkipMenu}). Otherwise returns a {@link LaunchMenuResult}
 * the caller must act on.
 */
export async function runLaunchMenu(deps: RunLaunchMenuDeps): Promise<LaunchMenuResult | null> {
  if (shouldSkipMenu(deps.argv, deps.flags, deps.positional)) {
    return null;
  }

  const { renderer, reader, lastChoice } = deps;
  const ports = { ...DEFAULT_PORTS, ...(deps.defaultPorts ?? {}) };

  writeBanner(renderer);

  // Summary gate — same pattern as runLaunchPrompts.
  if (lastChoice) {
    const accept = await promptSummaryGate(deps);
    if (accept === 'use-last') {
      return finalize(lastChoice, ports);
    }
    if (accept === 'cancel') {
      return { ...lastChoice, cancelled: true };
    }
    // accept === 're-prompt' → fall through to the numbered menu.
  }

  renderer.write(`\n  ${color.amber('?')} Choose how to run WrongStack:\n\n`);

  // Preferred path: raw-mode arrow-key selector. Falls back to the
  // numbered readline prompt when raw mode is unavailable (piped stdin,
  // tests, exotic terminals) — the two paths MUST stay behaviorally
  // equivalent: same options, same timeout default, same cancel keys.
  const arrowPick = await promptModeArrow(deps);

  let choice: LaunchMenuChoice;
  if (arrowPick) {
    if (arrowPick.cancelled) {
      return { mode: 'tui-repl', cancelled: true };
    }
    choice = { mode: arrowPick.mode };
  } else {
    for (const opt of MODE_OPTIONS) {
      renderer.write(
        `    ${color.bold(String(opt.key))}) ${opt.icon}  ${color.bold(opt.label)}  ${color.dim(opt.hint)}\n`,
      );
    }
    renderer.write(`\n  ${color.dim('─'.repeat(48))}\n`);
    const answer = (
      await reader.readLine(
        `  ${color.amber('?')} Mode ${color.dim('[1-5, q to quit]')} ${color.dim(`(auto 1 in ${MENU_TIMEOUT_MS / 1000}s)`)} `,
        { timeoutMs: MENU_TIMEOUT_MS, defaultAnswer: '1' },
      )
    )
      .trim()
      .toLowerCase();

    if (answer === 'q' || answer === 'quit') {
      renderer.write(color.dim('  Goodbye!\n'));
      return { mode: 'tui-repl', cancelled: true };
    }

    const picked = MODE_OPTIONS.find((o) => String(o.key) === answer || o.mode === answer);
    // Anything unrecognized falls back to the first option (TUI/REPL),
    // matching the timeout default — the menu is best-effort.
    choice = picked ? { mode: picked.mode } : { mode: 'tui-repl' };
  }

  // For modes that bind a port/host, ask once and persist the answer.
  // Desktop launches the Electron shell and does not take a listen port.
  if (bindsPort(choice.mode)) {
    const port = await promptPort(deps, ports[choice.mode]);
    choice.port = port;
    const defaultHost = defaultHostFor(choice.mode);
    const host = await promptHost(deps, defaultHost);
    if (host !== defaultHost) choice.host = host;
  }

  return finalize(choice, ports);
}

/**
 * Print the WRONGSTACK banner (same artwork the TUI shows) above the
 * menu. Pure decoration — kept out of the non-interactive paths by the
 * `shouldSkipMenu` gate that runs before this.
 */
function writeBanner(renderer: TerminalRenderer): void {
  const columns = process.stdout.columns ?? 80;
  renderer.write('\n');
  for (const line of launchBannerLines(columns, CLI_VERSION)) {
    renderer.write(`  ${line}\n`);
  }
}

/**
 * One-line "continue with last settings?" gate.
 *
 * Returns:
 *   - 'use-last' → caller should reuse `lastChoice` as-is.
 *   - 'cancel'   → user typed `q`; caller exits gracefully.
 *   - 're-prompt' → user typed `n` (or anything else); fall through
 *                    to the numbered menu below.
 */
async function promptSummaryGate(
  deps: RunLaunchMenuDeps,
): Promise<'use-last' | 'cancel' | 're-prompt'> {
  const { renderer, reader, lastChoice } = deps;
  if (!lastChoice) return 're-prompt';

  const modeLabel = describeMode(lastChoice.mode);
  const portStr =
    typeof lastChoice.port === 'number' ? ` · port ${color.bold(String(lastChoice.port))}` : '';
  const hostStr =
    typeof lastChoice.host === 'string' ? ` · host ${color.dim(lastChoice.host)}` : '';
  renderer.write(`\n  ${color.dim('─'.repeat(48))}\n`);
  renderer.write(
    `  ${color.cyan('⏎')}  ${color.dim('Last settings:')} ${color.bold(modeLabel)}${portStr}${hostStr}\n`,
  );
  renderer.write(`  ${color.dim('─'.repeat(48))}\n`);

  const answer = (
    await reader.readLine(
      `  ${color.amber('?')} Continue with these? ${color.dim('[Y/n/q]')} ${color.dim('(auto Y in 5s)')} `,
      { timeoutMs: SUMMARY_TIMEOUT_MS, defaultAnswer: 'y' },
    )
  )
    .trim()
    .toLowerCase();

  if (answer === 'q' || answer === 'quit') {
    renderer.write(color.dim('  Goodbye!\n'));
    return 'cancel';
  }
  if (answer === 'n' || answer === 'no') return 're-prompt';
  return 'use-last';
}

/**
 * Ask for an optional port. Returns the chosen port, or `defaultPort`
 * if the user pressed Enter / timed out. Validates the range; on
 * invalid input, re-prompts until the user quits or supplies a valid
 * integer (capped at a small bounded retry to keep the menu snappy).
 */
async function promptPort(deps: RunLaunchMenuDeps, defaultPort: number): Promise<number> {
  const { renderer, reader } = deps;
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const answer = (
      await reader.readLine(
        `  ${color.amber('?')} Port ${color.dim(`[${defaultPort}]`)} ${color.dim('(Enter = default, q = cancel)')} `,
        { timeoutMs: PORT_TIMEOUT_MS, defaultAnswer: '' },
      )
    ).trim();

    if (answer === '' || answer === '\n') return defaultPort;
    if (answer === 'q' || answer === 'quit') return defaultPort;

    const parsed = /^\d+$/.test(answer) ? Number(answer) : Number.NaN;
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }
    renderer.writeWarning(`  Invalid port "${answer}". Use 1–65535.\n`);
  }
  return defaultPort;
}

/**
 * Ask for an optional host. HQ defaults to all interfaces (`0.0.0.0`);
 * project-scoped browser surfaces remain loopback-first (`127.0.0.1`).
 * Enter or timeout accepts that default. We deliberately don't validate beyond a non-empty string
 * — node's `net.createServer().listen(port, host)` will surface any
 * DNS failure at bind time.
 */
async function promptHost(deps: RunLaunchMenuDeps, defaultHost: string): Promise<string> {
  const { renderer, reader } = deps;
  renderer.write(
    `  ${color.dim('ℹ')} Press Enter to bind to ${color.bold(defaultHost)}${defaultHost === HQ_DEFAULT_HOST ? ' (all interfaces)' : ' (loopback)'}.\n`,
  );
  const answer = (
    await reader.readLine(
      `  ${color.amber('?')} Host ${color.dim(`[${defaultHost}]`)} ${color.dim('(Enter = default, q = cancel)')} `,
      { timeoutMs: PORT_TIMEOUT_MS, defaultAnswer: '' },
    )
  ).trim();

  if (answer === '' || answer === 'q' || answer === 'quit') return defaultHost;
  return answer;
}

/**
 * Apply default-port fallback for any mode that binds a port. Keeps
 * the saved `lastChoice` minimal — we never persist the literal
 * default port (it would just shadow the source-of-truth in
 * port-utils.ts).
 */
function finalize(choice: LaunchMenuChoice, ports: typeof DEFAULT_PORTS): LaunchMenuResult {
  if (!bindsPort(choice.mode)) return { ...choice, cancelled: false };
  const fallback = ports[choice.mode];
  return {
    ...choice,
    port: typeof choice.port === 'number' ? choice.port : fallback,
    host: choice.host ?? defaultHostFor(choice.mode),
    cancelled: false,
  };
}

function describeMode(mode: LaunchMenuMode): string {
  switch (mode) {
    case 'tui-repl':
      return 'TUI / REPL';
    case 'webui':
      return 'WebUI';
    case 'simpleui':
      return 'SimpleUI';
    case 'vibeui':
      return 'VibeUI';
    case 'hq':
      return 'HQ';
    case 'desktop':
      return 'Desktop';
    default: {
      // Exhaustiveness guard — `mode` is a finite union, so this is
      // unreachable. The runtime check keeps TS's `noUnusedParameters`
      // happy and documents the fallback.
      const exhaustive: never = mode;
      return String(exhaustive);
    }
  }
}

/**
 * Pure function — translate a `LaunchMenuResult` into the argv a
 * downstream `boot()` call should consume.
 *
 * Behaviour:
 *   - `tui-repl`  → unchanged argv; pre-launch prompts ask TUI vs REPL.
 *   - `webui`     → appends `--webui --port=<n> [--host=<h>]`.
 *   - `simpleui`  → appends `--simpleui --port=<n> [--host=<h>]`.
 *   - `hq`        → appends `--hq --port=<n> [--host=<h>]` (the
 *                   short-circuit in cli-context.ts will pick this up
 *                   and dispatch to startHqServer).
 *   - `desktop`   → appends `--desktop` (the desktop short-circuit
 *                   in cli-context.ts then launches Electron).
 *
 * The function is intentionally argv-only — no side effects, no I/O —
 * so unit tests can pin the transformation down without mocking
 * readers or renderers.
 */
export function applyLaunchMenuToArgv(argv: string[], result: LaunchMenuResult): string[] {
  if (result.cancelled) return argv;
  const out = [...argv];
  switch (result.mode) {
    case 'tui-repl':
      return out;
    case 'webui':
      if (typeof result.port === 'number') out.push(`--port=${result.port}`);
      if (typeof result.host === 'string') out.push(`--host=${result.host}`);
      out.push('--webui');
      return out;
    case 'simpleui':
      if (typeof result.port === 'number') out.push(`--port=${result.port}`);
      if (typeof result.host === 'string') out.push(`--host=${result.host}`);
      out.push('--simpleui');
      return out;
    case 'vibeui':
      if (typeof result.port === 'number') out.push(`--port=${result.port}`);
      if (typeof result.host === 'string') out.push(`--host=${result.host}`);
      out.push('--vibeui');
      return out;
    case 'hq':
      if (typeof result.port === 'number') out.push(`--port=${result.port}`);
      if (typeof result.host === 'string') out.push(`--host=${result.host}`);
      out.push('--hq');
      return out;
    case 'desktop':
      out.push('--desktop');
      return out;
    default: {
      const exhaustive: never = result.mode;
      void exhaustive;
      return out;
    }
  }
}

/**
 * Convert a {@link LaunchMenuResult} into the shape we persist to
 * `config.launch.menuChoice`. Returns `undefined` for cancellations
 * (we don't want to overwrite a saved choice with nothing) and for
 * `tui-repl` (the inner pre-launch prompts already persist
 * `config.launch.mode` for the TUI/REPL decision).
 *
 * Port validation mirrors `promptPort`'s 1–65535 range — if a
 * caller hands us a result with an out-of-range port we coerce it
 * to `undefined` so the next boot uses the surface default rather
 * than a value that would crash the server.
 */
export function toPersistedMenuChoice(result: LaunchMenuResult): LaunchMenuChoice | undefined {
  if (result.cancelled) return undefined;
  if (result.mode === 'tui-repl') return undefined;
  const port =
    typeof result.port === 'number' &&
    Number.isFinite(result.port) &&
    result.port > 0 &&
    result.port < 65536
      ? result.port
      : undefined;
  return {
    mode: result.mode,
    ...(port !== undefined ? { port } : {}),
    ...(typeof result.host === 'string' && result.host.length > 0 ? { host: result.host } : {}),
  };
}

/**
 * Persist a resolved menu choice to the global config so the next
 * boot can offer a one-line "Continue with last settings?" gate.
 *
 * Mirrors `persistLaunchChoices` from `pre-launch/launch-prompts.ts`:
 * reads the existing JSON, mutates only `launch.menuChoice`, writes
 * back atomically with mode 0600. Best-effort — never throws to
 * the caller, so a corrupt config file can't block the actual launch.
 */
export async function persistMenuChoice(
  globalConfigPath: string,
  choice: LaunchMenuChoice,
): Promise<void> {
  // Under the shared config lock: see persistLaunchChoices.
  await withFileLock(globalConfigPath, async () => {
    let fileExists = false;
    try {
      await fs.access(globalConfigPath);
      fileExists = true;
    } catch {}

    let existing: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(globalConfigPath, 'utf8');
      // A leading UTF-8 BOM is valid (RFC 8259); the config loader accepts it.
      existing = JSON.parse(raw.replace(/^\uFEFF/, '')) as Record<string, unknown>;
    } catch (err) {
      if (fileExists) {
        // Same policy as persistLaunchChoices: refuse to overwrite a
        // corrupt file silently.
        throw new Error(
          `Refusing to overwrite corrupt config at ${globalConfigPath} ` +
            `(${(err as Error).message}). Fix or move the file aside before retrying.`,
          { cause: err },
        );
      }
      existing = {};
    }

    const launch = (existing.launch ?? {}) as Record<string, unknown>;
    existing.launch = { ...launch, menuChoice: choice };

    await atomicWrite(globalConfigPath, JSON.stringify(existing, null, 2), {
      mode: 0o600,
    });
  });
}
