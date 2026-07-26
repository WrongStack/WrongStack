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
import type { BrainConfigPatchWire } from './brain.js';
import type { SessionScopedPayload, WSUserMessage } from './protocol-core.js';
import type { WSModelSwitch, WSToolConfirmResult } from './runtime.js';
import type { SageAnchor, SageScope, SageStatus, WSMemorySageForFileRequest } from './sage.js';
import type { OAuthKind, WSCompletionRequest } from './system.js';

export type WSClientMessageCore =
  | WSUserMessage
  | WSToolConfirmResult
  | { type: 'side_effects.list'; payload?: Record<string, never> }
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
  | { type: 'sdd.spec.start'; payload: { goal: string } }
  | { type: 'sdd.spec.message'; payload: { text: string } }
  | { type: 'sdd.spec.approve'; payload?: Record<string, never> }
  | { type: 'sdd.spec.get'; payload?: Record<string, never> }
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
      };
    }
  | { type: 'abort'; payload: SessionScopedPayload }
  | { type: 'session.resume'; payload: { id: string } & SessionScopedPayload }
  | { type: 'session.new'; payload?: SessionScopedPayload }
  | { type: 'session.checkpoints'; payload?: SessionScopedPayload }
  | { type: 'session.rewind'; payload: { checkpointIndex: number } & SessionScopedPayload }
  | { type: 'context.clear'; payload?: SessionScopedPayload }
  | { type: 'context.compact'; payload: { aggressive: boolean } & SessionScopedPayload }
  | { type: 'context.repair'; payload?: SessionScopedPayload }
  | { type: 'context.debug'; payload?: SessionScopedPayload }
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
  | { type: 'providers.list' }
  | { type: 'provider.models'; payload: { providerId: string } }
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
      };
    }
  | { type: 'provider.remove'; payload: { providerId: string } }
  | { type: 'provider.clear_models'; payload: { providerId: string } }
  | { type: 'provider.undo_clear'; payload: { providerId: string; previousModels: string[] } }
  | {
      type: 'provider.update';
      payload: {
        id: string;
        family?: string | undefined;
        baseUrl?: string | undefined;
        envVars?: string[] | undefined;
        models?: string[] | undefined;
      };
    }
  | { type: 'provider.probe'; payload: { providerId: string; timeoutMs?: number | undefined } }
  | { type: 'auth.oauth.start'; payload: { kind: OAuthKind; providerId?: string | undefined } }
  | { type: 'auth.oauth.code'; payload: { kind: OAuthKind; input: string } }
  | { type: 'auth.oauth.cancel'; payload: { kind: OAuthKind } }
  | { type: 'provider.status.get' }
  | { type: 'provider.status.retry'; payload: { providerId: string; model: string } }
  | { type: 'provider.status.clear'; payload: { providerId: string; model: string } }
  | { type: 'tools.list' }
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
      payload: { id: string; reason?: string | undefined; neverInject?: boolean | undefined };
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
  | { type: 'skills.list' }
  | { type: 'skills.content'; payload: { name: string; source: string } }
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
  | { type: 'session.delete'; payload: { id: string } }
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
  | { type: 'files.tree'; payload: { path?: string | undefined } | Record<string, never> }
  | { type: 'files.read'; payload: { filePath: string } }
  | { type: 'files.write'; payload: { filePath: string; content: string } }
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
  | { type: 'process.list' }
  | { type: 'process.kill'; payload: { pid: number } }
  | { type: 'process.killAll' }
  | { type: 'git.info' }
  | { type: 'git.changes' }
  | { type: 'git.diff'; payload: { path: string } }
  | { type: 'goal.get' }
  | { type: 'goal-state.get' }
  | { type: 'autonomy.switch'; payload: { mode: string } }
  | { type: 'prefs.update'; payload: Record<string, unknown> }
  | { type: 'prefs.get' }
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
      };
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
  | { type: 'brain.status' }
  | { type: 'brain.risk'; payload: { level: string } }
  | { type: 'brain.ask'; payload: { question: string } }
  | { type: 'brain.config.get' }
  | { type: 'brain.config.set'; payload: { patch: BrainConfigPatchWire } }
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
  | { type: 'design.list' }
  | {
      type: 'design.use';
      payload: {
        kit: string;
        stack?: string | undefined;
        overrides?: Record<string, string> | undefined;
      };
    }
  | { type: 'design.state' }
  | { type: 'design.set'; payload: { overrides: Record<string, string> } }
  | {
      type: 'design.tune';
      payload: {
        tune: {
          radius?: string | undefined;
          density?: string | undefined;
          font?: string | undefined;
          motion?: string | undefined;
        };
      };
    }
  | {
      type: 'design.swap';
      payload: { kit: string; stack?: string | undefined };
    }
  | {
      type: 'design.materialize';
      payload?: { stack?: string | undefined; out?: string | undefined } | undefined;
    }
  | { type: 'design.verify' }
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
  | { type: 'webui.shutdown' };

export type WSClientMessage = WSClientMessageCore;
