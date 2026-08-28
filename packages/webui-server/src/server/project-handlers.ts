import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { DefaultSessionStore } from '@wrongstack/core/storage';
import type { SessionStore, TokenCounter } from '@wrongstack/core/types';
import { activateProjectStateGuard, resolveWstackPaths } from '@wrongstack/core/utils';
import type { WebSocket } from 'ws';
import { resolveWorkingDirInsideProject } from './path-containment.js';
import type { ProjectRouteHandlers } from './project-routes.js';
import { loadManifest, touchProjectInManifest } from './projects-manifest.js';
import type { SessionIdentityTarget } from './standalone-session-identity.js';
import type { ConnectedClient } from './types.js';
import {
  validateProjectsAddPayload,
  validateProjectsSelectPayload,
  validateWorkingDirSetPayload,
} from './ws-payload-validation.js';
import { broadcast, broadcastAll, errMessage, send, sendResult } from './ws-utils.js';

type Session = Awaited<ReturnType<SessionStore['create']>>;
type OutboundMessage = { type: string; payload: unknown };

export interface ProjectHandlersContext {
  globalConfigPath: string;
  wpaths: { globalRoot: string };
  clients?: Map<WebSocket, ConnectedClient>;
  sendMessage?: (ws: WebSocket, message: OutboundMessage) => void;
  broadcastMessage?: (message: OutboundMessage) => void;
  context: Context;
  tokenCounter: TokenCounter;
  config: { provider: string; model: string };
  getConfig?: () => { provider: string; model: string };
  getProjectRoot: () => string;
  getSession: () => Session;
  setProjectRoot: (projectRoot: string) => void;
  setWorkingDir: (workingDir: string) => void;
  setSession: (session: Session) => void;
  setSessionStore: (store: DefaultSessionStore) => void;
  setSessionStartedAt?: (startedAt: number) => void;
  abortRunLock: () => void;
  abortAllRuns?: () => void;
  onBeforeSessionTodosReplaced?:
    | ((sessionId: string, sessionsDir: string) => void | Promise<void>)
    | undefined;
  onSessionSwapped?: (sessionId: string, target?: SessionIdentityTarget) => void | Promise<void>;
  allowProjectMutations?: boolean;
  sessionStartPayload: (overrides?: Record<string, unknown>) => Promise<unknown>;
  /**
   * Deliver to EVERY connection, bypassing the session filter.
   *
   * Both hosts now route a broadcast by the `sessionId` on its payload, which
   * is right for everything that describes one tab and wrong for the project
   * switch: it announces a session created a millisecond ago, so no client can
   * be subscribed to it and the filter dropped the switch on the floor —
   * exactly the "changed NOTHING in the browser" failure this handler exists
   * to prevent. Optional; falls back to the plain broadcast for hosts that do
   * not filter.
   */
  broadcastEveryone?: (message: OutboundMessage) => void;
}

