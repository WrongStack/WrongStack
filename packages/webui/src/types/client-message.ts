import type { BrainConfigPatchWire } from './brain.js';
import type { ChronicleFacet, ChronicleMetricsView, ChronicleQuery } from './chronicle.js';
import type {
  WSCollabAnnotate,
  WSCollabGrantControl,
  WSCollabInjectTool,
  WSCollabJoin,
  WSCollabLeave,
  WSCollabRequestPause,
  WSCollabResolve,
  WSCollabResume,
} from './collab.js';
import type { SessionScopedPayload, WSUserMessage } from './protocol-core.js';
import type {
  ContextEditorMessage,
  ContextEditorRemoval,
  WSModelSwitch,
  WSToolConfirmResult,
} from './runtime.js';
import type { SageAnchor, SageScope, SageStatus, WSMemorySageForFileRequest } from './sage.js';
import type { OAuthKind, WSCompletionRequest } from './system.js';

/** Metadata persisted by the custom-provider model editor in provider add/update messages. */
export interface ProviderCustomModelWire {
  name?: string | undefined;
  maxOutput?: number | undefined;
  capabilities?:
    | {
        maxContext?: number | undefined;
        maxOutput?: number | undefined;
        tools?: boolean | undefined;
        vision?: boolean | undefined;
        reasoning?: boolean | undefined;
        streaming?: boolean | undefined;
        jsonMode?: boolean | undefined;
      }
    | undefined;
  /**
   * Full models.dev model payload (ME-2/ME-3). Stores all schema fields for
   * catalog overrides (delta) and custom (non-catalog) models. Validated
   * server-side by the ME-1 zod schema before persistence.
   */
  modelsDev?: Record<string, unknown> | undefined;
}

