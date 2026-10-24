/** Boot-time launch choices: system-prompt variant, mode, YOLO and autonomy (prompted or defaulted). */

import type { Config } from '@wrongstack/contracts/types';
import { color, toErrorMessage, type WstackPaths, writeErr } from '@wrongstack/core/utils';
import { maybeRunSystemPromptMenu } from './boot/system-prompt-menu.js';
import type { BootPhaseExit } from './boot-provider-gate.js';
import {
  REUSE_STARTUP_CHOICES_HINT,
  shouldPrintYoloNotice,
  shouldReuseStartupChoices,
} from './boot-provider-selection.js';
import type { ReadlineInputReader } from './input-reader.js';
import {
  isOutsideProject,
  LaunchAbortedError,
  persistLaunchChoices,
  promptStopAskingStartupQuestions,
  runLaunchPrompts,
} from './pre-launch.js';
import type { TerminalRenderer } from './renderer.js';
import { patchConfig } from './utils.js';

export interface BootLaunchInput {
  isInteractiveTTY: boolean;
  simpleUiFullAuto: boolean;
  flags: Record<string, string | boolean>;
  config: Config;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  profileConfigPath: string;
  wpaths: WstackPaths;
  projectRoot: string;
}

export async function applyBootLaunchChoices(
  input: BootLaunchInput,
): Promise<BootPhaseExit | { kind: 'ok'; config: Config }> {
  let { config } = input;
  const {
    isInteractiveTTY,
    simpleUiFullAuto,
    flags,
    renderer,
    reader,
    profileConfigPath,
    wpaths,
    projectRoot,
  } = input;
  if (isInteractiveTTY) {
    const reuseLast = shouldReuseStartupChoices(config);
    // System prompt (Lite / Standard / Pro). The gate itself lives in
    // `maybeRunSystemPromptMenu` so the non-TTY skip is unit-testable —
    // as a bare `if` here it was unreachable from any test.
    const promptMenu = await maybeRunSystemPromptMenu({
      isInteractiveTTY,
      flags,
      renderer,
      reader,
      profileConfigPath,
      paths: {
        globalDir: wpaths.globalInstructions,
        projectDir: wpaths.inProjectInstructions,
      },
      outsideProject: await isOutsideProject(projectRoot),
      reuseLast,
    });
    if (promptMenu.aborted) {
      await reader.close();
      return { kind: 'exit' as const, code: 0 };
    }
    if (promptMenu.changed && promptMenu.variant) {
      config = patchConfig(config, { systemPrompt: { variant: promptMenu.variant } });
    }
    if (promptMenu.persistError) {
      renderer.writeWarning(
        `Could not save system prompt variant to config: ${toErrorMessage(promptMenu.persistError)}\n`,
      );
    }

    let modePinned: 'tui' | 'repl' | undefined;
    if (flags['no-tui']) modePinned = 'repl';
    else if (flags['tui']) modePinned = 'tui';
    const yoloPinned: boolean | undefined =
      flags['no-yolo'] === true ? false : flags['yolo'] === true ? true : undefined;
    let autonomyPinned: 'off' | 'auto' | undefined;
    if (flags['no-autonomy'] === true) autonomyPinned = 'off';
    // `--eternal "<mission>"` starts the engine directly, so the launch prompt
    // must not ask (and persist) autonomy. The engine starts only for a
    // mission STRING (cli-main-orchestration); `=== true` matched only the
    // bare, mission-less form, which starts nothing.
    else if (typeof flags['eternal'] === 'string' && flags['eternal'].trim() !== '')
      autonomyPinned = 'off';
    else if (typeof flags['autonomy'] === 'string') {
      const v = (flags['autonomy'] as string).toLowerCase();
      autonomyPinned = v === 'off' || v === 'no' || v === 'false' ? 'off' : 'auto';
    } else if (flags['autonomy'] === true) {
      autonomyPinned = 'auto';
    }

    // Build saved preferences from config so the prompt can offer a one-line
    // "Continue with these?" summary instead of re-asking every question.
    const lastChoices = config.launch
      ? {
          mode: config.launch.mode ?? 'tui',
          yolo: config.yolo ?? true,
          autonomy: config.launch.autonomy ?? 'auto',
        }
      : undefined;

    let choices: Awaited<ReturnType<typeof runLaunchPrompts>>;
    try {
      choices = await runLaunchPrompts({
        renderer,
        reader,
        modePinned,
        yoloPinned,
        autonomyPinned,
        lastChoices,
        reuseLast,
      });
    } catch (err) {
      if (err instanceof LaunchAbortedError) {
        await reader.close();
        return { kind: 'exit' as const, code: 0 };
      }
      throw err;
    }
    if (choices.mode === 'tui') {
      flags['tui'] = true;
      flags['no-tui'] = false;
    } else {
      flags['tui'] = false;
      flags['no-tui'] = true;
    }
    if (choices.yolo !== config.yolo) config = patchConfig(config, { yolo: choices.yolo });
    flags['autonomy'] = choices.autonomy;

    // First-run YOLO disclosure: when YOLO auto-enabled on the very first
    // interactive launch and was not explicitly pinned via --yolo or
    // --no-yolo, print a one-time notice to stderr so the user is aware
    // that non-denied tool calls (shell, file writes, etc.) run without
    // confirmation.
    if (shouldPrintYoloNotice(lastChoices, yoloPinned, choices.yolo)) {
      writeErr(
        `\n  ${color.yellow('YOLO is on')}: non-denied tool calls, including shell and file writes, run without confirmation.\n` +
          `  ${color.dim('Damaging calls and calls your deny rules forbid still ask. Use')} --no-yolo ${color.dim('or')} /yolo off ${color.dim('to require prompts.')}\n\n`,
      );
    }

    // --skip-index / --skip suppresses startup codebase indexing.
    if ((flags['skip-index'] || flags['skip']) && config.indexing) {
      config = patchConfig(config, {
        indexing: { ...config.indexing, onSessionStart: false },
      });
    }

    if (reuseLast && lastChoices) {
      renderer.write(`  ${color.dim(REUSE_STARTUP_CHOICES_HINT)}\n\n`);
    }

    // "Reuse startup choices" is off and the gates above actually asked
    // something: offer to stop asking from the next launch on. The system-
    // prompt menu ran when it returned a variant; the launch gate asked when
    // saved choices existed and not every field was flag-pinned.
    const launchGateAsked =
      lastChoices !== undefined &&
      !(modePinned !== undefined && yoloPinned !== undefined && autonomyPinned !== undefined);
    let rememberStartupChoices: boolean | undefined;
    if (!reuseLast && (promptMenu.variant !== undefined || launchGateAsked)) {
      if (await promptStopAskingStartupQuestions({ renderer, reader })) {
        rememberStartupChoices = true;
        config = patchConfig(config, {
          launch: { ...config.launch, rememberStartupChoices: true },
        });
      }
    }

    // Persist launch preferences so the next boot remembers them.
    // When --webui is active the mode is pinned to REPL (TUI owns stdout),
    // but we must NOT persist that choice — the user's last non-webui mode
    // (likely TUI) should survive so the next plain `wstack` session returns
    // to their preferred surface instead of silently landing in REPL.
    if (!simpleUiFullAuto) {
      try {
        const toPersist = flags['webui']
          ? { ...choices, mode: lastChoices?.mode ?? config.launch?.mode ?? 'tui' }
          : choices;
        await persistLaunchChoices(profileConfigPath, toPersist, { rememberStartupChoices });
      } catch {
        // Best-effort — never blocks launch.
      }
    }
  } else {
    // When skipping interactive prompts (--webui or --no-interactive), use saved
    // preferences or sensible defaults. Director stays OFF in non-interactive mode.
    // Autonomy defaults to the configured defaultMode (now 'auto') so non-interactive
    // sessions self-drive too — unless the user explicitly opts out with --no-autonomy
    // (or sets autonomy.defaultMode: 'off' in config).
    // Launch autonomy only supports 'off' | 'auto' (no 'suggest' surface here).
    // Respect an explicit opt-out (--no-autonomy or defaultMode 'off'); otherwise
    // default to 'auto' so non-interactive sessions self-drive too.
    const nonInteractiveAutonomy: 'off' | 'auto' =
      !simpleUiFullAuto && (flags['no-autonomy'] === true || config.autonomy?.defaultMode === 'off')
        ? 'off'
        : 'auto';
    const effectiveChoices = config.launch
      ? {
          mode: flags['no-tui'] ? 'repl' : (config.launch.mode ?? 'tui'),
          yolo: config.yolo ?? true,
          autonomy: nonInteractiveAutonomy,
        }
      : {
          mode: 'repl',
          yolo: true,
          autonomy: nonInteractiveAutonomy,
        };

    if (effectiveChoices.mode === 'repl') {
      flags['tui'] = false;
      flags['no-tui'] = true;
    }
    flags['autonomy'] = effectiveChoices.autonomy;
  }
  return { kind: 'ok', config };
}
