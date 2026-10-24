import type { SlashCommand } from '@wrongstack/contracts/types';
import type { Director } from '@wrongstack/core/coordination';
import type { RedoRewindResult } from '@wrongstack/core/storage';
import { toErrorMessage } from '@wrongstack/core/utils';
import { getProcessRegistry } from '@wrongstack/tools';
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import type { Action } from '../app-action-type.js';
import type { AppProps } from '../app-props.js';
import type { State } from '../app-state.js';
import { createChatSearchSlashCommand } from '../chat-search-slash.js';
import { createConnectionsSlashCommand } from '../connections-slash.js';
import { createContextSlashCommand } from '../context-slash.js';
import { createCronJobsGetter, createCronSlashCommand } from '../cron-slash.js';
import { createKanbanSlashCommand } from '../kanban-slash.js';
import { createKillSlashCommand } from '../kill-slash.js';
import type { MemoryContextMonitorState } from '../memory-context-monitor.js';
import { createMemorySlashCommand } from '../memory-slash.js';
import { createPsSlashCommand } from '../ps-slash.js';
import { showConversation, showRewind } from '../rewind-prompt.js';
import { registerSlashCommandLifecycle } from '../slash-command-lifecycle.js';
import { buildSteeringPreamble } from '../steering-preamble.js';
import { createWorkbenchSlashCommand } from '../workbench-slash.js';
import type { RewindOutcome } from './use-session-rewind.js';

interface CoreTuiCommandsOptions {
  agent: AppProps['agent'];
  slashRegistry: AppProps['slashRegistry'];
  memoryStore: AppProps['memoryStore'];
  onPanelOpen: AppProps['onPanelOpen'];
  memoryContextMonitorRef: MutableRefObject<MemoryContextMonitorState>;
  memoryRecordTotalRef: MutableRefObject<number | undefined>;
  stateRef: MutableRefObject<State>;
  boardFocusRef: MutableRefObject<{ current: (boardId: string) => boolean } | null>;
  setFocusedBoardId: Dispatch<SetStateAction<string | null>>;
  terminalWidth: number;
  getModeLabel: AppProps['getModeLabel'];
  activeCtrlRef: MutableRefObject<AbortController | null>;
  clearPendingConfirms: () => void;
  dispatch: Dispatch<Action>;
  liveDirector: () => Director | null | undefined;
  streamingTextRef: MutableRefObject<string>;
  director: AppProps['director'];
  handleRewindTo: (index: number) => Promise<RewindOutcome>;
  /** `/rewind redo`: undo the newest rewind. */
  handleRewindRedo: () => Promise<RedoRewindResult | null>;
  getSettings?: AppProps['getSettings'] | undefined;
}