export type WSClientMessageCore =
  | WSUserMessage
  | {
      type: 'topic.advice';
      payload: SessionScopedPayload & { requestId: string; prompt: string };
    }
  | {
      /** Ask the server which persisted Chimera review reports a session has, or query all. */
      type: 'chimera.reports.list' | 'chimera.reports.query';
      payload: SessionScopedPayload & {
        sessionId?: string | undefined;
        all?: boolean | undefined;
        lifecycle?: string | undefined;
        limit?: number | undefined;
      };
    }
  | {
      /** Fetch full details (findings + journal events) for a Chimera report. */
      type: 'chimera.report.get';
      payload: { reportId: string };
    }
  | {
      /** Transition a Chimera report lifecycle. */
      type: 'chimera.report.transition';
      payload: { reportId: string; to: string; reason?: string | undefined };
    }
  | {
      /** Add an annotation note to a Chimera report. */
      type: 'chimera.report.add_note';
      payload: { reportId: string; note: string };
    }
  | {
      /** Transition a Chimera finding lifecycle. */
      type: 'chimera.finding.transition';
      payload: {
        findingId: string;
        to: string;
        outcome?: string | undefined;
        reason?: string | undefined;
      };
    }
  | WSToolConfirmResult
  | { type: 'side_effects.list'; payload?: SessionScopedPayload | undefined }
  | {
      type: 'goal.start';
      payload: {
        title: string;
        phases?: unknown[] | undefined;
        autonomous?: boolean | undefined;
        /** Per-run override of git-worktree isolation. Omitted → env default
         *  (WRONGSTACK_GOAL_WORKTREES). false → run on the current branch. */
        worktrees?: boolean | undefined;
        /** Split the goal into multiple kanban boards (one per phase). */
        multiBoard?: boolean | undefined;
        /** Require verification (typecheck/lint/test) for each task. */
        verifyTasks?: boolean | undefined;
        /** Enable chimera auto-review for this goal run. */
        chimeraReview?: boolean | undefined;
      };
    }
  | { type: 'goal.assess'; payload: { goal: string; seq?: number | undefined } }
  | { type: 'goal.pause'; payload: Record<string, never> }
  | { type: 'goal.resume'; payload: Record<string, never> }
  | { type: 'goal.stop'; payload: Record<string, never> }
  | { type: 'goal.clear'; payload?: Record<string, never> }
  | { type: 'goal.revert'; payload?: Record<string, never> }
  | { type: 'goal.status'; payload?: Record<string, never> }
  | { type: 'goal.state'; payload?: Record<string, never> }
  | { type: 'goal.save'; payload?: Record<string, never> }
  | { type: 'goal.list'; payload?: Record<string, never> }
  | { type: 'goal.load'; payload: { graphId: string } }
  | { type: 'goal.toggleAutonomous'; payload: { autonomous?: boolean | undefined } }
  | { type: 'goal.selectPhase'; payload: { phaseId: string } }
  | { type: 'goal.taskStatus'; payload: { taskId: string; status: string } }
  | { type: 'goal.moveTask'; payload: { taskId: string; toPhaseId: string } }
  | {
      type: 'goal.assignTask';
      payload: { taskId: string; agentId?: string | undefined; agentName?: string | undefined };
    }
  | {
      type: 'goal.addTask';
      payload: {
        phaseId: string;
        title: string;
        description?: string | undefined;
        type?: string | undefined;
        priority?: string | undefined;
      };
    }
  | { type: 'goal.retryTask'; payload: { taskId: string } }
  | { type: 'goal.runTask'; payload: { taskId: string } }
  | { type: 'specs.list'; payload?: Record<string, never> }
  | { type: 'specs.get'; payload: { specId: string } }
  | {
      type: 'specs.taskStatus';
      payload: { graphId: string; taskId: string; status: string };
    }
  | { type: 'sdd.board.get'; payload?: Record<string, never> }
  | { type: 'sdd.board.list'; payload?: Record<string, never> }
  | { type: 'sdd.board.pause'; payload?: { runId?: string | undefined } }
  | { type: 'sdd.board.resume'; payload?: { runId?: string | undefined } }
  | { type: 'sdd.board.stop'; payload?: { runId?: string | undefined } }
  | { type: 'sdd.board.retry'; payload: { taskId: string; runId?: string | undefined } }
  | { type: 'sdd.board.retry_all_failed'; payload?: { runId?: string | undefined } }
  | {
      type: 'sdd.board.reassign';
      payload: { taskId: string; agentName: string; runId?: string | undefined };
    }
  | {
      type: 'sdd.board.set_task_model';
      payload: {
        taskId: string;
        model?: string | undefined;
        provider?: string | undefined;
        runId?: string | undefined;
      };
    }
  | {
      type: 'sdd.board.set_task_fallbacks';
      payload: {
        taskId: string;
        fallbackModels?: string[] | undefined;
        runId?: string | undefined;
      };
    }
  | {
      type: 'sdd.board.set_task_verification';
      payload: {
        taskId: string;
        verificationCommand?: string | undefined;
        runId?: string | undefined;
      };
    }
  | { type: 'sdd.board.cancel_task'; payload: { taskId: string; runId?: string | undefined } }
  | { type: 'sdd.board.delete_task'; payload: { taskId: string; runId?: string | undefined } }
  | {
      type: 'sdd.board.split_task';
      payload: {
        taskId: string;
        subtasks: Array<{ title: string; description: string }>;
        runId?: string | undefined;
      };
    }
  | { type: 'sdd.board.cleanup_worktrees'; payload?: { runId?: string | undefined } }
  | { type: 'sdd.board.rollback'; payload?: { runId?: string | undefined } }
  | {
      type: 'sdd.board.destroy';
      payload?: { runId?: string | undefined; revertMerged?: boolean | undefined };
    }
  | { type: 'worktree.scan'; payload?: Record<string, never> }
  | { type: 'worktree.cleanup'; payload?: Record<string, never> }
  | { type: 'worktree.remove'; payload: { dir?: string | undefined; branch?: string | undefined } }
  | { type: 'worktree.merge'; payload: { branch: string } }
  | { type: 'worktree.diff'; payload: { dir: string; baseBranch?: string | undefined } }
  | { type: 'sdd.spec.start'; payload: { goal: string; force?: boolean | undefined } }
  | { type: 'sdd.spec.message'; payload: { text: string } }
  | { type: 'sdd.spec.approve'; payload?: Record<string, never> }
  | { type: 'sdd.spec.rewind'; payload?: { targetPhase?: string | undefined } }
  | { type: 'sdd.spec.get'; payload?: Record<string, never> }
  /** Abandon the in-progress interview (clears on-disk session) so a new one can start. */
  | { type: 'sdd.spec.discard'; payload?: Record<string, never> }
  | {
      type: 'sdd.run.start';
      payload?: {
        parallelSlots?: number | undefined;
        model?: string | undefined;
        provider?: string | undefined;
        fallbackModels?: string[] | undefined;
        /** Per-run override of git-worktree isolation. Omitted → env default
         *  (WRONGSTACK_SDD_WORKTREES). false → run on the current branch. */
        worktrees?: boolean | undefined;
        /** Split non-atomic tasks before dispatch (planning-time decompose). */
        planDecompose?: boolean | undefined;
      };
    }
  | {
      type: 'sdd.run.from_graph';
      payload: {
        graphId: string;
        parallelSlots?: number | undefined;
        model?: string | undefined;
        provider?: string | undefined;
        fallbackModels?: string[] | undefined;
        worktrees?: boolean | undefined;
        planDecompose?: boolean | undefined;
      };
    }
  | {
      type: 'sdd.run.from_spec';
      payload: {
        specId: string;
        parallelSlots?: number | undefined;
        model?: string | undefined;
        provider?: string | undefined;
        fallbackModels?: string[] | undefined;
        worktrees?: boolean | undefined;
        planDecompose?: boolean | undefined;
      };
    }
  | { type: 'abort'; payload: SessionScopedPayload }
  | { type: 'session.resume'; payload: { id: string } & SessionScopedPayload }
  | { type: 'session.inspect'; payload: { id: string } }
  | {
      type: 'session.new';
      /**
       * `replaceSessionId` is the explicit "retire this session as part of
       * the same operation" target — deliberately a DIFFERENT key from
       * `sessionId`, which only says which session the request originated
       * from. Omit it to open an ADDITIONAL session (a new tab) that touches
       * nothing; send it to close that session and land its replacement.
       */
      payload?:
        | ({ systemPromptVariant?: string; replaceSessionId?: string } & SessionScopedPayload)
        | SessionScopedPayload;
    }
  | { type: 'session.checkpoints'; payload?: SessionScopedPayload }
  | { type: 'session.rewind'; payload: { checkpointIndex: number } & SessionScopedPayload }
  /**
   * Declare every session this connection is displaying (its open tabs).
   *
   * A WebUI page holds up to four tabs on ONE socket, so the server cannot
   * infer the open set from the last message's `sessionId`. Without this the
   * broadcast filter drops the other three tabs' runs at the wire. Re-sent in
   * full whenever a tab opens or closes — it replaces, it does not merge.
   */
  /**
   * This tab came to the front. Moves the runtime's current session, this
   * connection's acting id and the todo board onto it — and deliberately
   * sends no transcript back, because the tab is already showing one.
   * `session.resume` is the other half: it OPENS a conversation and does
   * answer with its transcript.
   */
  | { type: 'session.focus'; payload: { id: string } & SessionScopedPayload }
  | {
      type: 'session.subscribe';
      payload: {
        sessionIds: string[];
        /**
         * The subset of `sessionIds` whose chat pane is EMPTY on this page and
         * therefore needs its transcript sent back. After a reload the browser
         * restores its four slots from storage but holds no messages for any of
         * them, so without this the three background tabs come back blank and
         * only fill in if the user clicks them. Naming them explicitly keeps the
         * server from re-sending a transcript to a tab that already shows one —
         * a replay is rebuilt from the working set and is strictly poorer than
         * what a live lane already has.
         */
        replayFor?: string[];
      } & SessionScopedPayload;
    }
  | { type: 'context.clear'; payload?: SessionScopedPayload }
  | { type: 'context.compact'; payload: { aggressive: boolean } & SessionScopedPayload }
  | { type: 'context.repair'; payload?: SessionScopedPayload }
  | { type: 'context.debug'; payload?: SessionScopedPayload }
  | { type: 'context.editor.open'; payload?: SessionScopedPayload }
  | {
      type: 'context.editor.validate';
      payload: SessionScopedPayload & {
        baseRevision: string;
        messages: ContextEditorMessage[];
        removals: ContextEditorRemoval[];
        allowRepair: boolean;
      };
    }
  | {
      type: 'context.editor.apply';
      payload: SessionScopedPayload & {
        baseRevision: string;
        messages: ContextEditorMessage[];
        removals: ContextEditorRemoval[];
        allowRepair: boolean;
      };
    }
  | { type: 'context.modes.list'; payload?: SessionScopedPayload }
  | { type: 'context.mode.switch'; payload: { id: string } & SessionScopedPayload }
  | {
      type: 'context.mode.create';
      payload: {
        id: string;
        name: string;
        description: string;
        thresholds: { warn: number; soft: number; hard: number };
        preserveK: number;
        eliseThreshold: number;
      } & SessionScopedPayload;
    }
  | {
      type: 'context.mode.update';
      payload: {
        id: string;
        name?: string | undefined;
        description?: string | undefined;
        thresholds?:
          | { warn?: number | undefined; soft?: number | undefined; hard?: number | undefined }
          | undefined;
        preserveK?: number | undefined;
        eliseThreshold?: number | undefined;
      } & SessionScopedPayload;
    }
  | { type: 'context.mode.delete'; payload: { id: string } & SessionScopedPayload }
  | WSModelSwitch
  | { type: 'codebase.index.server.shutdown'; payload: { requestId: string } }
  | { type: 'providers.list' }
  | { type: 'provider.models'; payload: { providerId: string } }
  | { type: 'provider.models.search'; payload: { query: string; limit?: number | undefined } }
  | { type: 'providers.saved' }
  | { type: 'key.add'; payload: { providerId: string; label: string; apiKey: string } }
  | { type: 'key.update'; payload: { providerId: string; label: string; apiKey: string } }
  | { type: 'key.delete'; payload: { providerId: string; label: string } }
  | { type: 'key.set_active'; payload: { providerId: string; label: string } }
  | {
      type: 'provider.add';
      payload: {
        id: string;
        family: string;
        baseUrl?: string | undefined;
        apiKey?: string | undefined;
        models?: string[] | undefined;
        customModels?: Record<string, ProviderCustomModelWire> | undefined;
      };
    }
  | { type: 'provider.remove'; payload: { providerId: string } }
  | { type: 'provider.clear_models'; payload: { providerId: string } }
  | {
      type: 'provider.custom_models.set';
      payload: {
        providerId: string;
        modelId: string;
        customModel: ProviderCustomModelWire;
      };
    }
  | {
      type: 'provider.custom_models.remove';
      payload: { providerId: string; modelId: string };
    }
  | { type: 'provider.undo_clear'; payload: { providerId: string; previousModels: string[] } }
  | {
      type: 'provider.update';
      payload: {
        id: string;
        family?: string | undefined;
        baseUrl?: string | undefined;
        envVars?: string[] | undefined;
        models?: string[] | undefined;
        customModels?: Record<string, ProviderCustomModelWire> | undefined;
      };
    }
  | { type: 'provider.probe'; payload: { providerId: string; timeoutMs?: number | undefined } }
  | { type: 'auth.oauth.start'; payload: { kind: OAuthKind; providerId?: string | undefined } }
  | { type: 'auth.oauth.code'; payload: { kind: OAuthKind; input: string } }
  | { type: 'auth.oauth.cancel'; payload: { kind: OAuthKind } }
  | { type: 'provider.status.get' }
  | { type: 'provider.audit.get'; payload?: { count?: number | undefined } }
  | { type: 'provider.status.retry'; payload: { providerId: string; model: string } }
  | { type: 'provider.status.clear'; payload: { providerId: string; model: string } }
  | { type: 'memory.list' }
  | { type: `agent-roster.${string}`; payload?: Record<string, unknown> | undefined }
  // ── Sage send types ──
  | { type: 'memory.sage.list' }
  | {
      type: 'memory.sage.listPage';
      payload: {
        statuses?: string[] | undefined;
        kind?: string | undefined;
        query?: string | undefined;
        limit?: number | undefined;
        cursor?: string | undefined;
      };
    }
  | {
      type: 'memory.sage.listCandidates';
      payload?: { includeResolved?: boolean | undefined } | undefined;
    }
  | { type: 'memory.sage.get'; payload: { id: string } }
  | { type: 'memory.sage.graph'; payload: { query: string; maxDepth?: number; limit?: number } }
  | {
      type: 'memory.sage.update';
      payload: {
        id: string;
        text?: string | undefined;
        tags?: string[] | undefined;
        kind?: string | undefined;
        status?: SageStatus | undefined;
        importance?: number | undefined;
        confidence?: number | undefined;
        freshness?: number | undefined;
        anchors?: SageAnchor[] | undefined;
        audience?: { roles?: string[]; taskTypes?: string[]; modes?: string[] } | undefined;
        supersedes?: string[] | undefined;
        contradicts?: string[] | undefined;
      };
    }
  | {
      type: 'memory.sage.delete';
      payload: {
        id: string;
        force?: boolean | undefined;
        reason?: string | undefined;
        neverInject?: boolean | undefined;
      };
    }
  | {
      type: 'memory.sage.recover';
      payload: { id: string; reason?: string | undefined };
    }
  | {
      type: 'memory.sage.candidateResolve';
      payload: {
        candidateId: string;
        action: 'accept' | 'reject';
        reason?: string | undefined;
      };
    }
  | {
      type: 'memory.sage.backfillRecoverable';
      payload: {
        apply: boolean;
        kinds?: string[] | undefined;
        scopes?: string[] | undefined;
        updatedAfter?: string | undefined;
        updatedBefore?: string | undefined;
      };
    }
  | {
      type: 'memory.sage.forFile';
      payload: WSMemorySageForFileRequest;
    }
  | {
      type: 'memory.sage.searchBreakdown';
      payload: {
        query: string;
        limit?: number | undefined;
        includeStale?: boolean | undefined;
      };
    }
  | {
      type: 'memory.sage.remember';
      payload: {
        text: string;
        kind?: string | undefined;
        scope?: SageScope | undefined;
        tags?: string[] | undefined;
        importance?: number | undefined;
        confidence?: number | undefined;
        freshness?: number | undefined;
        anchors?: SageAnchor[] | undefined;
        audience?: { roles?: string[]; taskTypes?: string[]; modes?: string[] } | undefined;
        supersedes?: string[] | undefined;
        contradicts?: string[] | undefined;
      };
    }
  | { type: 'prompts.list' }
  | {
      type: 'prompts.search';
      payload: { query?: string | undefined; category?: string | undefined };
    }
  | { type: 'prompts.content'; payload: { slug: string } }
  | { type: 'prompts.favorite'; payload: { slug: string; favorite: boolean } }
  | { type: 'prompts.used'; payload: { slug: string } }
  | { type: 'prompts.recent' }
  | {
      type: 'prompts.journal';
      payload?: {
        filter?:
          | {
              sessionId?: string | undefined;
              category?: string | undefined;
              date?: string | undefined;
              month?: string | undefined;
              limit?: number | undefined;
            }
          | undefined;
      };
    }
  | {
      type: 'prompts.create';
      payload: {
        title: string;
        content: string;
        description?: string | undefined;
        category?: string | undefined;
        tags?: string[] | undefined;
        variables?:
          | {
              name: string;
              description?: string | undefined;
              required?: boolean | undefined;
              multiline?: boolean | undefined;
              enum?: string[] | undefined;
            }[]
          | undefined;
      };
    }
  | { type: 'diag.get'; payload?: SessionScopedPayload }
  | { type: 'stats.get'; payload?: SessionScopedPayload }
  | { type: 'connections.health' }
  | {
      type: 'connections.service_action';
      payload: { serviceId: string; action?: 'shutdown' | 'restart' };
    }
  | { type: 'chronicle.status' }
  | { type: 'chronicle.query'; payload: { query?: ChronicleQuery | undefined } }
  | {
      type: 'chronicle.facet';
      payload: {
        field: ChronicleFacet;
        query?: ChronicleQuery | undefined;
        limit?: number | undefined;
      };
    }
  | {
      type: 'chronicle.facets';
      payload: {
        fields: ChronicleFacet[];
        query?: ChronicleQuery | undefined;
        limit?: number | undefined;
      };
    }
  | { type: 'chronicle.graph'; payload: { seed: ChronicleQuery; hops?: number; maxNodes?: number } }
  | {
      type: 'chronicle.metrics';
      payload: {
        view?: ChronicleMetricsView | undefined;
        from?: string | undefined;
        to?: string | undefined;
        path?: string | undefined;
        taskId?: string | undefined;
        boardId?: string | undefined;
        sessionId?: string | undefined;
        status?: string | undefined;
        limit?: number | undefined;
      };
    }
  | { type: 'session.save'; payload?: SessionScopedPayload }
  | { type: 'sessions.list'; payload: { limit: number } & SessionScopedPayload }
  | { type: 'session.delete'; payload: { id: string } & SessionScopedPayload }
  | { type: 'session.rename'; payload: { id: string; name: string } }
  | { type: 'modes.list' }
  | { type: 'mode.switch'; payload: { id: string } }
  | {
      type: 'files.list';
      payload: {
        query?: string | undefined;
        limit?: number | undefined;
        path?: string | undefined;
      };
    }
  | {
      type: 'files.tree';
      payload: ({ path?: string | undefined } | Record<string, never>) & SessionScopedPayload;
    }
  | { type: 'files.read'; payload: { filePath: string } & SessionScopedPayload }
  | {
      type: 'files.skeleton';
      payload: {
        filePath: string;
        content?: string | undefined;
        options?:
          | {
              includeDocs?: boolean | undefined;
              collapseImports?: boolean | undefined;
              exportsOnly?: boolean | undefined;
            }
          | undefined;
      };
    }
  | { type: 'files.write'; payload: { filePath: string; content: string } & SessionScopedPayload }
  | {
      type: 'files.create';
      payload: { filePath: string; type: 'file' | 'directory' } & SessionScopedPayload;
    }
  | {
      type: 'files.delete';
      payload: { filePath: string; recursive?: boolean | undefined } & SessionScopedPayload;
    }
  | { type: 'files.rename'; payload: { oldPath: string; newPath: string } & SessionScopedPayload }
  | { type: 'files.move'; payload: { srcPath: string; destDir: string } & SessionScopedPayload }
  | WSCompletionRequest
  | { type: 'todos.get'; payload?: SessionScopedPayload }
  | { type: 'todos.clear'; payload?: SessionScopedPayload }
  | {
      type: 'todos.remove';
      payload: { id?: string | undefined; index?: number | undefined } & SessionScopedPayload;
    }
  | {
      type: 'todo.update';
      payload: {
        id: string;
        status?: 'pending' | 'in_progress' | 'completed' | undefined;
        activeForm?: string | undefined;
      } & SessionScopedPayload;
    }
  | { type: 'tasks.get'; payload?: SessionScopedPayload }
  | { type: 'task.update'; payload: { id: string; status: string } & SessionScopedPayload }
  | { type: 'plan.get'; payload?: SessionScopedPayload }
  | {
      type: 'plan.item.update';
      payload: { target: string; status: 'open' | 'in_progress' | 'done' } & SessionScopedPayload;
    }
  | { type: 'ping' }
  | { type: 'process.list'; payload?: SessionScopedPayload }
  | { type: 'process.kill'; payload: { pid: number } & SessionScopedPayload }
  | { type: 'process.killAll'; payload?: SessionScopedPayload }
  | { type: 'git.info' }
  | { type: 'git.changes' }
  | { type: 'git.diff'; payload: { path: string } }
  | { type: 'git.stage'; payload: { paths?: string[] | undefined; path?: string | undefined } }
  | { type: 'git.unstage'; payload: { paths?: string[] | undefined; path?: string | undefined } }
  | { type: 'git.discard'; payload: { paths?: string[] | undefined; path?: string | undefined } }
  | { type: 'git.commit'; payload: { message: string } }
  | { type: 'goal.get' }
  | { type: 'goal-state.get' }
  | { type: 'autonomy.switch'; payload: { mode: string } & SessionScopedPayload }
  | { type: 'prefs.update'; payload: Record<string, unknown> }
  | { type: 'prefs.get'; payload?: SessionScopedPayload | undefined }
  | { type: 'system_prompt.get'; payload?: SessionScopedPayload }
  | { type: 'projects.list' }
  | { type: 'projects.add'; payload: { root: string; name?: string | undefined } }
  | { type: 'projects.select'; payload: { root: string; name?: string | undefined } }
  | { type: 'working_dir.set'; payload: { path: string } }
  | { type: 'shell.open'; payload: { path: string; target: 'terminal' | 'file-manager' } }
  | WSCollabJoin
  | WSCollabLeave
  | WSCollabAnnotate
  | WSCollabResolve
  | WSCollabRequestPause
  | WSCollabResume
  | WSCollabGrantControl
  | WSCollabInjectTool
  | {
      type: 'mailbox.send';
      payload: {
        requestId: string;
        to: string;
        type:
          | 'note'
          | 'ask'
          | 'assign'
          | 'steer'
          | 'btw'
          | 'broadcast'
          | 'status'
          | 'result'
          | 'review';
        audience: 'all' | 'leaders';
        subject: string;
        body: string;
        priority: 'low' | 'normal' | 'high';
        replyTo?: string | undefined;
      } & SessionScopedPayload;
    }
  | {
      type: 'mailbox.messages';
      payload: {
        limit?: number | undefined;
        agentId?: string | undefined;
        unreadOnly?: boolean | undefined;
        incompleteOnly?: boolean | undefined;
      };
    }
  | {
      type: 'mailbox.agents';
      payload: { onlineOnly?: boolean | undefined } | Record<string, never>;
    }
  | { type: 'mailbox.clear' }
  | {
      type: 'mailbox.purge';
      payload?: { completedMaxAgeMs?: number; incompleteMaxAgeMs?: number } | undefined;
    }
  | {
      type: 'mailbox.compact';
      payload?: { readMaxAgeMs?: number; defaultTtlMs?: number } | undefined;
    }
  // Brain settings are project-wide, but every frame the server sends back
  // describes ONE tab: the decision log is filtered to the asking session and
  // `brain.answer` is stamped with it. An untagged ask is answered about (and
  // for) whichever session the runtime last touched.
  | { type: 'brain.status'; payload?: SessionScopedPayload }
  | { type: 'brain.risk'; payload: { level: string } & SessionScopedPayload }
  | { type: 'brain.ask'; payload: { question: string } & SessionScopedPayload }
  | { type: 'brain.config.get' }
  | { type: 'brain.config.set'; payload: { patch: BrainConfigPatchWire } & SessionScopedPayload }
  | {
      type: 'model.refine';
      payload: {
        text: string;
        /** Retry window override (ms). Set on the auto-retry after a timeout. */
        timeoutMs?: number | undefined;
        /** Refine on this provider/model instead of the session's — ephemeral, no session switch. */
        provider?: string | undefined;
        model?: string | undefined;
        /** Previous refinement when the user asks the preview to try again better. */
        previousRefined?: string | undefined;
        previousEnglish?: string | undefined;
        retryFeedback?: string | undefined;
      };
    }
  | { type: 'skills.list' }
  | { type: 'skills.content'; payload: { name: string; source: string } }
  | { type: 'skills.install'; payload: { ref: string; global?: boolean } }
  | { type: 'skills.uninstall'; payload: { name: string; global?: boolean } }
  | { type: 'skills.update'; payload: { name?: string; global?: boolean } }
  | {
      type: 'skills.create';
      payload: { name: string; description: string; scope: 'project' | 'global' };
    }
  | { type: 'skills.export'; payload?: Record<string, unknown> }
  | { type: 'skills.edit'; payload: { name: string; body: string } }
  // ── Design Studio client messages ────────────────────────────────────────────
  // Every design frame is session-scoped: `meta.designStudio` shapes THAT
  // tab's system prompt, and the server answers from `getDesignContext(
  // sessionId)`. Untagged, a kit picked in one tab restyles another's next
  // turn. Declared with the shared marker so the send-stamping rule sees them.
  | { type: 'design.list'; payload?: SessionScopedPayload }
  | {
      type: 'design.use';
      payload: {
        kit: string;
        stack?: string | undefined;
        overrides?: Record<string, string> | undefined;
      } & SessionScopedPayload;
    }
  | { type: 'design.state'; payload?: SessionScopedPayload }
  | { type: 'design.set'; payload: { overrides: Record<string, string> } & SessionScopedPayload }
  | {
      type: 'design.tune';
      payload: {
        tune: {
          radius?: string | undefined;
          density?: string | undefined;
          font?: string | undefined;
          motion?: string | undefined;
        };
      } & SessionScopedPayload;
    }
  | {
      type: 'design.swap';
      payload: { kit: string; stack?: string | undefined } & SessionScopedPayload;
    }
  | {
      type: 'design.materialize';
      payload?:
        | ({ stack?: string | undefined; out?: string | undefined } & SessionScopedPayload)
        | undefined;
    }
  | { type: 'design.verify'; payload?: SessionScopedPayload }
  | { type: 'config.doctor'; payload?: { apply?: boolean } | undefined }
  // ── MCP client messages (requests to server) ─────────────────────────────────
  | { type: 'mcp.list' }
  | {
      type: 'mcp.add';
      payload: {
        name: string;
        transport: string;
        description?: string;
        enabled?: boolean;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        allowedTools?: string[];
        url?: string;
        headers?: Record<string, string>;
        lazy?: boolean;
      };
    }
  | { type: 'mcp.remove'; payload: { name: string } }
  | {
      type: 'mcp.update';
      payload: {
        name: string;
        transport?: string;
        description?: string;
        enabled?: boolean;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        allowedTools?: string[];
        url?: string;
        headers?: Record<string, string>;
        lazy?: boolean;
      };
    }
  | { type: 'mcp.wake'; payload: { name: string } }
  | { type: 'mcp.sleep'; payload: { name: string } }
  | { type: 'mcp.discover'; payload: { name: string } }
  | { type: 'mcp.enable'; payload: { name: string } }
  | { type: 'mcp.disable'; payload: { name: string } }
  | { type: 'mcp.restart'; payload: { name: string } }
  | { type: 'mcp.resources'; payload: { name: string; refresh?: boolean } }
  | { type: 'mcp.prompts'; payload: { name: string; refresh?: boolean } }
  | { type: 'mcp.resource.read'; payload: { name: string; uri: string } }
  | {
      type: 'mcp.prompt.get';
      payload: { name: string; prompt: string; arguments?: Record<string, string> };
    }
  // ── Integrated terminal (node-pty) client messages ───────────────────────────
  | {
      type: 'terminal.create';
      payload: { id: string; cols?: number | undefined; rows?: number | undefined };
    }
  | { type: 'terminal.input'; payload: { id: string; data: string } }
  | { type: 'terminal.resize'; payload: { id: string; cols: number; rows: number } }
  | { type: 'terminal.close'; payload: { id: string } }
  // ── Tool management client messages ─────────────────────────────────────────
  | { type: 'tools.list' }
  | { type: 'tool.enable'; payload: { name: string } }
  | { type: 'tool.disable'; payload: { name: string } }
  | { type: `kanban.${string}`; payload?: Record<string, unknown> | undefined }
  // ── Misc client messages ─────────────────────────────────────────────────────
  | { type: 'plan.template_use'; payload: { template: string } }
  | {
      type: 'model.fallback_choice';
      payload: {
        requestId: string;
        providerId?: string | undefined;
        model?: string | undefined;
        /** When true, auto-switch to the next candidate (countdown expired or Esc). */
        autoSwitch?: boolean | undefined;
      };
    }
  | { type: 'webui.shutdown' };

export type WSClientMessage = WSClientMessageCore;
