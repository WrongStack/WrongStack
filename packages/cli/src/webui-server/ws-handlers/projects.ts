import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type Agent,
  DefaultSystemPromptBuilder,
  type MemoryStore,
  type ModeStore,
  projectSlug,
  resolveProjectDir,
  type SessionStore,
  type SessionWriter,
  type SkillLoader,
  wstackGlobalRoot,
} from '@wrongstack/core';
import { DefaultSessionStore } from '@wrongstack/core/storage';
import type { WebSocket } from 'ws';
import {
  ensureProjectDataDir,
  loadManifest,
  saveManifest,
} from '../../slash-commands/project-utils.js';
import type { WsCommon } from './index.js';

/**
 * PR 5g of Issue #30: project-management WebSocket handlers —
 * `projects.list`, `projects.select`, `projects.add`, and
 * `working_dir.set`.
 *
 * `projects.select` is the heavyweight: it re-roots the entire run in
 * place (mutates `opts.projectRoot` / `opts.sessionStore`, aborts the
 * in-flight run, finalizes the old session writer, rebuilds the system
 * prompt, starts a fresh session, and broadcasts a reset session.start).
 * Because every other handler reads `opts.projectRoot` / `ctx` at call
 * time, mutating those fields re-roots them all without further plumbing.
 *
 * To keep that working from a module, `opts` is passed by reference (the
 * SAME object runWebUI holds — `ProjectsOptions` is just the subset these
 * handlers touch), the legacy abort slot is a callback, and the
 * session.start payload builder is the `buildSessionStart` callback.
 */

/** The subset of CliWebUIOptions the project handlers read/mutate. Passed by reference. */
export interface ProjectsOptions {
  projectRoot?: string | undefined;
  globalConfigPath?: string | undefined;
  agent: Agent;
  modeId?: string | undefined;
  modeStore?: ModeStore | undefined;
  memoryStore?: MemoryStore | undefined;
  skillLoader?: SkillLoader | undefined;
  sessionStore?: SessionStore | undefined;
  session: SessionWriter;
  onSessionSwapped?: ((newSessionId: string) => void) | undefined;
}

export interface ProjectsContext extends WsCommon {
  /** The live options object (mutated in place by projects.select). */
  opts: ProjectsOptions;
  /** Per-socket abort controllers — the switching socket's is dropped on select. */
  abortControllers: Map<WebSocket, AbortController>;
  /** Abort the legacy single-slot in-flight run and clear it (run-loop closure). */
  abortLegacyRun: () => void;
  /** Build the reset session.start payload (runWebUI closure). */
  buildSessionStart: (overrides?: Record<string, unknown>) => Promise<unknown>;
}

function sendResult(ctx: WsCommon, ws: WebSocket, success: boolean, message: string): void {
  ctx.send(ws, { type: 'key.operation_result', payload: { success, message } });
}

export async function handleProjectsList(ctx: ProjectsContext, ws: WebSocket): Promise<void> {
  // Read the project manifest from ~/.wrongstack/projects.json
  const projectsBase = ctx.opts.globalConfigPath
    ? path.resolve(path.dirname(ctx.opts.globalConfigPath))
    : wstackGlobalRoot();
  const manifestPath = path.join(projectsBase, 'projects.json');
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as {
      projects: Array<{ name: string; root: string; slug: string; lastSeen?: string }>;
    };
    ctx.send(ws, { type: 'projects.list', payload: { projects: manifest.projects ?? [] } });
  } catch {
    ctx.send(ws, { type: 'projects.list', payload: { projects: [] } });
  }
}

