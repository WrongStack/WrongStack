// Launch prompts — interactive mode (TUI/REPL), YOLO, Director, and Autonomy,
// plus the summary gate that offers to repeat saved preferences and the
// atomic write of the resolved choices back to the global config.

import * as fs from 'node:fs/promises';
import { atomicWrite, color } from '@wrongstack/core/utils';
import type { ReadlineInputReader } from '../input-reader.js';
import type { TerminalRenderer } from '../renderer.js';

export interface LaunchModeChoices {
  /** TUI or plain REPL. */
  mode: 'tui' | 'repl';
  /** Auto-approve tool calls except explicit deny rules. */
  yolo: boolean;
  /** Initial autonomy mode. 'off' = stops after each turn; 'auto' = self-driving. */
  autonomy: 'off' | 'auto';
}

/**
 * Thrown by runLaunchPrompts when the user presses q to cancel.
 * Caught by boot.ts so it can exit cleanly without process.exit().
 */
export class LaunchAbortedError extends Error {
  readonly exitCode = 0;
  constructor() {
    super('Launch cancelled by user');
    this.name = 'LaunchAbortedError';
  }
}

/**
 * Ask for interactive mode (TUI vs REPL), YOLO, Director, and Autonomy.
 * Each prompt is skipped when the corresponding option is pinned via CLI
 * flag. Returns the resolved set.
 *
 * When `lastChoices` is provided (from saved config), the function shows a
 * one-line summary and asks **one** question: "Continue with these?" instead
 * of re-asking every prompt individually.
 *
 * @throws LaunchAbortedError when the user presses q to cancel.
 */
