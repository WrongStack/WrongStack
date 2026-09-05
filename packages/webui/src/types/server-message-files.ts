import type { SessionScopedPayload } from './protocol-core.js';

export type WSFilesGitServerMessage =
  | {
      type: 'codebase.index.server.shutdown_result';
      payload: {
        requestId?: string | undefined;
        stopped: boolean;
        pid?: number | undefined;
        reason?: string | undefined;
      };
    }
  | {
      type: 'files.tree';
      payload: {
        root: string;
        tree: unknown[];
        error?: string | undefined;
        sessionId?: string | undefined;
      };
    }
  | {
      type: 'files.read';
      payload: {
        filePath: string;
        content: string;
        /** Server refused content: NUL byte detected (see handleFilesRead). */
        binary?: boolean | undefined;
        /** Server refused content: file exceeds the 2 MB display cap. */
        tooLarge?: boolean | undefined;
        error?: string | undefined;
        sessionId?: string | undefined;
      };
    }
  | {
      type: 'files.skeleton_result';
      payload: {
        filePath: string;
        lang?: string | undefined;
        skeleton: string;
        stats?:
          | {
              originalLines: number;
              skeletonLines: number;
              tokenSavingsPercent: number;
              symbolCount: number;
            }
          | undefined;
        error?: string | undefined;
      };
    }
  | {
      type: 'files.written';
      payload: {
        filePath: string;
        success: boolean;
        error?: string | undefined;
        sessionId?: string | undefined;
      };
    }
  | {
      type: 'files.created';
      payload: {
        filePath: string;
        success: boolean;
        error?: string | undefined;
        sessionId?: string | undefined;
      };
    }
  | {
      type: 'files.deleted';
      payload: {
        filePath: string;
        success: boolean;
        error?: string | undefined;
        sessionId?: string | undefined;
      };
    }
  | {
      type: 'files.renamed';
      payload: {
        oldPath: string;
        newPath: string;
        success: boolean;
        error?: string | undefined;
        sessionId?: string | undefined;
      };
    }
  | {
      type: 'files.moved';
      payload: {
        srcPath: string;
        destPath: string;
        success: boolean;
        error?: string | undefined;
        sessionId?: string | undefined;
      };
    }
  | {
      type: 'git.info';
      payload: {
        branch: string;
        added: number;
        deleted: number;
        untracked: number;
        behind: number;
        ahead: number;
      };
    }
  | {
      type: 'git.action_result';
      payload: {
        action: 'stage' | 'unstage' | 'discard' | 'commit';
        ok: boolean;
        paths?: string[] | undefined;
        message?: string | undefined;
        error?: string | undefined;
      };
    }
  | {
      type: 'git.changes';
      payload: {
        files: Array<{
          path: string;
          status: string;
          added: number;
          deleted: number;
          staged: boolean;
        }>;
        /**
         * Aggregate status per directory (repo-relative keys): the
         * highest-ranked child status, computed server-side — replaces the
         * old client-side prefix-scan heuristic in FileExplorer.
         */
        dirs?: Record<string, string> | undefined;
        /** Repo→project path prefix ('' when equal) — see repoRelativePrefix. */
        repoPrefix?: string | undefined;
        error?: string | undefined;
      };
    }
  | {
      type: 'git.diff';
      payload: {
        path: string;
        oldText?: string | undefined;
        newText?: string | undefined;
        binary?: boolean | undefined;
        tooLarge?: boolean | undefined;
        error?: string | undefined;
      };
    }
  | {
      type: 'projects.list';
      payload: {
        projects: Array<{
          name: string;
          root: string;
          slug: string;
          lastSeen?: string | undefined;
        }>;
      };
    }
  | {
      type: 'projects.added';
      payload: { name: string; root: string; slug: string; message: string };
    }
  | { type: 'projects.selected'; payload: { root: string; name: string; message: string } }
  | { type: 'working_dir.changed'; payload: { cwd: string; projectRoot: string } }
  | { type: 'file.saved'; payload: SessionScopedPayload & { filePath: string } }
  | {
      type: 'codemap.file_event';
      payload: SessionScopedPayload & {
        filePath: string;
        operation: 'read' | 'write' | 'edit' | 'delete' | 'rename';
        phase: 'started' | 'completed' | 'changed';
        source: 'tool' | 'editor' | 'deterministic' | 'watcher' | 'external';
        at: number;
        traceId?: string | undefined;
        agentId?: string | undefined;
        agentName?: string | undefined;
        toolUseId?: string | undefined;
        toolName?: string | undefined;
        line?: number | undefined;
        endLine?: number | undefined;
      };
    }
  | {
      type: 'codemap.index_updated';
      payload: {
        at: number;
        ready: boolean;
        reason: 'index_complete';
      };
    };
