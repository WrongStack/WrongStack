import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, projectSlug, toErrorMessage, wstackGlobalRoot } from '@wrongstack/core/utils';
import type {
  DesktopProjectEntry,
  DesktopRuntimeKind,
  DesktopRuntimeRecord,
  DesktopStateSnapshot,
  DesktopWindowState,
} from '../shared/types.js';

interface DesktopStateFile {
  recentProjects?: DesktopProjectEntry[] | undefined;
  openProjects?: string[] | undefined;
  openProjectSessions?: DesktopProjectSessionState[] | undefined;
  activeRuntimeId?: string | null | undefined;
  activeProjectRoot?: string | null | undefined;
  window?: DesktopWindowState | undefined;
}

interface DesktopProjectSessionState {
  runtimeId?: string | undefined;
  name?: string | undefined;
  root: string;
  startedAt?: string | undefined;
}

interface RuntimeInternal extends DesktopRuntimeRecord {
  child: ChildProcess | null;
  token: string;
  logs: string[];
  logNotifyTimer: ReturnType<typeof setTimeout> | null;
}

interface OpenProjectOptions {
  name?: string | undefined;
  kind?: DesktopRuntimeKind | undefined;
  touchRecent?: boolean | undefined;
  forceNew?: boolean | undefined;
  runtimeId?: string | undefined;
}

const HTTP_PORT_START = 34560;
const WS_PORT_START = 34660;
const START_TIMEOUT_MS = 30_000;
const MIN_WINDOW_WIDTH = 760;
const MIN_WINDOW_HEIGHT = 520;

export class DesktopRuntimeManager extends EventEmitter {
  private readonly runtimes = new Map<string, RuntimeInternal>();
  private readonly stateFile = path.join(wstackGlobalRoot(), 'desktop.json');
  private recentProjects: DesktopProjectEntry[] = [];
  private registeredProjects: DesktopProjectEntry[] = [];
  private restoreProjectSessions: DesktopProjectSessionState[] = [];
  private restoreActiveRuntimeId: string | null = null;
  private restoreActiveProjectRoot: string | null = null;
  private lastActiveProjectRoot: string | null = null;
  private windowState: DesktopWindowState | null = null;
  private activeRuntimeId: string | null = null;
  private restoring = false;
  private workspaceRestoreCompleted = false;

  async init(): Promise<void> {
    const state = await this.loadDesktopState();
    this.recentProjects = state.recentProjects;
    this.registeredProjects = await readGlobalProjectManifest();
    this.restoreProjectSessions = state.openProjectSessions;
    this.restoreActiveRuntimeId = state.activeRuntimeId;
    this.restoreActiveProjectRoot = state.activeProjectRoot;
    this.lastActiveProjectRoot = state.activeProjectRoot;
    this.windowState = state.window;
  }

  snapshot(): DesktopStateSnapshot {
    return {
      activeRuntimeId: this.activeRuntimeId,
      runtimes: Array.from(this.runtimes.values()).map(publicRuntime),
      recentProjects: [...this.recentProjects],
      registeredProjects: [...this.registeredProjects],
      restoring: this.restoring,
    };
  }

  getWindowState(): DesktopWindowState | null {
    return this.windowState ? { ...this.windowState } : null;
  }

  async saveWindowState(window: DesktopWindowState): Promise<void> {
    this.windowState = { ...window };
    await this.saveDesktopState();
  }

  async restoreLastWorkspace(): Promise<void> {
    const sessions = this.restoreProjectSessions.filter(
      (session) => typeof session.root === 'string' && session.root.trim(),
    );
    if (sessions.length === 0 || this.restoring || this.runtimes.size > 0) {
      this.workspaceRestoreCompleted = true;
      return;
    }
    this.restoring = true;
    this.emitChanged();
    try {
      const seen = new Map<string, number>();
      for (const session of sessions) {
        const key = pathKey(session.root);
        const seenCount = seen.get(key) ?? 0;
        seen.set(key, seenCount + 1);
        await this.openProject(session.root, {
          forceNew: seenCount > 0,
          name: session.name,
          runtimeId: session.runtimeId,
        }).catch((err) => {
          process.stderr.write(
            `[desktop:restore] Failed to restore ${session.root}: ${toErrorMessage(err)}\n`,
          );
        });
      }
      let restoredActive = false;
      if (this.restoreActiveRuntimeId) {
        const active = this.runtimes.get(this.restoreActiveRuntimeId);
        if (active) {
          await this.activateRuntime(active.id);
          restoredActive = true;
        }
      }
      if (!restoredActive && this.restoreActiveProjectRoot) {
        const active = Array.from(this.runtimes.values()).find((runtime) =>
          samePath(runtime.root, this.restoreActiveProjectRoot ?? ''),
        );
        if (active) await this.activateRuntime(active.id);
      }
    } finally {
      this.restoring = false;
      this.workspaceRestoreCompleted = true;
      this.emitChanged();
      await this.saveDesktopState();
    }
  }