export async function runLaunchPrompts(opts: {
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  modePinned?: 'tui' | 'repl' | undefined;
  yoloPinned?: boolean | undefined;
  autonomyPinned?: 'off' | 'auto' | undefined;
  /** Saved launch preferences from a previous session (persisted to config). */
  lastChoices?: LaunchModeChoices | undefined;
}): Promise<LaunchModeChoices> {
  const { renderer, reader, modePinned, yoloPinned, autonomyPinned, lastChoices } = opts;

  // If EVERY field is pinned by CLI flags, skip all prompts entirely.
  if (modePinned !== undefined && yoloPinned !== undefined && autonomyPinned !== undefined) {
    return {
      mode: modePinned,
      yolo: yoloPinned,
      autonomy: autonomyPinned,
    };
  }

  // --- First run (no saved preferences): use the built-in defaults silently ---
  // The user explicitly asked for "yolo on" and "autonomy auto"
  // by default at first install. No prompts on the first launch — the new
  // defaults are applied without asking. The summary gate kicks in on the
  // SECOND launch (after persistLaunchChoices has written the first run's
  // values to the global config).
  if (!lastChoices) {
    return {
      mode: modePinned ?? 'tui',
      yolo: yoloPinned ?? true,
      autonomy: autonomyPinned ?? 'auto',
    };
  }

  // --- Override detection: at least one CLI flag diverges from saved ---
  // If the user has saved preferences but explicitly passes a different value
  // for any of the 3 fields via CLI flags, skip the summary gate and go
  // straight to individual prompts. The user is "explicitly changing
  // settings from the start", which is what the request described.
  const hasOverride =
    (modePinned !== undefined && modePinned !== lastChoices.mode) ||
    (yoloPinned !== undefined && yoloPinned !== lastChoices.yolo) ||
    (autonomyPinned !== undefined && autonomyPinned !== lastChoices.autonomy);

  // --- Summary gate: when saved preferences exist, show them + one question ---
  if (lastChoices && !hasOverride) {
    // Merge: pinned values override saved preferences.
    const effective = {
      mode: modePinned ?? lastChoices.mode,
      yolo: yoloPinned ?? lastChoices.yolo,
      autonomy: autonomyPinned ?? lastChoices.autonomy,
    };

    const onOff = (v: boolean) => (v ? color.green('on') : color.dim('off'));
    const modeLabel = effective.mode.toUpperCase();

    renderer.write(
      `\n  ${color.dim('Last settings:')} ${color.bold(modeLabel)} · YOLO ${onOff(effective.yolo)} · Autonomy ${effective.autonomy === 'auto' ? color.green('auto') : color.dim('off')}\n`,
    );

    const answer = (
      await reader.readLine(
        `  ${color.amber('?')} Continue with these? ${color.dim('[Y/n/q]')} ${color.dim('(auto Y in 5s)')} `,
        { timeoutMs: 5000, defaultAnswer: 'y' },
      )
    )
      .trim()
      .toLowerCase();

    if (answer === 'q') {
      renderer.write(color.dim('  Goodbye!\n'));
      throw new LaunchAbortedError();
    }

    if (answer !== 'n' && answer !== 'no') {
      // User accepted — proceed with effective values.
      const badges = buildBadges(effective);
      const badgeStr = badges.length > 0 ? ` (${badges.join(' · ')})` : '';
      renderer.write(
        `\n  ${color.green('▶')} Launching in ${color.bold(modeLabel)} mode${badgeStr}\n\n`,
      );
      return effective;
    }

    // User said no — fall through to individual prompts.
  }

  // --- Individual prompts (existing behavior, one at a time) ---
  let mode: 'tui' | 'repl';
  if (modePinned) {
    mode = modePinned;
  } else {
    const answer = (
      await reader.readLine(
        `\n  ${color.amber('?')} Interactive mode: ${color.bold('T')}UI / ${color.bold('R')}EPL ${color.dim('[T/r/q]')} `,
      )
    )
      .trim()
      .toLowerCase();
    if (answer === 'q') {
      renderer.write(color.dim('  Goodbye!\n'));
      throw new LaunchAbortedError();
    }
    mode = answer === 'r' || answer === 'repl' ? 'repl' : 'tui';
  }

  let yolo: boolean;
  if (yoloPinned !== undefined && yoloPinned === lastChoices?.yolo) {
    yolo = yoloPinned;
  } else {
    const answer = (
      await reader.readLine(
        `  ${color.amber('?')} YOLO mode ${color.dim('(auto-approve tool calls)')} ${color.dim('[Y/n/q]')} `,
      )
    )
      .trim()
      .toLowerCase();
    if (answer === 'q') {
      renderer.write(color.dim('  Goodbye!\n'));
      throw new LaunchAbortedError();
    }
    yolo = answer !== 'n' && answer !== 'no';
  }

  // (Director Mode is permanently on — no prompt needed)

  let autonomy: 'off' | 'auto';
  if (autonomyPinned !== undefined && autonomyPinned === lastChoices?.autonomy) {
    autonomy = autonomyPinned;
  } else {
    const answer = (
      await reader.readLine(
        `  ${color.amber('?')} Autonomy mode ${color.dim('(auto-continue — agent picks next step)')} ${color.dim('[Y/n/q]')} `,
      )
    )
      .trim()
      .toLowerCase();
    if (answer === 'q') {
      renderer.write(color.dim('  Goodbye!\n'));
      throw new LaunchAbortedError();
    }
    autonomy = answer !== 'n' && answer !== 'no' ? 'auto' : 'off';
  }

  const badges = buildBadges({ mode, yolo, autonomy });
  const badgeStr = badges.length > 0 ? ` (${badges.join(' · ')})` : '';
  renderer.write(
    `\n  ${color.green('▶')} Launching in ${color.bold(mode.toUpperCase())} mode${badgeStr}\n\n`,
  );

  return { mode, yolo, autonomy };
}

/** Build the mode-badge labels shown in the launch line. */
function buildBadges(chosen: LaunchModeChoices): string[] {
  const badges: string[] = [];
  if (chosen.yolo) badges.push(color.yellow('YOLO'));
  if (chosen.autonomy !== 'off')
    badges.push(color.magenta(`AUTONOMY:${chosen.autonomy.toUpperCase()}`));
  return badges;
}

/**
 * Persist the user's launch-mode choices (mode, yolo, autonomy)
 * back to the global config file so the next boot can offer a one-line
 * "Continue with these?" summary instead of re-asking every question.
 *
 * Reads the existing config, updates only the `yolo` and `launch` keys,
 * and writes back atomically. Other fields (including encrypted secrets)
 * pass through round-trip unchanged.
 */
export async function persistLaunchChoices(
  configPath: string,
  choices: LaunchModeChoices,
): Promise<void> {
  let fileExists = false;
  try {
    await fs.access(configPath);
    fileExists = true;
  } catch {}

  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if (fileExists) {
      throw new Error(
        `Refusing to overwrite corrupt config at ${configPath} ` +
          `(${(err as Error).message}). Fix or move the file aside before retrying.`,
        { cause: err },
      );
    }
    // No existing file — start fresh, that's fine.
    existing = {};
  }

  existing.yolo = choices.yolo;
  existing.launch = {
    mode: choices.mode,
    autonomy: choices.autonomy,
  };

  await atomicWrite(configPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
}