export function createProjectHandlers(ctx: ProjectHandlersContext): ProjectRouteHandlers {
  const sendTo = (ws: WebSocket, message: OutboundMessage): void => {
    if (ctx.sendMessage) ctx.sendMessage(ws, message);
    else send(ws, message);
  };
  const broadcastToAll = (message: OutboundMessage): void => {
    if (ctx.broadcastMessage) ctx.broadcastMessage(message);
    else broadcast(ctx.clients ?? new Map(), message);
  };
  /** @see ProjectHandlersContext.broadcastEveryone */
  const announceToEveryClient = (message: OutboundMessage): void => {
    if (ctx.broadcastEveryone) ctx.broadcastEveryone(message);
    else if (ctx.clients) broadcastAll(ctx.clients, message);
    else broadcastToAll(message);
  };
  const result = (ws: WebSocket, success: boolean, message: string): void => {
    if (ctx.sendMessage) {
      sendTo(ws, { type: 'key.operation_result', payload: { success, message } });
    } else {
      sendResult(ws, success, message);
    }
  };

  return {
    listProjects: async (ws) => {
      try {
        const manifest = await loadManifest(ctx.globalConfigPath);
        sendTo(ws, { type: 'projects.list', payload: { projects: manifest.projects } });
      } catch (error) {
        sendTo(ws, {
          type: 'projects.list',
          payload: { projects: [], error: errMessage(error) },
        });
      }
    },
    addProject: async (ws, msg) => {
      const parsed = validateProjectsAddPayload(msg.payload);
      if (!parsed.ok) {
        sendTo(ws, {
          type: 'projects.added',
          payload: { name: '', root: '', slug: '', message: parsed.message },
        });
        return;
      }
      if (!ctx.allowProjectMutations) {
        sendTo(ws, {
          type: 'projects.added',
          payload: {
            name: parsed.value.name ?? '',
            root: parsed.value.root,
            slug: '',
            message:
              'Project registration is disabled in WebUI. Open/register projects from the launcher or desktop shell.',
          },
        });
        return;
      }
      const resolved = path.resolve(parsed.value.root);
      const name = parsed.value.name?.trim() || path.basename(resolved);
      try {
        const stat = await fs.stat(resolved).catch(() => null);
        if (!stat?.isDirectory()) {
          sendTo(ws, {
            type: 'projects.added',
            payload: { name, root: resolved, slug: '', message: `Not a directory: ${resolved}` },
          });
          return;
        }
        const before = await loadManifest(ctx.globalConfigPath);
        const already = before.projects.some((project) => path.resolve(project.root) === resolved);
        const entry = await touchProjectInManifest(
          { projectRoot: resolved, workingDir: resolved, name },
          ctx.globalConfigPath,
        );
        sendTo(ws, {
          type: 'projects.added',
          payload: {
            name: entry.name,
            root: entry.root,
            slug: entry.slug,
            message: already
              ? `Already registered project "${entry.name}"`
              : `Registered project "${entry.name}"`,
          },
        });
      } catch (error) {
        sendTo(ws, {
          type: 'projects.added',
          payload: { name, root: resolved, slug: '', message: errMessage(error) },
        });
      }
    },
    selectProject: async (ws, msg) => {
      const parsed = validateProjectsSelectPayload(msg.payload);
      if (!parsed.ok) {
        sendTo(ws, {
          type: 'projects.selected',
          payload: { root: '', name: '', message: parsed.message },
        });
        return;
      }
      const resolved = path.resolve(parsed.value.root);
      const name = parsed.value.name?.trim() || path.basename(resolved);
      if (!ctx.allowProjectMutations) {
        sendTo(ws, {
          type: 'projects.selected',
          payload: {
            root: resolved,
            name,
            message:
              'Project switching is disabled in WebUI. Open a project from the launcher or desktop shell instead.',
          },
        });
        return;
      }
      try {
        const stat = await fs.stat(resolved).catch(() => null);
        if (!stat?.isDirectory()) {
          sendTo(ws, {
            type: 'projects.selected',
            payload: {
              root: resolved,
              name,
              message: `Cannot switch: not a directory: ${resolved}`,
            },
          });
          return;
        }
        const paths = resolveWstackPaths({
          projectRoot: resolved,
          globalRoot: ctx.wpaths.globalRoot,
        });
        const store = new DefaultSessionStore({
          dir: paths.projectSessions,
          projectRoot: resolved,
        });
        const previous = ctx.getSession();
        const previousId = previous.id;
        const previousProjectRoot = ctx.getProjectRoot();
        const previousPaths = resolveWstackPaths({
          projectRoot: previousProjectRoot,
          globalRoot: ctx.wpaths.globalRoot,
        });
        const previousIdentityTarget: SessionIdentityTarget = {
          projectSlug: previousPaths.projectSlug,
          projectRoot: previousProjectRoot,
          projectName: path.basename(previousProjectRoot),
          workingDir: ctx.context.workingDir,
        };
        const previousUsage = ctx.tokenCounter.total();
        const config = ctx.getConfig?.() ?? ctx.config;
        const next = await store.create({
          id: '',
          title: '',
          model: config.model,
          provider: config.provider,
        });

        try {
          ctx.abortRunLock();
          ctx.abortAllRuns?.();
        } catch {
          // Best-effort cancellation must not strand the fresh writer.
        }
        await touchProjectInManifest(
          { projectRoot: resolved, workingDir: resolved, name },
          ctx.globalConfigPath,
        );
        const identityTarget: SessionIdentityTarget = {
          projectSlug: paths.projectSlug,
          projectRoot: resolved,
          projectName: name,
          workingDir: resolved,
        };
        try {
          await ctx.onSessionSwapped?.(next.id, identityTarget);
          await ctx.onBeforeSessionTodosReplaced?.(next.id, paths.projectSessions);
          await activateProjectStateGuard(resolved);
        } catch (err) {
          try {
            await ctx.onBeforeSessionTodosReplaced?.(previous.id, previousPaths.projectSessions);
          } catch {
            // Best-effort rollback must continue restoring identity and disposing the fresh writer.
          }
          try {
            await ctx.onSessionSwapped?.(previous.id, previousIdentityTarget);
          } catch {
            // Best-effort rollback must still dispose the fresh writer.
          }
          await next.close().catch(() => undefined);
          await store.delete(next.id).catch(() => undefined);
          throw err;
        }
        ctx.setProjectRoot(resolved);
        ctx.setWorkingDir(resolved);
        ctx.setSessionStore(store);
        ctx.setSession(next);
        ctx.context.projectRoot = resolved;
        ctx.context.cwd = resolved;
        ctx.context.workingDir = resolved;
        ctx.context.session = next;
        ctx.context.state.replaceMessages([]);
        ctx.context.state.replaceTodos([]);
        ctx.context.clearMemoryEvidence?.();
        ctx.context.readFiles.clear();
        ctx.context.fileMtimes.clear();
        ctx.tokenCounter.reset();

        if (previous !== next) {
          await previous
            .append({ type: 'session_end', ts: new Date().toISOString(), usage: previousUsage })
            .catch(() => undefined);
          await previous.close().catch(() => undefined);
        }
        ctx.setSessionStartedAt?.(Date.now());
        sendTo(ws, {
          type: 'projects.selected',
          payload: { root: resolved, name, message: `Switched to ${name}` },
        });
        // Every client, not every subscriber: see `broadcastEveryone`.
        announceToEveryClient({
          type: 'session.start',
          payload: await ctx.sessionStartPayload({ reset: true, clearedSessionId: previousId }),
        });
      } catch (error) {
        sendTo(ws, {
          type: 'projects.selected',
          payload: { root: resolved, name, message: `Cannot switch: ${errMessage(error)}` },
        });
      }
    },
    setWorkingDir: async (ws, msg) => {
      const parsed = validateWorkingDirSetPayload(msg.payload);
      if (!parsed.ok) {
        result(ws, false, parsed.message);
        return;
      }
      try {
        const projectRoot = ctx.getProjectRoot();
        const resolved = await resolveWorkingDirInsideProject(projectRoot, parsed.value.path);
        ctx.setWorkingDir(resolved);
        ctx.context.cwd = resolved;
        broadcastToAll({ type: 'working_dir.changed', payload: { cwd: resolved, projectRoot } });
        result(ws, true, `Working directory set to ${resolved}`);
      } catch (error) {
        result(ws, false, errMessage(error));
      }
    },
  };
}
