import type { SlashCommand } from '@wrongstack/contracts/types';

/**
 * Arguments passed to `createExitSlashCommand`. The handler runs inside the
 * TUI shell, so it owns the lifecycle of in-flight subagents and the exit
 * decision; the dispatcher above only knows how to bridge the prompt.
 */
export interface CreateExitSlashCommandOptions {
  /** True while the leader agent.run() loop is still active. */
  isLeaderActive: () => boolean;
  /** Number of subagents currently in the running state. */
  countRunningSubagents: () => number;
  /** Number of detached jobs that will be preserved when the TUI exits. */
  countBackgroundProcesses?: (() => number) | undefined;
  /**
   * Bridge into the TUI's `exitConfirm` reducer slot. Returns the user's
   * decision (`true` to exit, `false` to cancel). When no work is active,
   * the bridge returns `true` synchronously so the slash command resolves
   * to `{ exit: true }` without opening the modal.
   */
  confirmExit: (info: {
    leaderActive: boolean;
    subagentCount: number;
    backgroundCount?: number | undefined;
  }) => Promise<boolean>;
  /**
   * Original host-owned `/exit` handler. It owns pre-exit checks and process
   * teardown (MCP, fleet host, plugin handlers); the TUI only adds its active
   * work confirmation in front of that lifecycle.
   */
  runExitLifecycle?: SlashCommand['run'] | undefined;
}

const DESCRIPTION =
  'Exit the TUI. While a leader run or any subagent is still active, ' +
  'asks for an explicit Enter/Esc confirmation before terminating them.';

const USAGE = 'Usage:\n  /exit — terminate the TUI (asks for confirmation while work is active)';

/**
 * Register `/exit` as a TUI slash command. The confirmation panel mirrors
 * the `/clear` invariant: never tear down in-flight work silently.
 *
 * The TUI slash dispatcher recognises the `exit: true` flag (it then
 * asks Ink to unmount and runs the graceful exit). We only return that
 * flag after the user has explicitly confirmed (or there is nothing to
 * confirm), so an accidental `/exit` while work is active becomes a
 * harmless "Exit cancelled." instead of an immediate teardown.
 */
export function createExitSlashCommand(opts: CreateExitSlashCommandOptions): SlashCommand {
  return {
    name: 'exit',
    aliases: ['quit', 'q'],
    description: DESCRIPTION,
    async run(args, ctx) {
      const trimmed = args.trim();
      // Help flags and any other non-empty argument short-circuit to USAGE
      // without consulting the runtime state. This is intentional: `/exit
      // --help` must remain a non-destructive informational invocation even
      // when work is active, so a user asking for help never silently
      // confirms an exit they did not intend.
      if (trimmed.length > 0) {
        return { message: USAGE };
      }
      const leaderActive = opts.isLeaderActive();
      const subagentCount = opts.countRunningSubagents();
      const backgroundCount = opts.countBackgroundProcesses?.() ?? 0;
      const confirmed = await opts.confirmExit({
        leaderActive,
        subagentCount,
        ...(backgroundCount > 0 ? { backgroundCount } : {}),
      });
      if (!confirmed) {
        return { message: 'Exit cancelled.' };
      }
      const lifecycleResult = await opts.runExitLifecycle?.(args, ctx);
      const result = lifecycleResult ?? { exit: true, message: 'Exiting…' };
      if (backgroundCount === 0) return result;
      return {
        ...result,
        message: `${result.message ?? 'Exiting…'} Preserving ${backgroundCount} background process${backgroundCount === 1 ? '' : 'es'}.`,
      };
    },
  };
}