/** Registers process/context/kanban/steer/rewind/agents commands. */
export function useCoreTuiCommands({
  agent,
  slashRegistry,
  memoryStore,
  onPanelOpen,
  memoryContextMonitorRef,
  memoryRecordTotalRef,
  stateRef,
  boardFocusRef,
  setFocusedBoardId,
  terminalWidth,
  getModeLabel,
  activeCtrlRef,
  clearPendingConfirms,
  dispatch,
  liveDirector,
  streamingTextRef,
  director,
  handleRewindTo,
  handleRewindRedo,
  getSettings,
}: CoreTuiCommandsOptions): {
  getCronJobs: ReturnType<typeof createCronJobsGetter>;
  runSteerSequence: (text: string) => {
    preamble: string;
    droppedCount: number;
    subagentsTerminated: number;
  };
} {
  const stdout = { columns: terminalWidth };
  const getCronJobs = useMemo(() => createCronJobsGetter(agent), [agent]);
  const getSettingsRef = useRef(getSettings);
  getSettingsRef.current = getSettings;
  useEffect(() => {
    const cleanups: Array<() => void> = [];
    cleanups.push(registerSlashCommandLifecycle(slashRegistry, createKillSlashCommand()));
    cleanups.push(registerSlashCommandLifecycle(slashRegistry, createPsSlashCommand()));
    cleanups.push(
      registerSlashCommandLifecycle(slashRegistry, createCronSlashCommand({ getCronJobs })),
    );
    if (memoryStore) {
      cleanups.push(
        registerSlashCommandLifecycle(slashRegistry, createMemorySlashCommand({ memoryStore })),
      );
    }

    // Bare `/context` opens the TUI panel, while typed forms retain the
    // canonical CLI behavior through the captured fallback.
    const existingContext = slashRegistry.get('context');
    const contextPanelCmd = createContextSlashCommand({
      onPanelOpen,
      fallback: existingContext,
      getSummary: () => {
        const leader = stateRef.current.leader;
        const memories = Object.values(memoryContextMonitorRef.current.memories);
        return {
          contextPct: leader.ctxPct,
          contextTokens: leader.ctxTokens,
          contextMaxTokens: leader.ctxMaxTokens,
          memoryTotal: memoryRecordTotalRef.current,
          memoryCtx: memories.filter((memory) => memory.state === 'active').length,
          memoryPending: memories.filter((memory) => memory.state === 'injected').length,
          memoryLeft: memories.filter((memory) => memory.state === 'exited').length,
        };
      },
    });
    cleanups.push(
      registerSlashCommandLifecycle(slashRegistry, contextPanelCmd, {
        owner: 'tui',
        official: true,
      }),
    );

    cleanups.push(
      registerSlashCommandLifecycle(slashRegistry, createConnectionsSlashCommand({ onPanelOpen })),
    );
    cleanups.push(
      registerSlashCommandLifecycle(
        slashRegistry,
        createChatSearchSlashCommand({
          dispatch,
          includeReasoning: () => getSettingsRef.current?.()?.showModelReasoning ?? true,
        }),
      ),
    );
    cleanups.push(
      registerSlashCommandLifecycle(
        slashRegistry,
        createKanbanSlashCommand({
          projectRoot: agent.ctx.projectRoot,
          sessionId: agent.ctx.eventSessionId(),
          onPanelOpen,
          onBoardFocus: boardFocusRef.current
            ? boardFocusRef.current
            : {
                current: (boardId: string) => {
                  setFocusedBoardId(boardId);
                  return true;
                },
              },
          terminalWidth: stdout.columns ?? 80,
        }),
      ),
    );
    // `/flow` — the text-first cross-board view for terminals where the
    // visual Workbench panel is closed. It shipped fully implemented and
    // tested but was never mounted, so `createWorkbenchSlashCommand` sat in
    // `architecture/test-only-exports.json`: green coverage proving the
    // function works while no user could reach the command.
    cleanups.push(
      registerSlashCommandLifecycle(
        slashRegistry,
        createWorkbenchSlashCommand({ projectRoot: agent.ctx.projectRoot }),
      ),
    );
    return () => {
      for (const cleanup of cleanups.reverse()) cleanup();
    };
  }, [
    slashRegistry,
    memoryStore,
    agent.ctx.cwd,
    agent.ctx.projectRoot,
    agent.ctx.provider,
    agent.ctx.model,
    getModeLabel,
    getCronJobs,
  ]);

  // Kill foreground children when the TUI unmounts. Explicit background
  // launches are detached jobs and must survive a normal host shutdown.
  // This fires on natural exit, Ctrl+C, and any other unmount path,
  // ensuring no orphaned child processes survive after the session ends.
  useEffect(() => {
    return () => {
      getProcessRegistry().killAll({ preserveBackground: true });
    };
  }, []);

  // Shared steer sequence — the abort/terminate/queue-drop/preamble dance used
  // by both `/steer` and the mid-run send-mode picker's "steer" choice. Reads
  // the live state via refs so it stays correct regardless of which render's
  // closure invokes it. Returns the STEERING preamble (to submit as the next
  // turn) plus the counts each caller needs for its own status line.
  const runSteerSequence = useCallback(
    (text: string): { preamble: string; droppedCount: number; subagentsTerminated: number } => {
      const s = stateRef.current;
      const runningTools = Array.from(s.runningTools.values()).map((t) => t.name);
      const subagents = Object.values(s.fleet)
        .filter((e) => e.status === 'running')
        .map((e) => ({ label: e.name, status: e.status, tool: e.currentTool?.name }));
      const subagentsTerminated = subagents.length;
      const partialAssistantText = streamingTextRef.current.slice(-1500);
      const snapshot = { runningTools, subagents, subagentsTerminated, partialAssistantText };

      activeCtrlRef.current?.abort('user interrupt (/steer)');
      clearPendingConfirms();
      dispatch({ type: 'steerStart', snapshot });
      const droppedCount = s.queue.length;
      if (droppedCount > 0) dispatch({ type: 'queueClear' });
      const steerDir = liveDirector();
      if (steerDir && subagentsTerminated > 0) {
        const cap = new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 1500);
          t.unref?.();
        });
        void Promise.race([steerDir.terminateAll().catch(() => undefined), cap]);
      }
      const preamble = buildSteeringPreamble(snapshot, text);
      // Consume immediately — the preamble already carries the steering frame;
      // the steeringPending flag would otherwise double up on the next submit.
      dispatch({ type: 'steerConsume' });
      return { preamble, droppedCount, subagentsTerminated };
    },
    [liveDirector, clearPendingConfirms, dispatch],
  );

  // `/steer <message>` — slash-command equivalent of Esc-to-steer.
  // Useful when Esc is consumed by an outer terminal multiplexer, or
  // when the user wants a single-shot redirect without the typed
  // follow-up (the message is the new direction). Performs the same
  // sequence the Esc handler does: snapshot context, abort the active
  // run, terminate the fleet, drop the queue, then sets steeringPending
  // so the message — submitted as the slash command's return — picks
  // up the rich STEERING preamble in the normal submit path.
  //
  // Unlike Esc, this slash command can be invoked at any state. When
  // the agent is idle the abort and fleet-termination are no-ops; the
  // steering preamble still gets prepended, which is harmless extra
  // context ("nothing was running") for the next turn.
  useEffect(() => {
    const cmd = {
      name: 'steer',
      description: 'Interrupt the running agent (incl. fleet) and redirect: /steer <new direction>',
      help: [
        'Usage: /steer <new direction>',
        '',
        'Aborts the active iteration, terminates any running subagents,',
        'drops queued messages, and sends your text to the model with a',
        'STEERING preamble explaining what was in flight and what the',
        'model is authorised to do (pivot hard, respawn subagents, ask',
        'for clarification). Equivalent to pressing Esc then typing.',
      ].join('\n'),
      async run(args: string) {
        const text = args.trim();
        if (!text) {
          return { message: 'Usage: /steer <new direction>' };
        }
        // Shared sequence: snapshot + abort + terminate fleet + drop queue +
        // build the preamble. Returned as the slash command's `runText` so the
        // submit pipeline sends THIS to the model instead of "/steer …".
        const { preamble, droppedCount, subagentsTerminated } = runSteerSequence(text);

        const droppedTag = droppedCount > 0 ? ` · dropped ${droppedCount} queued` : '';
        const fleetTag =
          subagentsTerminated > 0
            ? ` · stopped ${subagentsTerminated} subagent${subagentsTerminated === 1 ? '' : 's'}`
            : '';
        return {
          message: `↯ Steering${droppedTag}${fleetTag}.`,
          runText: preamble,
        };
      },
    };
    return registerSlashCommandLifecycle(slashRegistry, cmd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashRegistry, director, runSteerSequence]);

  // `/rewind` — open the checkpoint timeline overlay. If a checkpoint
  // index is provided as argument, rewinds directly to it.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- handleRewindTo is stable via useCallback
  useEffect(() => {
    const cmd = {
      name: 'rewind',
      description:
        'Open checkpoint timeline to rewind session: /rewind [checkpoint-index] | /rewind redo',
      help: [
        'Usage: /rewind [checkpoint-index]',
        '       /rewind redo   undo the last rewind (until the next prompt)',
        '',
        'Opens a checkpoint timeline. Use ↑/↓ to navigate, Enter to rewind,',
        'Esc to cancel. The session is reverted to the selected checkpoint',
        'and conversation history is truncated — LLM continues fresh.',
        '',
        'If a checkpoint index is provided the timeline is skipped and',
        'rewind happens immediately.',
      ].join('\n'),
      async run(args: string) {
        // Rewind and redo stop the session's producers, which advances the
        // session generation; this flag keeps their own result from being
        // dropped as stale output.
        const metadata = { advancedSessionGeneration: true };
        if (args.trim().toLowerCase() === 'redo') {
          let result: RedoRewindResult | null;
          try {
            result = await handleRewindRedo();
          } catch (err) {
            return { message: `Redo failed: ${toErrorMessage(err)}`, metadata };
          }
          if (!result) return { message: 'Nothing to redo: no rewind since the last prompt.' };
          if (result.conflicts.length > 0) {
            return {
              message: [
                'Redo refused, nothing changed:',
                ...result.conflicts.map((c) => `  ${c}`),
              ].join('\n'),
              metadata,
            };
          }
          for (const cp of result.checkpoints) dispatch({ type: 'checkpointReceived', cp });
          if (result.conversation) showConversation(dispatch, result.conversation);
          const files = result.reappliedFiles.length;
          return {
            message: `Redid the rewind to checkpoint #${result.toPromptIndex}: ${result.restoredEvents} journal events and ${files} file${files === 1 ? '' : 's'} restored; the model sees the full conversation again.`,
            metadata,
          };
        }
        const idx = Number.parseInt(args.trim(), 10);
        if (!Number.isNaN(idx) && idx >= 0) {
          // Awaited: rewindToCheckpoint throws SessionError for an unknown
          // index, and an un-awaited rejection would surface as nothing at all.
          const draft = stateRef.current.buffer;
          try {
            showRewind(dispatch, draft, await handleRewindTo(idx));
          } catch (err) {
            return { message: `Rewind failed: ${toErrorMessage(err)}`, metadata };
          }
          return { metadata };
        }
        // No arg — open the timeline overlay
        const s = stateRef.current;
        if (s.checkpoints.length === 0) {
          return { message: 'No checkpoints in this session yet.' };
        }
        dispatch({ type: 'rewindOverlayOpen' });
        return {};
      },
    };
    return registerSlashCommandLifecycle(slashRegistry, cmd);
  }, [slashRegistry, handleRewindTo, handleRewindRedo, dispatch]);

  // `/agents` — bare `/agents` and `/agents monitor` toggle the overlay.
  // Typed forms delegate to the canonical host command captured before the
  // official TUI override is installed.
  useEffect(() => {
    const original = slashRegistry.get('agents');
    const cmd: SlashCommand = {
      name: 'agents',
      description: original?.description ?? 'Toggle the agents monitor overlay.',
      argsHint: original?.argsHint,
      help: original?.help,
      async run(args: string, ctx) {
        const arg = args.trim().toLowerCase();
        if (!arg || arg === 'monitor') {
          dispatch({ type: 'toggleAgentsMonitor' });
          return { message: undefined };
        }
        return original?.run(args, ctx) ?? { message: '/agents is unavailable.' };
      },
    };
    return registerSlashCommandLifecycle(slashRegistry, cmd, {
      owner: 'tui',
      official: true,
    });
  }, [slashRegistry, dispatch]);

  return { getCronJobs, runSteerSequence };
}
