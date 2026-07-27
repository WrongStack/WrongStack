import type { Director } from '@wrongstack/core/coordination';
import type { SlashCommand } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { getProcessRegistry } from '@wrongstack/tools';
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
} from 'react';
import type { AppProps } from '../app-props.js';
import type { Action } from '../app-action-type.js';
import type { State } from '../app-state.js';
import { createContextSlashCommand } from '../context-slash.js';
import { createCronJobsGetter, createCronSlashCommand } from '../cron-slash.js';
import { createKanbanSlashCommand } from '../kanban-slash.js';
import { createKillSlashCommand } from '../kill-slash.js';
import type { MemoryContextMonitorState } from '../memory-context-monitor.js';
import { createMemorySlashCommand } from '../memory-slash.js';
import { createPsSlashCommand } from '../ps-slash.js';
import { buildSteeringPreamble } from '../steering-preamble.js';

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
  handleRewindTo: (index: number) => Promise<void>;
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
  useEffect(() => {
    slashRegistry.register(createKillSlashCommand());
    slashRegistry.register(createPsSlashCommand());
    slashRegistry.register(createCronSlashCommand({ getCronJobs }));
    if (memoryStore) {
      slashRegistry.register(createMemorySlashCommand({ memoryStore }));
    }
    // `/context` — the panel wrapper must WIN over the CLI's text `context`
    // command. The registry's rule is "first core registration of a name
    // wins" and the CLI registers `buildContextCommand` first at boot, so a
    // plain register() here is a silent no-op (that was the bug: bare
    // /context printed the text summary and the panel never opened).
    //
    // Fix: capture the CLI command as the delegate `fallback`, unregister it
    // (clears the bare name + `ctx` alias), then register the wrapper which
    // reclaims both. The `__panelWrapper` sentinel makes this idempotent —
    // on any re-run of this effect the wrapper is already installed, so we
    // must NOT re-capture (that would nest wrappers and drop the CLI command).
    {
      const existingContext = slashRegistry.get('context') as
        | (SlashCommand & { __panelWrapper?: boolean })
        | undefined;
      if (!existingContext?.__panelWrapper) {
        if (existingContext) slashRegistry.unregister('context');
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
        }) as SlashCommand & { __panelWrapper?: boolean };
        contextPanelCmd.__panelWrapper = true;
        slashRegistry.register(contextPanelCmd);
      }
    }
    // `/kanban` — open the project kanban panel, create a board, add a task,
    // or list boards. Mirrors the WebUI `kanban` text surface so users get
    // the same operations in either client. The panel-open bridge is shared
    // with `/context`; without it the command would have to fall back to
    // text-only and lose the "open panel" affordance.
    slashRegistry.register(
      createKanbanSlashCommand({
        projectRoot: agent.ctx.projectRoot,
        sessionId: agent.ctx.session?.id ?? null,
        onPanelOpen,
        // Goal → Kanban bridge & `/kanban use <boardId>` both arrive here.
        // We capture a `focusedBoardId` and pass it down as `initialBoardId`
        // so the panel lands on the requested board rather than defaulting
        // to the session-tag fallback.
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
    );
    return () => {
      slashRegistry.unregister('kill');
      slashRegistry.unregister('ps');
      slashRegistry.unregister('cron');
      if (memoryStore) {
        slashRegistry.unregister('memory');
      }
      slashRegistry.unregister('context');
      slashRegistry.unregister('kanban');
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
    slashRegistry.register(cmd);
    return () => {
      slashRegistry.unregister('steer');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashRegistry, director, runSteerSequence]);

  // `/rewind` — open the checkpoint timeline overlay. If a checkpoint
  // index is provided as argument, rewinds directly to it.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- handleRewindTo is stable via useCallback
  useEffect(() => {
    const cmd = {
      name: 'rewind',
      description: 'Open checkpoint timeline to rewind session: /rewind [checkpoint-index]',
      help: [
        'Usage: /rewind [checkpoint-index]',
        '',
        'Opens a checkpoint timeline. Use ↑/↓ to navigate, Enter to rewind,',
        'Esc to cancel. The session is reverted to the selected checkpoint',
        'and conversation history is truncated — LLM continues fresh.',
        '',
        'If a checkpoint index is provided the timeline is skipped and',
        'rewind happens immediately.',
      ].join('\n'),
      async run(args: string) {
        const idx = Number.parseInt(args.trim(), 10);
        if (!Number.isNaN(idx) && idx >= 0) {
          // Awaited: rewindToCheckpoint throws SessionError for an unknown
          // index, and an un-awaited rejection would surface as nothing at all.
          try {
            await handleRewindTo(idx);
          } catch (err) {
            return { message: `Rewind failed: ${toErrorMessage(err)}` };
          }
          return {};
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
    slashRegistry.register(cmd);
    return () => {
      slashRegistry.unregister('rewind');
    };
  }, [slashRegistry, handleRewindTo]);

  // `/agents` — bare `/agents` and `/agents monitor` toggle the overlay.
  // `/agents <id>` falls through to the CLI builtin (same-name registration
  // from the same 'core' owner is a no-op per SlashCommandRegistry semantics,
  // so we own the bare/monitor forms here and let the builtin handle IDs).
  useEffect(() => {
    const cmd = {
      name: 'agents',
      description: 'Toggle the agents monitor overlay.',
      async run(args: string) {
        const arg = args.trim().toLowerCase();
        if (!arg || arg === 'monitor') {
          dispatch({ type: 'toggleAgentsMonitor' });
          return { message: undefined };
        }
        // Any other arg falls through to the CLI builtin (same owner
        // 'core' re-registration = silently ignored). The builtin handles
        // onAgents UUID lookups and /agents on|off.
        return { message: undefined };
      },
    };
    slashRegistry.register(cmd);
    return () => {
      slashRegistry.unregister('agents');
    };
  }, [slashRegistry]);

  return { getCronJobs, runSteerSequence };
}
