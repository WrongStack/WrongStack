import type { SessionScopedPayload } from './protocol-core.js';
import type { ContextEditorMessage, ContextEditorRemoval } from './runtime.js';
import type { SageAnchor, SageScope, SageStatus, WSMemorySageForFileRequest } from './sage.js';
import type { SageDoctorFixId } from './sage-doctor.js';
export type ClientMessageServices =
  | {
      type: 'plugin.ui.prompt_response';
      payload: {
        requestId: string;
        promptId?: string | undefined;
        value: string | boolean | null;
      };
    }
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
        /**
         * Reconnect catch-up: the last numbered frame (`seq`) this page applied
         * per tab, valid for the server process that issued `eventEpoch`. The
         * server sends back the frames after it, then `session.frames_resumed`.
         */
        cursors?: Record<string, number>;
        eventEpoch?: string;
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
  | { type: 'memory.list' }
  | { type: 'memory.sage.list' }
  | {
      type: 'memory.sage.listPage';
      payload: {
        statuses?: string[] | undefined;
        kind?: string | undefined;
        query?: string | undefined;
        limit?: number | undefined;
        cursor?: string | undefined;
        /**
         * Compute store-wide `stats` for this page. Default true; filter and
         * search reloads send false because the stats did not change.
         */
        includeStats?: boolean | undefined;
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
        /** Correlation id the server echoes on the response. */
        requestId?: string | undefined;
      };
    }
  | {
      type: 'memory.sage.doctor';
      payload?:
        | {
            /** Named repairs (SAGE_DOCTOR_FIX_IDS) to apply before measuring. */
            fix?: SageDoctorFixId[] | undefined;
            /** Correlation id the server echoes on the response. */
            requestId?: string | undefined;
          }
        | undefined;
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
        validity?: import('./sage').SageEntry['validity'];
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
  | { type: 'diag.get'; payload?: SessionScopedPayload }
  | { type: 'stats.get'; payload?: SessionScopedPayload }
  | { type: 'command.list'; payload?: { requestId?: string | undefined } }
  | {
      type: 'command.run';
      payload: {
        name: string;
        args?: string | undefined;
        requestId?: string | undefined;
      } & SessionScopedPayload;
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
  | {
      type: 'files.read';
      payload: { filePath: string; requestId?: string | undefined } & SessionScopedPayload;
    }
  | {
      type: 'files.image';
      payload: { filePath: string; requestId?: string | undefined } & SessionScopedPayload;
    }
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
  | { type: 'mcp.tools'; payload: { name: string } }
  | {
      type: 'mcp.tool.call';
      payload: {
        sessionId?: string;
        requestId: string;
        name: string;
        tool: string;
        input: Record<string, unknown>;
      };
    }
  | {
      type: 'mcp.prompt.get';
      payload: { name: string; prompt: string; arguments?: Record<string, string> };
    }
  | { type: 'mcp.auth.status'; payload: { name: string } }
  | { type: 'mcp.auth.login'; payload: { name: string; clientId?: string; scopes?: string[] } }
  | { type: 'mcp.auth.logout'; payload: { name: string } }
  | {
      type: 'mcp.tasks.list' | 'mcp.tasks.subscribe' | 'mcp.tasks.unsubscribe';
      payload: { sessionId: string; requestId: string };
    }
  | {
      type: 'mcp.tasks.retry' | 'mcp.tasks.cancel';
      payload: { sessionId: string; requestId: string; id: string };
    }
  | { type: 'tools.list' }
  | { type: 'tool.enable'; payload: { name: string } }
  | { type: 'tool.disable'; payload: { name: string } };