  getRuntime(id: string): DesktopRuntimeRecord | undefined {
    const runtime = this.runtimes.get(id);
    return runtime ? publicRuntime(runtime) : undefined;
  }

  getRuntimeUrlWithToken(id: string): string | undefined {
    const runtime = this.runtimes.get(id);
    if (!runtime) return undefined;
    const url = new URL(runtime.url);
    url.searchParams.set('token', runtime.token);
    url.searchParams.set('shell', 'desktop');
    return url.toString();
  }

  getRuntimeWsUrlWithToken(id: string): string | undefined {
    const runtime = this.runtimes.get(id);
    if (!runtime) return undefined;
    const url = new URL(`ws://127.0.0.1:${runtime.wsPort}`);
    url.searchParams.set('token', runtime.token);
    return url.toString();
  }

  async openProject(
    projectRoot: string,
    options: OpenProjectOptions = {},
  ): Promise<DesktopRuntimeRecord> {
    const resolved = path.resolve(projectRoot);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
    const kind = options.kind ?? 'project';
    const touchRecent = options.touchRecent ?? kind === 'project';
    const forceNew = options.forceNew === true;

    if (!forceNew) {
      const existing = Array.from(this.runtimes.values()).find(
        (runtime) =>
          samePath(runtime.root, resolved) &&
          runtime.kind === kind &&
          (runtime.status === 'starting' || runtime.status === 'running'),
      );
      if (existing) {
        this.activeRuntimeId = existing.id;
        if (existing.kind === 'project') this.lastActiveProjectRoot = existing.root;
        if (touchRecent) {
          await this.touchProject(existing.root);
        } else {
          await this.persistWorkspaceState();
        }
        this.emitChanged();
        return publicRuntime(existing);
      }
      const staleSameRoot = Array.from(this.runtimes.values()).filter(
        (runtime) => samePath(runtime.root, resolved) && runtime.kind === kind,
      );
      for (const stale of staleSameRoot) {
        await this.closeRuntimeInternal(stale.id, { persistWorkspace: false });
      }
    }

    const slug = projectSlug(resolved);
    const requestedRuntimeId = normalizeRuntimeId(options.runtimeId);
    const runtimeId =
      requestedRuntimeId && !this.runtimes.has(requestedRuntimeId)
        ? requestedRuntimeId
        : `${slug}-${randomBytes(3).toString('hex')}`;
    const name = options.name ?? nextRuntimeName(this.runtimes, resolved, kind);
    const httpPort = await findFreePort(HTTP_PORT_START, usedPorts(this.runtimes));
    const wsPort = await findFreePort(
      WS_PORT_START,
      new Set([...usedPorts(this.runtimes), httpPort]),
    );
    const token = randomBytes(24).toString('hex');
    const runtime: RuntimeInternal = {
      id: runtimeId,
      name,
      root: resolved,
      slug,
      kind,
      status: 'starting',
      httpPort,
      wsPort,
      url: `http://127.0.0.1:${httpPort}`,
      startedAt: new Date().toISOString(),
      token,
      child: null,
      logs: [],
      logNotifyTimer: null,
    };
    this.runtimes.set(runtimeId, runtime);
    this.activeRuntimeId = runtimeId;
    if (kind === 'project') this.lastActiveProjectRoot = resolved;
    if (touchRecent) {
      await this.touchProject(resolved);
    } else {
      await this.persistWorkspaceState();
    }
    this.emitChanged();

    try {
      const entry = resolveWebUiEntry();
      const distDir = resolveWebUiDistDir();
      const child = spawn(
        process.execPath,
        [
          entry,
          '--host',
          '127.0.0.1',
          '--port',
          String(httpPort),
          '--ws-port',
          String(wsPort),
          '--dist-dir',
          distDir,
          '--token',
          token,
          '--require-token',
        ],
        {
          cwd: resolved,
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            WEBUI_STRICT_PORT: '1',
            WRONGSTACK_DESKTOP: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      runtime.child = child;
      runtime.pid = child.pid;
      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        appendRuntimeLog(runtime, 'stdout', text);
        this.scheduleLogChanged(runtime);
        process.stdout.write(`[desktop:${runtime.id}] ${text}`);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        appendRuntimeLog(runtime, 'stderr', text);
        this.scheduleLogChanged(runtime);
        process.stderr.write(`[desktop:${runtime.id}] ${text}`);
      });
      child.once('error', (err) => {
        runtime.status = 'error';
        runtime.error = toErrorMessage(err);
        runtime.child = null;
        if (this.activeRuntimeId === runtime.id) {
          this.activeRuntimeId = firstRunningRuntimeId(this.runtimes);
        }
        this.emitChanged();
      });
      child.once('exit', (code, signal) => {
        if (runtime.status === 'error') return;
        runtime.status = 'stopped';
        runtime.error =
          code === 0
            ? undefined
            : `Exited with ${signal ?? `code ${code ?? 'unknown'}`}`;
        runtime.child = null;
        if (this.activeRuntimeId === runtime.id) {
          this.activeRuntimeId = firstRunningRuntimeId(this.runtimes);
        }
        this.emitChanged();
      });

      await waitForHttpReady(runtime.url, token, START_TIMEOUT_MS);
      if (runtime.status !== 'starting') {
        // The child exited or hit a spawn error while we were waiting.
        throw new Error(runtime.error ?? 'WebUI process exited during startup');
      }
      runtime.status = 'running';
      await this.persistWorkspaceState();
      this.emitChanged();
      return publicRuntime(runtime);
    } catch (err) {
      if (runtime.status !== 'stopped' && runtime.status !== 'error') {
        runtime.status = 'error';
      }
      if (runtime.error === undefined) {
        runtime.error = toErrorMessage(err);
      }
      await terminateProcessTree(runtime.child);
      runtime.child = null;
      if (this.activeRuntimeId === runtime.id) {
        this.activeRuntimeId = firstRunningRuntimeId(this.runtimes);
      }
      this.emitChanged();
      throw err;
    }
  }

