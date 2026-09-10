import { detectTerminal, writeErr } from '@wrongstack/core/utils';
import type { RunTuiOptions } from './run-tui-options.js';
import { silenceTerminal } from './terminal-silence.js';

/** Capability profile + pointer-mode decision, resolved before Ink mounts. */
export interface TuiLaunchPlan {
  capability: ReturnType<typeof detectTerminal>;
  mouseEnabled: boolean;
}

/**
 * Everything that must be decided before Ink takes over the screen — moved
 * verbatim from runTui() (decomposition Phase 1 R1, docs/decomposition-plan.md):
 * the interactive-TTY guard, the one-time capability probe, the pointer-mode
 * opt-in, and the terminal-silence call.
 *
 * On a non-TTY invocation this writes the user-facing explanation and returns
 * `{ ok: false, exitCode: 2 }`; runTui() returns that code untouched.
 */
export function resolveTuiLaunchPlan(
  opts: RunTuiOptions,
): { ok: false; exitCode: number } | ({ ok: true } & TuiLaunchPlan) {
  const stdout = process.stdout;
  const stdin = process.stdin;

  // Ink requires a TTY on both stdin and stdout. Without this guard the
  // render call would fail with a terse internal Ink error; bail with a
  // clear message so a piped invocation (`echo hi | wstack --tui`) tells
  // the user what to do instead.
  if (!stdout.isTTY || !stdin.isTTY) {
    writeErr(
      'wstack: --tui requires an interactive terminal on both stdin and stdout.\n' +
        '       Drop the flag (use the plain REPL) or run wstack directly without piping.\n',
    );
    return { ok: false, exitCode: 2 };
  }

  // Probe terminal capabilities once — color depth, mouse protocol, title support.
  // Locked in at startup so the profile is stable throughout the session.
  const capability = detectTerminal({ stdin, stdout });

  // Resolve the full pointer-mode opt-in before taking over the screen. A
  // settings adapter is allowed to throw; doing this first guarantees such an
  // error cannot strand the terminal inside the alternate buffer.
  const mouseEnabled =
    opts.mouse ?? opts.getSettings?.().mouseMode ?? process.env.WRONGSTACK_MOUSE === '1';

  // Silence all console / stderr / process-warning output so external
  // writes don't interleave with Ink's terminal control sequences. See
  // the block comment above `silenceTerminal` for the full rationale.
  silenceTerminal();

  return { ok: true, capability, mouseEnabled };
}
