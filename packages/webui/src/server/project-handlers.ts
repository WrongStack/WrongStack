/**
 * Project route handlers — extracted from the startWebUI closure in index.ts.
 * Mirrors createProviderHandlers/createModeHandlers. selectProject is the heavy
 * one: it tears down the current session and re-initialises for the chosen
 * project, mutating several startWebUI `let` bindings. Those are threaded in as
 * getters/setters so the factory stays a pure function of its context — the
 * handler bodies are a verbatim lift, only the dependency references changed.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { WebSocket } from 'ws';
import {
  type Context,
  DefaultSessionStore,
  DefaultSystemPromptBuilder,
  type DefaultMemoryStore,
  type DefaultModeStore,
  type DefaultTokenCounter,
  getSessionRegistry,
  type SkillLoader,
  type ToolRegistry,
} from '@wrongstack/core';
import type { ConnectedClient } from './types.js';
import type { ProjectRouteHandlers } from './project-routes.js';
import { broadcast, errMessage, send, sendResult } from './ws-utils.js';
import {
  validateProjectsAddPayload,
  validateProjectsSelectPayload,
  validateWorkingDirSetPayload,
} from './ws-payload-validation.js';
import { ensureProjectDataDir, generateProjectSlug, loadManifest, saveManifest } from './projects-manifest.js';
import { resolveWorkingDirInsideProject } from './path-containment.js';

type Session = Awaited<ReturnType<DefaultSessionStore['create']>>;
type SessionStartPayload = {
  sessionId: string;
  model: string;
  provider: string;
  maxContext: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  projectName: string;
  projectRoot: string;
  cwd: string;
  mode: string;
  contextMode: string;
};
type ModelCapabilities = NonNullable<
  ConstructorParameters<typeof DefaultSystemPromptBuilder>[0]
>['modelCapabilities'];

export interface ProjectHandlersContext {
  globalConfigPath: string;
  wpaths: { globalRoot: string };
  clients: Map<WebSocket, ConnectedClient>;
  context: Context;
  modeStore: DefaultModeStore;
  memoryStore: DefaultMemoryStore;
  skillLoader: SkillLoader | undefined;
  modelCapabilities: ModelCapabilities;
  toolRegistry: ToolRegistry;
  tokenCounter: DefaultTokenCounter;
  config: { provider: string; model: string };
  // Live reads of the mutable startWebUI bindings.
  getModeId: () => string;
  getProjectRoot: () => string;
  getSession: () => Session;
  // Mutations of the startWebUI bindings.
  setProjectRoot: (p: string) => void;
  setWorkingDir: (p: string) => void;
  setSession: (s: Session) => void;
  setSessionStore: (s: DefaultSessionStore) => void;
  setSessionStartedAt: (t: number) => void;
  /** Abort + clear any in-flight runLock before switching projects. */
  abortRunLock: () => void;
  sessionStartPayload: () => Promise<SessionStartPayload>;
}