  async activateRuntime(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`Runtime not found: ${id}`);
    this.activeRuntimeId = id;
    if (runtime.kind === 'project') this.lastActiveProjectRoot = runtime.root;
    if (runtime.kind === 'project') {
      await this.touchProject(runtime.root);
    } else {
      await this.persistWorkspaceState();
    }
    this.emitChanged();
  }

  async closeRuntime(id: string): Promise<void> {
    await this.closeRuntimeInternal(id, { persistWorkspace: true });
  }

  async closeAll(options: { persistWorkspace?: boolean } = {}): Promise<void> {
    const persistWorkspace = options.persistWorkspace ?? true;
    await Promise.all(
      Array.from(this.runtimes.keys()).map((id) =>
        this.closeRuntimeInternal(id, { persistWorkspace }),
      ),
    );
  }

  async registerProject(projectRoot: string): Promise<void> {
    const resolved = path.resolve(projectRoot);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
    const now = new Date().toISOString();
    const entry: DesktopProjectEntry = {
      name: path.basename(resolved) || resolved,
      root: resolved,
      slug: projectSlug(resolved),
      lastSeen: now,
      lastWorkingDir: resolved,
    };
    this.registeredProjects = await touchGlobalProjectManifest(entry);
    this.emitChanged();
  }

  async unregisterProject(projectRoot: string): Promise<void> {
    const resolved = path.resolve(projectRoot);
    this.registeredProjects = await removeGlobalProjectManifest(resolved);
    await this.saveDesktopState();
    this.emitChanged();
  }

  private async closeRuntimeInternal(
    id: string,
    options: { persistWorkspace: boolean },
  ): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    runtime.status = 'stopped';
    const child = runtime.child;
    runtime.child = null;
    await terminateProcessTree(child);
    if (runtime.logNotifyTimer) {
      clearTimeout(runtime.logNotifyTimer);
      runtime.logNotifyTimer = null;
    }
    this.runtimes.delete(id);
    if (this.activeRuntimeId === id) this.activeRuntimeId = firstRunningRuntimeId(this.runtimes);
    if (this.lastActiveProjectRoot && samePath(this.lastActiveProjectRoot, runtime.root)) {
      this.lastActiveProjectRoot = firstProjectRuntimeRoot(this.runtimes);
    }
    if (options.persistWorkspace) {
      await this.persistWorkspaceState();
    }
    this.emitChanged();
  }

  private async touchProject(projectRoot: string): Promise<void> {
    const resolved = path.resolve(projectRoot);
    const now = new Date().toISOString();
    const entry: DesktopProjectEntry = {
      name: path.basename(resolved) || resolved,
      root: resolved,
      slug: projectSlug(resolved),
      lastSeen: now,
      lastWorkingDir: resolved,
    };
    this.recentProjects = [
      entry,
      ...this.recentProjects.filter((p) => !samePath(p.root, resolved)),
    ].slice(0, 24);
    const [, registeredProjects] = await Promise.all([
      this.saveDesktopState(),
      touchGlobalProjectManifest(entry),
    ]);
    this.registeredProjects = registeredProjects;
  }

  private async persistWorkspaceState(): Promise<void> {
    await this.saveDesktopState();
  }

  private async loadDesktopState(): Promise<{
    recentProjects: DesktopProjectEntry[];
    openProjects: string[];
    openProjectSessions: DesktopProjectSessionState[];
    activeRuntimeId: string | null;
    activeProjectRoot: string | null;
    window: DesktopWindowState | null;
  }> {
    try {
      const raw = await fs.readFile(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw) as DesktopStateFile;
      const openProjects = normalizePathList(parsed.openProjects);
      const openProjectSessions = normalizeSessionStateList(
        parsed.openProjectSessions,
        openProjects,
      );
      return {
        recentProjects: normalizeProjectEntries(parsed.recentProjects),
        openProjects,
        openProjectSessions,
        activeRuntimeId: normalizeRuntimeId(parsed.activeRuntimeId) ?? null,
        activeProjectRoot:
          typeof parsed.activeProjectRoot === 'string' && parsed.activeProjectRoot.trim()
            ? path.resolve(parsed.activeProjectRoot)
            : null,
        window: normalizeWindowState(parsed.window),
      };
    } catch {
      return {
        recentProjects: [],
        openProjects: [],
        openProjectSessions: [],
        activeRuntimeId: null,
        activeProjectRoot: null,
        window: null,
      };
    }
  }

  private async saveDesktopState(): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    const liveProjectSessions = Array.from(this.runtimes.values())
      .filter((runtime) => runtime.status !== 'stopped' && runtime.kind === 'project')
      .map((runtime) => runtimeToSessionState(runtime));
    const openProjectSessions =
      liveProjectSessions.length === 0 && !this.workspaceRestoreCompleted
        ? [...this.restoreProjectSessions]
        : liveProjectSessions;
    const openProjects = openProjectSessions.map((session) => session.root);
    const activeRuntime = this.activeRuntimeId ? this.runtimes.get(this.activeRuntimeId) : null;
    const lastActiveProjectRoot = this.lastActiveProjectRoot;
    const fallbackSession =
      lastActiveProjectRoot
        ? openProjectSessions.find((session) => samePath(session.root, lastActiveProjectRoot))
        : undefined;
    const activeSession =
      activeRuntime?.kind === 'project'
        ? runtimeToSessionState(activeRuntime)
        : (fallbackSession ?? openProjectSessions[0]);
    const activeRoot = activeSession?.root;
    const activeRuntimeId = activeSession?.runtimeId ?? null;
    await atomicWrite(
      this.stateFile,
      `${JSON.stringify(
        {
          recentProjects: this.recentProjects,
          openProjects,
          openProjectSessions,
          activeRuntimeId,
          activeProjectRoot: activeRoot ?? null,
          window: this.windowState,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }

  private emitChanged(): void {
    this.emit('changed');
  }

  private scheduleLogChanged(runtime: RuntimeInternal): void {
    if (runtime.logNotifyTimer) return;
    runtime.logNotifyTimer = setTimeout(() => {
      runtime.logNotifyTimer = null;
      if (this.runtimes.get(runtime.id) === runtime) {
        this.emitChanged();
      }
    }, 250);
  }
}

async function terminateProcessTree(child: ChildProcess | null): Promise<void> {
  if (!child || child.killed || !child.pid) return;
  if (process.platform !== 'win32') {
    child.kill('SIGTERM');
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(finish, 3000);
    timer.unref?.();
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('exit', () => {
      clearTimeout(timer);
      finish();
    });
    killer.once('error', () => {
      clearTimeout(timer);
      child.kill();
      finish();
    });
  });
}

function publicRuntime(runtime: RuntimeInternal): DesktopRuntimeRecord {
  const {
    child: _child,
    token: _token,
    logs,
    logNotifyTimer: _logNotifyTimer,
    ...record
  } = runtime;
  void _child;
  void _token;
  void _logNotifyTimer;
  return {
    ...record,
    recentLogs: logs.slice(-40),
  };
}

function runtimeToSessionState(runtime: RuntimeInternal): DesktopProjectSessionState {
  return {
    runtimeId: runtime.id,
    name: runtime.name,
    root: runtime.root,
    startedAt: runtime.startedAt,
  };
}

function appendRuntimeLog(runtime: RuntimeInternal, stream: 'stdout' | 'stderr', text: string): void {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    runtime.logs.push(`[${stream}] ${line}`);
  }
  if (runtime.logs.length > 120) {
    runtime.logs.splice(0, runtime.logs.length - 120);
  }
}

function normalizePathList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const roots: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const resolved = path.resolve(item);
    roots.push(resolved);
  }
  return roots.slice(0, 12);
}

function normalizeSessionStateList(
  value: unknown,
  fallbackRoots: string[],
): DesktopProjectSessionState[] {
  if (!Array.isArray(value)) {
    return fallbackRoots.map((root) => ({ root })).slice(0, 12);
  }
  const sessions: DesktopProjectSessionState[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Partial<DesktopProjectSessionState>;
    if (typeof candidate.root !== 'string' || !candidate.root.trim()) continue;
    const session: DesktopProjectSessionState = {
      root: path.resolve(candidate.root),
    };
    const runtimeId = normalizeRuntimeId(candidate.runtimeId);
    if (runtimeId) session.runtimeId = runtimeId;
    if (typeof candidate.name === 'string' && candidate.name.trim()) {
      session.name = candidate.name.trim().slice(0, 120);
    }
    if (typeof candidate.startedAt === 'string' && candidate.startedAt.trim()) {
      session.startedAt = candidate.startedAt.trim();
    }
    sessions.push(session);
  }
  return sessions.slice(0, 12);
}

function normalizeRuntimeId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!/^[a-zA-Z0-9._:-]{3,120}$/.test(trimmed)) return undefined;
  return trimmed;
}

function normalizeWindowState(value: unknown): DesktopWindowState | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<DesktopWindowState>;
  const width = Number(candidate.width);
  const height = Number(candidate.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < MIN_WINDOW_WIDTH || height < MIN_WINDOW_HEIGHT) return null;
  const state: DesktopWindowState = {
    width: Math.round(width),
    height: Math.round(height),
    maximized: Boolean(candidate.maximized),
  };
  if (Number.isFinite(Number(candidate.x))) state.x = Math.round(Number(candidate.x));
  if (Number.isFinite(Number(candidate.y))) state.y = Math.round(Number(candidate.y));
  return state;
}

function firstRunningRuntimeId(runtimes: Map<string, RuntimeInternal>): string | null {
  return Array.from(runtimes.values()).find((runtime) => runtime.status === 'running')?.id ?? null;
}

function firstProjectRuntimeRoot(runtimes: Map<string, RuntimeInternal>): string | null {
  return (
    Array.from(runtimes.values()).find(
      (runtime) => runtime.status === 'running' && runtime.kind === 'project',
    )?.root ?? null
  );
}

function usedPorts(runtimes: Map<string, RuntimeInternal>): Set<number> {
  const ports = new Set<number>();
  for (const runtime of runtimes.values()) {
    ports.add(runtime.httpPort);
    ports.add(runtime.wsPort);
  }
  return ports;
}

function nextRuntimeName(
  runtimes: Map<string, RuntimeInternal>,
  root: string,
  kind: DesktopRuntimeKind,
): string {
  const baseName = path.basename(root) || root;
  if (kind !== 'project') return baseName;
  const liveSameRoot = Array.from(runtimes.values()).filter(
    (runtime) =>
      runtime.kind === 'project' &&
      samePath(runtime.root, root) &&
      runtime.status !== 'stopped',
  ).length;
  return liveSameRoot === 0 ? baseName : `${baseName} #${liveSameRoot + 1}`;
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return os.platform() === 'win32' ? resolved.toLowerCase() : resolved;
}

