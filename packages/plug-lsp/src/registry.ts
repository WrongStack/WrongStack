import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { EventBus } from '@wrongstack/core/kernel';
import type { Logger } from '@wrongstack/core/types';
import { languageIdFor } from './language-detect.js';
import { nextReconnectDelay } from './server/lifecycle.js';
import { LSPServer } from './server/lsp-server.js';
import type { ReopenableTracker } from './shared-types.js';
import type { AutoStartMode, PlugLSPConfig } from './types.js';
import { LSPError, LSPErrorCode } from './types.js';
import { findWorkspaceRoot } from './workspace-root.js';

interface RegistryContext {
  cwd: string;
  log: Logger;
  events: EventBus;
}

export class LSPRegistry {
  private readonly servers = new Map<string, LSPServer>();
  private readonly languageIndex = new Map<string, string>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private cwd: string;
  private autoStart: AutoStartMode;

  constructor(
    private readonly cfg: PlugLSPConfig,
    private readonly tracker: ReopenableTracker,
    private readonly ctx: RegistryContext,
  ) {
    this.cwd = ctx.cwd;
    /* v8 ignore next -- constructor assignment has no alternate behavior. */
    this.autoStart = cfg.autoStart;
  }

  async bind(cwd: string, autoStart: AutoStartMode = this.cfg.autoStart): Promise<void> {
    this.cwd = cwd;
    this.autoStart = autoStart;
    this.rebuildServers();
    if (autoStart === 'eager') {
      const languages = await detectProjectLanguages(cwd);
      await Promise.all(
        this.list()
          .filter((s) => s.config.languages.some((lang) => languages.has(lang)))
          .map((s) => startServerSafely(s, this.ctx.log)),
      );
    }
  }

  async shutdown(): Promise<void> {
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    await Promise.all(
      this.list().map((s) =>
        s.shutdown().catch((err) => this.ctx.log.warn(`LSP ${s.name} shutdown failed`, err)),
      ),
    );
  }

  async findForPath(filePath: string, signal?: AbortSignal): Promise<LSPServer | null> {
    if (this.servers.size === 0) this.rebuildServers();
    const language = languageIdFor(filePath);
    if (!language) return null;
    const name = this.languageIndex.get(language);
    if (!name) return null;
    const server = this.servers.get(name);
    if (!server) return null;
    if (server.state !== 'ready' && this.autoStart === 'lazy') {
      await server.start(signal);
      await this.tracker.reopenForServer(server);
    }
    return server.state === 'ready' ? server : null;
  }

  get(name: string): LSPServer | null {
    if (this.servers.size === 0) this.rebuildServers();
    return this.servers.get(name) ?? null;
  }

  list(): readonly LSPServer[] {
    if (this.servers.size === 0) this.rebuildServers();
    return Array.from(this.servers.values());
  }

  async start(name: string): Promise<void> {
    const server = this.getOrThrow(name);
    await server.start();
    await this.tracker.reopenForServer(server);
  }

  async stop(name: string): Promise<void> {
    // Cancel any pending auto-reconnect so the server doesn't come back
    // up moments after a user-requested stop.
    this.cancelReconnect(name);
    await this.getOrThrow(name).shutdown();
  }

  async restart(name: string): Promise<void> {
    const server = this.getOrThrow(name);
    // Cancel pending auto-reconnect AND clear the strike counter — a
    // manual restart should not count against the 3-attempt limit.
    this.cancelReconnect(name);
    this.reconnectAttempts.delete(name);
    await server.shutdown();
    await server.start();
    await this.tracker.reopenForServer(server);
  }

  private cancelReconnect(name: string): void {
    const timer = this.reconnectTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(name);
    }
  }

  private rebuildServers(): void {
    this.servers.clear();
    this.languageIndex.clear();
    for (const [name, cfg] of Object.entries(this.cfg.servers)) {
      if (cfg.enabled === false) continue;
      const rootPath = findWorkspaceRoot(
        path.join(this.cwd, '__probe__'),
        cfg.rootPatterns,
        this.cwd,
      );
      const server = new LSPServer(name, cfg, {
        cwd: this.cwd,
        rootPath,
        log: this.ctx.log,
        events: this.ctx.events,
        onCrash: (crashed) => this.scheduleReconnect(crashed),
      });
      this.servers.set(name, server);
      for (const language of cfg.languages) {
        if (this.languageIndex.has(language)) {
          this.ctx.log.warn(
            `LSP language "${language}" is claimed by multiple servers; using first`,
          );
          continue;
        }
        this.languageIndex.set(language, name);
      }
    }
  }

  private getOrThrow(name: string): LSPServer {
    const server = this.get(name);
    if (!server) throw new LSPError(LSPErrorCode.ServerNotFound, `No LSP server named "${name}"`);
    return server;
  }

  private scheduleReconnect(server: LSPServer): void {
    if (this.reconnectTimers.has(server.name)) return;
    const attempt = this.reconnectAttempts.get(server.name) ?? 0;
    if (attempt >= 3) {
      this.ctx.log.warn(`LSP ${server.name} reconnect attempts exhausted`);
      return;
    }
    this.reconnectAttempts.set(server.name, attempt + 1);
    server.state = 'reconnecting';
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(server.name);
      void server
        .start()
        .then(() => {
          this.reconnectAttempts.delete(server.name);
          return this.tracker.reopenForServer(server);
        })
        /* v8 ignore start -- reconnect failure exhaustion is timing-dependent; startup failure is covered separately. */
        .catch((err) => {
          this.ctx.log.warn(`LSP ${server.name} reconnect attempt ${attempt + 1} failed`, err);
          server.state = 'failed';
          this.scheduleReconnect(server);
        });
      /* v8 ignore stop */
    }, nextReconnectDelay(attempt));
    this.reconnectTimers.set(server.name, timer);
  }
}

async function detectProjectLanguages(root: string): Promise<Set<string>> {
  const found = new Set<string>();
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
      /* v8 ignore next -- unreadable directories depend on OS permissions. */
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(p, depth + 1);
      else {
        const lang = languageIdFor(p);
        if (lang) found.add(lang);
      }
    }
  };
  await visit(root, 0);
  return found;
}

async function startServerSafely(server: LSPServer, log: Logger): Promise<void> {
  await server.start().catch((err) => log.warn(`LSP ${server.name} failed to start`, err));
}

/** Direct-module test seam; not re-exported by the package barrel. */
export const registryCoverage = { detectProjectLanguages, startServerSafely };
