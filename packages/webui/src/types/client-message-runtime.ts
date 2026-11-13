import type { CodeAssistPreset } from '@wrongstack/webui-protocol';
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
import type { WSPromptQueueClientMessage } from './prompt-queue.js';
import type { SessionScopedPayload, WSUserMessage } from './protocol-core.js';
import type { WSModelSwitch, WSToolConfirmResult, WSUserInputSubmit } from './runtime.js';
import type { WSCompletionRequest, WSFallbackSuggest } from './system.js';
export type ClientMessageRuntime =
  | WSUserMessage
  | WSPromptQueueClientMessage
  | { type: 'composer.warm'; payload: SessionScopedPayload }
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
  | WSUserInputSubmit
  | { type: 'side_effects.list'; payload?: SessionScopedPayload | undefined }
  | { type: 'specs.list'; payload?: Record<string, never> }
  | { type: 'specs.get'; payload: { specId: string } }
  | {
      type: 'specs.taskStatus';
      payload: { graphId: string; taskId: string; status: string };
    }
  | { type: 'abort'; payload: SessionScopedPayload }
  | WSModelSwitch
  | { type: 'codebase.index.server.shutdown'; payload: { requestId: string } }
  | WSFallbackSuggest
  | { type: `agent-roster.${string}`; payload?: Record<string, unknown> | undefined }
  | { type: 'prompts.list' }
  | {
      type: 'prompts.search';
      payload: { query?: string | undefined; category?: string | undefined };
    }
  | { type: 'prompts.content'; payload: { slug: string; requestId?: string } }
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
  | { type: 'connections.health' }
  | {
      type: 'connections.service_action';
      payload: { serviceId: string; action?: 'shutdown' | 'restart' };
    }
  | { type: 'chronicle.status' }
  | {
      type: 'chronicle.query';
      payload: { query?: ChronicleQuery | undefined; requestId?: string | undefined };
    }
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
  | WSCompletionRequest
  | { type: 'tasks.get'; payload?: SessionScopedPayload }
  | { type: 'task.update'; payload: { id: string; status: string } & SessionScopedPayload }
  | { type: 'ping' }
  | { type: 'process.list'; payload?: SessionScopedPayload }
  | { type: 'process.output'; payload: { pid: number; lines?: number } & SessionScopedPayload }
  | { type: 'browser.live.list'; payload?: SessionScopedPayload }
  | { type: 'browser.live.watch'; payload: { id: string } & SessionScopedPayload }
  | {
      type: 'browser.live.pick';
      payload: {
        id: string;
        requestId: string;
        x: number;
        y: number;
        url: string;
      } & SessionScopedPayload;
    }
  | { type: 'browser.live.unwatch'; payload?: SessionScopedPayload }
  | { type: 'process.kill'; payload: { pid: number } & SessionScopedPayload }
  | { type: 'process.killAll'; payload?: SessionScopedPayload }
  | { type: 'git.info' }
  | { type: 'git.changes' }
  | {
      type: 'git.history';
      payload?: { ref?: string; limit?: number; skip?: number; path?: string };
    }
  | { type: 'git.commit_detail'; payload: { hash: string } }
  | {
      type: 'git.commit_file_diff';
      payload: { hash: string; path: string; previousPath?: string | undefined };
    }
  | { type: 'git.diff'; payload: { path: string } }
  | { type: 'git.stage'; payload: { paths?: string[] | undefined; path?: string | undefined } }
  | { type: 'git.unstage'; payload: { paths?: string[] | undefined; path?: string | undefined } }
  | { type: 'git.discard'; payload: { paths?: string[] | undefined; path?: string | undefined } }
  | { type: 'git.commit'; payload: { message: string } }
  | { type: 'system_prompt.get'; payload?: SessionScopedPayload }
  | { type: 'system_prompt.presets.get'; payload?: SessionScopedPayload }
  | {
      type: 'system_prompt.presets.create';
      payload: { name: string; baseVariant: 'lite' | 'default' | 'pro' | 'scout' | 'quick' };
    }
  | {
      type: 'system_prompt.presets.save';
      payload: {
        id: string;
        revision: number;
        name: string;
        text: string;
        reviewedCurrentSource?: boolean;
      };
    }
  | {
      type: 'system_prompt.presets.activate';
      payload: {
        baseVariant: 'lite' | 'default' | 'pro' | 'scout' | 'quick';
        id?: string;
        sessionId?: string;
        scope: 'profile' | 'project';
      };
    }
  | { type: 'system_prompt.presets.delete'; payload: { id: string } }
  | { type: 'system_prompt.presets.validate'; payload: { text: string } }
  | {
      type: 'system_prompt.presets.preview';
      payload: { text: string; sessionId?: string; requestId: number };
    }
  | { type: 'user_instructions.get'; payload?: Record<string, never> }
  | { type: 'user_instructions.save'; payload: { text: string; baseMtimeMs: number | null } }
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
  | { type: 'jev.get' | 'jev.test' | 'jev.check'; payload?: { requestId: string } }
  | { type: 'jev.set'; payload: { requestId: string; patch: Record<string, unknown> } }
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
  | {
      type: 'design.draw';
      payload?:
        | ({
            job?: string | undefined;
            material?: string | undefined;
            seed?: string | undefined;
          } & SessionScopedPayload)
        | undefined;
    }
  | {
      type: 'design.photos';
      payload: {
        query: string;
        orient?: string | undefined;
        seed?: string | undefined;
      } & SessionScopedPayload;
    }
  | { type: 'design.snapshot'; payload?: SessionScopedPayload }
  | { type: 'design.kept'; payload?: SessionScopedPayload }
  | {
      type: 'terminal.create';
      payload: { id: string; cols?: number | undefined; rows?: number | undefined };
    }
  | { type: 'terminal.input'; payload: { id: string; data: string } }
  | { type: 'terminal.resize'; payload: { id: string; cols: number; rows: number } }
  | { type: 'terminal.close'; payload: { id: string } }
  | { type: `kanban.${string}`; payload?: Record<string, unknown> | undefined }
  | {
      type: 'code.assist.run';
      payload: {
        requestId: string;
        /** Project-relative POSIX path the analysis is anchored to. */
        filePath: string;
        /** Optional symbol (function/class/method) name inside `filePath`. */
        symbol?: string | undefined;
        /** Line the user was looking at, when known. */
        line?: number | undefined;
        /** Which predefined check to run. */
        preset: CodeAssistPreset;
        /** Free-form question; only used by the `custom` preset. */
        question?: string | undefined;
        /**
         * Allow the agent to edit files. Defaults to false — analysis presets
         * are read-only, and mutating runs are opt-in from the panel.
         */
        allowEdits?: boolean | undefined;
      };
    }
  | { type: 'code.assist.abort'; payload: { requestId: string } }
  | { type: 'webui.shutdown' };