export async function handleProjectsSelect(
  ctx: ProjectsContext,
  ws: WebSocket,
  payload: { root: string; name?: string | undefined },
): Promise<void> {
  const { opts } = ctx;
  const { root, name: projectName } = payload;
  try {
    const resolved = path.resolve(root);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isDirectory()) {
      ctx.send(ws, {
        type: 'projects.selected',
        payload: {
          root,
          name: projectName ?? path.basename(root),
          message: `Cannot switch: not a directory: ${resolved}`,
        },
      });
      return;
    }

    // Manifest: bump lastSeen, or auto-register an unknown root.
    const manifest = await loadManifest(opts.globalConfigPath);
    const entry = manifest.projects.find((p) => path.resolve(p.root) === resolved);
    const displayName = projectName?.trim() || entry?.name || path.basename(resolved);
    if (entry) {
      entry.lastSeen = new Date().toISOString();
    } else {
      manifest.projects.push({
        name: displayName,
        root: resolved,
        slug: projectSlug(resolved),
        lastSeen: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });
    }
    await saveManifest(manifest, opts.globalConfigPath);

    // Abort any in-flight run — its context is about to be re-rooted. The
    // legacy single slot (project-switch path) and this switching socket's
    // controller both clear; other sockets see the change via the
    // broadcast below rather than being aborted.
    ctx.abortLegacyRun();
    ctx.abortControllers.delete(ws);

    const actx = opts.agent.ctx;
    const oldSessionId = actx.session?.id ?? opts.session.id;

    // Finalize the writer we are leaving. Usage captured before the counter
    // reset below (the closure runs after it).
    const oldWriter = actx.session;
    const oldUsage = actx.tokenCounter.total();
    if (oldWriter) {
      void (async () => {
        await oldWriter
          .append({ type: 'session_end', ts: new Date().toISOString(), usage: oldUsage })
          .catch(() => undefined);
        await oldWriter.close().catch(() => undefined);
      })();
    }

    // Re-root: every handler resolves opts.projectRoot / ctx at call time
    // (files.*, mailbox.*, goal, …), so mutating these re-roots them all.
    opts.projectRoot = resolved;
    actx.cwd = resolved;
    actx.projectRoot = resolved;

    // Rebuild the system prompt for the NEW project (best-effort).
    try {
      const switchMode =
        opts.modeId && opts.modeId !== 'default' && opts.modeStore
          ? await opts.modeStore.getMode(opts.modeId)
          : undefined;
      const switchBuilder = new DefaultSystemPromptBuilder({
        memoryStore: opts.memoryStore,
        skillLoader: opts.skillLoader,
        modeStore: opts.modeStore,
        modeId: opts.modeId ?? 'default',
        modePrompt: switchMode?.prompt ?? '',
      });
      actx.systemPrompt = await switchBuilder.build({
        cwd: resolved,
        projectRoot: resolved,
        tools: opts.agent.tools.list(),
        provider: (actx.provider as { id?: string }).id,
        model: actx.model,
      });
    } catch {
      /* best-effort — keep the prior system prompt if rebuild fails */
    }

    // Fresh per-project session store + session.
    const globalRoot = opts.globalConfigPath
      ? path.dirname(opts.globalConfigPath)
      : wstackGlobalRoot();
    const newSessionsDir = path.join(resolveProjectDir(resolved, globalRoot), 'sessions');
    await fs.mkdir(newSessionsDir, { recursive: true });
    const newStore = new DefaultSessionStore({ dir: newSessionsDir });
    opts.sessionStore = newStore;
    const newWriter = await newStore.create({
      id: '',
      title: '',
      model: actx.model,
      provider: (actx.provider as { id?: string }).id ?? '',
    });
    actx.session = newWriter;
    opts.onSessionSwapped?.(newWriter.id);
    actx.state.replaceMessages([]);
    actx.state.replaceTodos([]);
    actx.readFiles.clear();
    actx.fileMtimes.clear();
    actx.tokenCounter.reset();

    ctx.send(ws, {
      type: 'projects.selected',
      payload: { root: resolved, name: displayName, message: `Switched to ${displayName}` },
    });
    // Full-state broadcast so ALL clients re-root their panels.
    const switchedP = await ctx.buildSessionStart({ reset: true, clearedSessionId: oldSessionId });
    ctx.broadcast({ type: 'session.start', payload: switchedP });
  } catch (err) {
    sendResult(ctx, ws, false, err instanceof Error ? err.message : String(err));
  }
}

export async function handleProjectsAdd(
  ctx: ProjectsContext,
  ws: WebSocket,
  payload: { root: string; name?: string | undefined },
): Promise<void> {
  const { root: addRoot, name: addName } = payload;
  try {
    const resolved = path.resolve(addRoot);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`Not a directory: ${resolved}`);

    const manifest = await loadManifest(ctx.opts.globalConfigPath);
    const existing = manifest.projects.find((p) => path.resolve(p.root) === resolved);
    if (existing) {
      ctx.send(ws, {
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
    const name = addName?.trim() || path.basename(resolved);
    const slug = projectSlug(resolved);
    await ensureProjectDataDir(slug, ctx.opts.globalConfigPath);
    const now = new Date().toISOString();
    manifest.projects.push({ name, root: resolved, slug, lastSeen: now, createdAt: now });
    await saveManifest(manifest, ctx.opts.globalConfigPath);
    ctx.send(ws, {
      type: 'projects.added',
      payload: { name, root: resolved, slug, message: `Registered project "${name}"` },
    });
  } catch (err) {
    ctx.send(ws, {
      type: 'projects.added',
      payload: {
        name: path.basename(addRoot),
        root: addRoot,
        slug: '',
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

export async function handleWorkingDirSet(
  ctx: ProjectsContext,
  ws: WebSocket,
  newPath: string,
): Promise<void> {
  try {
    const wdRoot = ctx.opts.projectRoot ?? ctx.opts.agent.ctx.projectRoot;
    const resolved = path.resolve(wdRoot, newPath);
    if (!resolved.startsWith(wdRoot + path.sep) && resolved !== wdRoot) {
      sendResult(ctx, ws, false, `Path must stay inside the project root: ${wdRoot}`);
      return;
    }
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isDirectory()) {
      sendResult(ctx, ws, false, `Directory not found or not accessible: ${resolved}`);
      return;
    }
    ctx.opts.agent.ctx.cwd = resolved;
    ctx.broadcast({ type: 'working_dir.changed', payload: { cwd: resolved, projectRoot: wdRoot } });
    sendResult(ctx, ws, true, `Working directory set to ${resolved}`);
  } catch (err) {
    sendResult(ctx, ws, false, err instanceof Error ? err.message : String(err));
  }
}