export function createProjectHandlers(ctx: ProjectHandlersContext): ProjectRouteHandlers {
  return {
    listProjects: async (ws) => {
      try {
        const manifest = await loadManifest(ctx.globalConfigPath);
        send(ws, { type: 'projects.list', payload: { projects: manifest.projects } });
      } catch (err) {
        send(ws, { type: 'projects.list', payload: { projects: [], error: errMessage(err) } });
      }
    },
    addProject: async (ws, msg) => {
      const parsed = validateProjectsAddPayload(msg.payload);
      if (!parsed.ok) {
        send(ws, {
          type: 'projects.added',
          payload: { name: '', root: '', slug: '', message: parsed.message },
        });
        return;
      }
      const { root: addRoot, name: displayName } = parsed.value;
      try {
        const resolved = path.resolve(addRoot);
        await fs.access(resolved);
        const stat = await fs.stat(resolved);
        if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`);

        const manifest = await loadManifest(ctx.globalConfigPath);
        const existing = manifest.projects.find((p) => p.root === resolved);
        if (existing) {
          send(ws, {
            type: 'projects.added',
            payload: {
              name: existing.name,
              root: existing.root,
              slug: existing.slug,
              message: `Already registered as "${existing.name}"`,
            },
          });
          return;
        }

        const name = displayName?.trim() || path.basename(resolved);
        const slug = generateProjectSlug(resolved);
        await ensureProjectDataDir(slug, ctx.globalConfigPath);
        const now = new Date().toISOString();
        manifest.projects.push({ name, root: resolved, slug, lastSeen: now, createdAt: now });
        await saveManifest(manifest, ctx.globalConfigPath);

        send(ws, {
          type: 'projects.added',
          payload: { name, root: resolved, slug, message: `Registered project "${name}"` },
        });
      } catch (err) {
        send(ws, {
          type: 'projects.added',
          payload: { name: path.basename(addRoot), root: addRoot, slug: '', message: errMessage(err) },
        });
      }
    },
    selectProject: async (ws, msg) => {
      const parsed = validateProjectsSelectPayload(msg.payload);
      if (!parsed.ok) {
        send(ws, {
          type: 'projects.selected',
          payload: { root: '', name: '', message: parsed.message },
        });
        return;
      }
      const { root: selRoot, name: selName } = parsed.value;
      try {
        const resolved = path.resolve(selRoot);

        try {
          await fs.access(resolved);
          const stat = await fs.stat(resolved);
          if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
        } catch (err) {
          send(ws, {
            type: 'projects.selected',
            payload: {
              root: selRoot,
              name: selName || path.basename(selRoot),
              message: `Cannot switch: ${errMessage(err)}`,
            },
          });
          return;
        }

        const manifest = await loadManifest(ctx.globalConfigPath);
        const entry = manifest.projects.find((p) => p.root === resolved);
        if (entry) {
          entry.lastSeen = new Date().toISOString();
          entry.lastWorkingDir = resolved;
        } else {
          const name = selName?.trim() || path.basename(resolved);
          const slug = generateProjectSlug(resolved);
          manifest.projects.push({
            name,
            root: resolved,
            slug,
            lastSeen: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            lastWorkingDir: resolved,
          });
          await ensureProjectDataDir(slug, ctx.globalConfigPath);
        }
        await saveManifest(manifest, ctx.globalConfigPath);

        ctx.abortRunLock();

        ctx.setProjectRoot(resolved);
        ctx.setWorkingDir(resolved);
        ctx.context.cwd = resolved;
        ctx.context.projectRoot = resolved;

        const switchSlug = entry?.slug ?? generateProjectSlug(resolved);

        try {
          const modeId = ctx.getModeId();
          const switchMode = modeId === 'default' ? undefined : await ctx.modeStore.getMode(modeId);
          const switchBuilder = new DefaultSystemPromptBuilder({
            memoryStore: ctx.memoryStore,
            skillLoader: ctx.skillLoader,
            modeStore: ctx.modeStore,
            modeId,
            modePrompt: switchMode?.prompt ?? '',
            modelCapabilities: ctx.modelCapabilities,
          });
          ctx.context.systemPrompt = await switchBuilder.build({
            cwd: resolved,
            projectRoot: resolved,
            tools: ctx.toolRegistry.list(),
            provider: ctx.config.provider,
            model: ctx.config.model,
          });
        } catch {
          /* best-effort */
        }

        const newSessionsDir = path.join(
          path.dirname(ctx.globalConfigPath),
          'projects',
          switchSlug,
          'sessions',
        );
        await fs.mkdir(newSessionsDir, { recursive: true });
        const newSessionStore = new DefaultSessionStore({ dir: newSessionsDir });

        const oldSession = ctx.getSession();
        const oldSessionId = oldSession.id;
        try {
          await oldSession.append({
            type: 'session_end',
            ts: new Date().toISOString(),
            usage: ctx.tokenCounter.total(),
          });
          await oldSession.close();
        } catch {
          // best-effort
        }

        ctx.setSessionStore(newSessionStore);
        const newSession = await newSessionStore.create({
          id: '',
          title: '',
          model: ctx.config.model,
          provider: ctx.config.provider,
        });
        ctx.setSession(newSession);
        ctx.context.session = newSession;
        ctx.context.state.replaceMessages([]);
        ctx.context.state.replaceTodos([]);
        ctx.context.readFiles.clear();
        ctx.context.fileMtimes.clear();
        ctx.tokenCounter.reset();
        ctx.setSessionStartedAt(Date.now());

        try {
          const registry = getSessionRegistry(ctx.wpaths.globalRoot);
          await registry.register({
            sessionId: newSession.id,
            projectSlug: switchSlug,
            projectRoot: resolved,
            projectName: path.basename(resolved),
            workingDir: resolved,
            clientType: 'webui',
            pid: process.pid,
            startedAt: new Date().toISOString(),
          });
        } catch {
          /* best-effort */
        }

        send(ws, {
          type: 'projects.selected',
          payload: {
            root: resolved,
            name: selName || path.basename(resolved),
            message: `Switched to ${selName || path.basename(resolved)}`,
          },
        });

        broadcast(ctx.clients, {
          type: 'subagent.event',
          payload: { kind: 'session_stopped', sessionId: oldSessionId },
        });

        broadcast(ctx.clients, {
          type: 'session.start',
          payload: {
            ...(await ctx.sessionStartPayload()),
            reset: true,
            clearedSessionId: oldSessionId,
          },
        });
      } catch (err) {
        send(ws, {
          type: 'projects.selected',
          payload: {
            root: selRoot,
            name: selName || path.basename(selRoot),
            message: errMessage(err),
          },
        });
      }
    },
    setWorkingDir: async (ws, msg) => {
      const parsed = validateWorkingDirSetPayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      const { path: newPath } = parsed.value;
      try {
        const projectRoot = ctx.getProjectRoot();
        const resolved = await resolveWorkingDirInsideProject(projectRoot, newPath);

        ctx.setWorkingDir(resolved);
        ctx.context.cwd = resolved;

        broadcast(ctx.clients, {
          type: 'working_dir.changed',
          payload: { cwd: resolved, projectRoot },
        });

        sendResult(ws, true, `Working directory set to ${resolved}`);
      } catch (err) {
        sendResult(ws, false, errMessage(err));
      }
    },
  };
}