async function findFreePort(startPort: number, exclude: Set<number>): Promise<number> {
  for (let port = startPort; port < startPort + 200; port++) {
    if (exclude.has(port)) continue;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free local port found near ${startPort}`);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

function waitForHttpReady(baseUrl: string, token: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = new URL(baseUrl);
  url.searchParams.set('token', token);
  url.searchParams.set('shell', 'desktop');

  return new Promise((resolve, reject) => {
    const probe = (): void => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          resolve();
          return;
        }
        retry();
      });
      req.once('error', retry);
      req.setTimeout(1000, () => {
        req.destroy();
        retry();
      });
    };
    const retry = (): void => {
      if (Date.now() >= deadline) {
        reject(new Error(`WebUI did not become ready at ${baseUrl}`));
        return;
      }
      setTimeout(probe, 250);
    };
    probe();
  });
}

function resolveWebUiEntry(): string {
  if (process.env['WRONGSTACK_WEBUI_ENTRY']) {
    return path.resolve(process.env['WRONGSTACK_WEBUI_ENTRY']);
  }
  const require = createRequire(import.meta.url);
  // After PR #018b, the server entry lives in @wrongstack/webui-server.
  // Try the new package first; fall back to the legacy path for older builds
  // or when the new package is not yet built.
  try {
    const serverPkgPath = require.resolve('@wrongstack/webui-server/package.json');
    const candidate = path.join(path.dirname(serverPkgPath), 'dist', 'server', 'entry.js');
    if (existsSync(candidate)) return candidate;
  } catch {
    // fall through to legacy path
  }
  const serverIndex = require.resolve('@wrongstack/webui-server');
  return path.join(path.dirname(serverIndex), 'server', 'entry.js');
}

function resolveWebUiDistDir(): string {
  if (process.env['WRONGSTACK_WEBUI_DIST']) {
    return path.resolve(process.env['WRONGSTACK_WEBUI_DIST']);
  }
  const require = createRequire(import.meta.url);
  // The built React frontend assets live in @wrongstack/webui/dist.
  const serverEntry = require.resolve('@wrongstack/webui');
  const candidate = path.dirname(serverEntry);
  if (existsSync(candidate)) return candidate;
  throw new Error(
    `WebUI frontend assets not found at ${candidate}. Build @wrongstack/webui or set WRONGSTACK_WEBUI_DIST.`,
  );
}

async function readGlobalProjectManifest(): Promise<DesktopProjectEntry[]> {
  const manifestFile = path.join(wstackGlobalRoot(), 'projects.json');
  try {
    const raw = await fs.readFile(manifestFile, 'utf8');
    return normalizeProjectManifest(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

export function normalizeProjectManifest(value: unknown): DesktopProjectEntry[] {
  if (Array.isArray(value)) return normalizeProjectEntries(value).slice(0, 80);
  if (!value || typeof value !== 'object') return [];
  const manifest = value as { projects?: unknown; recentProjects?: unknown; recents?: unknown };
  const source = Array.isArray(manifest.projects)
    ? manifest.projects
    : Array.isArray(manifest.recentProjects)
      ? manifest.recentProjects
      : Array.isArray(manifest.recents)
        ? manifest.recents
        : [];
  return normalizeProjectEntries(source).slice(0, 80);
}

function normalizeProjectEntries(value: unknown): DesktopProjectEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const projects: DesktopProjectEntry[] = [];
  for (const item of value) {
    const project = normalizeProjectEntry(item);
    if (!project) continue;
    const key = pathKey(project.root);
    if (seen.has(key)) continue;
    seen.add(key);
    projects.push(project);
  }
  return projects.sort((a, b) =>
    (b.lastSeen ?? b.createdAt ?? '').localeCompare(a.lastSeen ?? a.createdAt ?? ''),
  );
}

function normalizeProjectEntry(value: unknown): DesktopProjectEntry | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<DesktopProjectEntry>;
  if (typeof candidate.root !== 'string' || !candidate.root.trim()) return null;
  const root = path.resolve(candidate.root);
  const name = typeof candidate.name === 'string' && candidate.name.trim()
    ? candidate.name.trim()
    : path.basename(root) || root;
  const entry: DesktopProjectEntry = {
    name,
    root,
    slug:
      typeof candidate.slug === 'string' && candidate.slug.trim()
        ? candidate.slug.trim()
        : projectSlug(root),
  };
  if (typeof candidate.lastSeen === 'string' && candidate.lastSeen.trim()) {
    entry.lastSeen = candidate.lastSeen.trim();
  }
  if (typeof candidate.createdAt === 'string' && candidate.createdAt.trim()) {
    entry.createdAt = candidate.createdAt.trim();
  }
  if (typeof candidate.lastWorkingDir === 'string' && candidate.lastWorkingDir.trim()) {
    entry.lastWorkingDir = path.resolve(candidate.lastWorkingDir);
  }
  return entry;
}

async function touchGlobalProjectManifest(entry: DesktopProjectEntry): Promise<DesktopProjectEntry[]> {
  const manifestFile = path.join(wstackGlobalRoot(), 'projects.json');
  const projects = await readGlobalProjectManifest();
  const existing = projects.find((p) => samePath(p.root, entry.root));
  if (existing) {
    existing.name = entry.name;
    existing.slug = entry.slug;
    existing.lastSeen = entry.lastSeen;
    existing.lastWorkingDir = entry.lastWorkingDir;
  } else {
    projects.push({ ...entry, createdAt: entry.lastSeen });
  }
  const sorted = projects
    .sort((a, b) => (b.lastSeen ?? b.createdAt ?? '').localeCompare(a.lastSeen ?? a.createdAt ?? ''))
    .slice(0, 80);
  await fs.mkdir(path.dirname(manifestFile), { recursive: true });
  await atomicWrite(manifestFile, `${JSON.stringify({ projects: sorted }, null, 2)}\n`, { mode: 0o600 });
  return sorted;
}

async function removeGlobalProjectManifest(projectRoot: string): Promise<DesktopProjectEntry[]> {
  const manifestFile = path.join(wstackGlobalRoot(), 'projects.json');
  const resolved = path.resolve(projectRoot);
  const projects = (await readGlobalProjectManifest()).filter(
    (project) => !samePath(project.root, resolved),
  );
  await fs.mkdir(path.dirname(manifestFile), { recursive: true });
  await atomicWrite(manifestFile, `${JSON.stringify({ projects }, null, 2)}\n`, { mode: 0o600 });
  return projects;
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return os.platform() === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function rendererIndexPath(): string {
  return fileURLToPath(new URL('../renderer/index.html', import.meta.url));
}

export function preloadPath(): string {
  return fileURLToPath(new URL('../preload/preload.cjs', import.meta.url));
}

export function webuiPreloadPath(): string {
  return fileURLToPath(new URL('../preload/webui-preload.cjs', import.meta.url));
}

/**
 * Filesystem root for the built-in "Global Settings" workspace.
 *
 * The desktop shell opens this directory as a `global-settings` runtime so the
 * user can edit provider/config state without an actual project checkout. It
 * lives under the WrongStack global root next to `desktop.json` and
 * `projects.json`.
 */
export function desktopSettingsWorkspaceRoot(): string {
  return path.join(wstackGlobalRoot(), 'settings');
}
