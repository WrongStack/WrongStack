import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentEntry, SessionRegistryEntry } from '../session-registry-types.js';
import { SessionCatalogProjectClient } from './client.js';
import { sessionCatalogProjectServerMetadataPath } from './endpoint.js';
import type { ResumeReservation, SessionCatalogEvent, SessionLeaseCredential } from './protocol.js';

const HEARTBEAT_INTERVAL_MS = 5_000;
const AGENT_WRITE_THROTTLE_MS = 300;
const MAX_PROJECT_CLIENTS = 128;
const MAX_GLOBAL_ROOTS = 16;

interface ProjectBinding {
  projectDir: string;
  projectRoot: string;
  client: SessionCatalogProjectClient;
}

export interface SessionResumeClaim {
  reservation: ResumeReservation;
  activate(entry: SessionRegistryRegistration): Promise<void>;
  cancel(): Promise<void>;
}

export type SessionRegistryRegistration = Omit<
  SessionRegistryEntry,
  'status' | 'lastHeartbeatAt' | 'agentCount' | 'agents'
> & { agents?: AgentEntry[] | undefined };

/**
 * Compatibility facade for the project-scoped Session Catalog service.
 *
 * It deliberately preserves the former SessionRegistry method names so first-
 * party surfaces can cut over without retaining the device-global JSON file as
 * a second ownership authority.
 */
export class ProjectSessionRegistry {
  private readonly instanceId = randomUUID();
  private readonly clients = new Map<string, ProjectBinding>();
  private current:
    | { binding: ProjectBinding; credential: SessionLeaseCredential; entry: SessionRegistryEntry }
    | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private agentRevision = 0;
  private pendingAgents: AgentEntry[] | undefined;
  private agentTimer: ReturnType<typeof setTimeout> | undefined;
  private lastAgentWriteAt = 0;

  constructor(private readonly globalRoot: string) {}

  private binding(projectSlug: string, projectRoot: string): ProjectBinding {
    const projectDir = path.join(this.globalRoot, 'projects', projectSlug);
    const key = process.platform === 'win32' ? projectDir.toLowerCase() : projectDir;
    let binding = this.clients.get(key);
    if (!binding) {
      if (this.clients.size >= MAX_PROJECT_CLIENTS) {
        const oldest = [...this.clients.entries()].find(
          ([, candidate]) => candidate !== this.current?.binding,
        );
        if (oldest) {
          this.clients.delete(oldest[0]);
          void oldest[1].client.close();
        }
      }
      binding = {
        projectDir,
        projectRoot: path.resolve(projectRoot),
        client: new SessionCatalogProjectClient({ projectDir, projectRoot }),
      };
      this.clients.set(key, binding);
    } else {
      this.clients.delete(key);
      this.clients.set(key, binding);
    }
    return binding;
  }

  private fullEntry(entry: SessionRegistryRegistration): SessionRegistryEntry {
    const agents = entry.agents ?? [];
    return {
      ...entry,
      status: agents.some((agent) => agent.status !== 'idle') ? 'active' : 'idle',
      lastHeartbeatAt: new Date().toISOString(),
      agentCount: agents.length,
      agents,
    };
  }

  async register(entry: SessionRegistryRegistration): Promise<void> {
    const full = this.fullEntry(entry);
    if (this.current?.entry.sessionId === full.sessionId && this.current.entry.pid === full.pid) {
      this.current.entry = full;
      this.current.credential = await this.current.binding.client.call('heartbeat', {
        credential: this.current.credential,
        status: full.status,
      });
      return;
    }
    const nextBinding = this.binding(full.projectSlug, full.projectRoot);
    const nextCredential = await nextBinding.client.call('claim_new', {
      entry: full,
      ownerInstanceId: this.instanceId,
    });
    const previous = this.current;
    this.current = { binding: nextBinding, credential: nextCredential, entry: full };
    this.agentRevision = 0;
    this.cancelAgentTimer();
    this.startHeartbeat();
    if (previous)
      await previous.binding.client
        .call('release', { credential: previous.credential })
        .catch(() => undefined);
  }

  /** Reserve before transcript hydration; activation swaps ownership only after the writer opened. */
  async reserveResume(target: {
    sessionId: string;
    projectSlug: string;
    projectRoot: string;
  }): Promise<SessionResumeClaim> {
    const binding = this.binding(target.projectSlug, target.projectRoot);
    const reservation = await binding.client.call('reserve_resume', {
      targetSessionId: target.sessionId,
      requesterInstanceId: this.instanceId,
      ...(this.current ? { currentSessionId: this.current.entry.sessionId } : {}),
    });
    let settled = false;
    return {
      reservation,
      activate: async (registration) => {
        if (settled) throw new Error('Resume reservation is already settled');
        const entry = this.fullEntry(registration);
        const credential = await binding.client.call('activate_reservation', {
          reservation,
          entry,
        });
        const previous = this.current;
        this.current = { binding, credential, entry };
        settled = true;
        this.agentRevision = 0;
        this.cancelAgentTimer();
        this.startHeartbeat();
        if (previous)
          await previous.binding.client
            .call('release', { credential: previous.credential })
            .catch(() => undefined);
      },
      cancel: async () => {
        if (settled) return;
        settled = true;
        await binding.client
          .call('cancel_reservation', {
            reservationId: reservation.reservationId,
            requesterInstanceId: this.instanceId,
          })
          .catch(() => undefined);
      },
    };
  }

  async updateAgents(agents: AgentEntry[]): Promise<void> {
    if (!this.current) return;
    this.pendingAgents = agents;
    this.current.entry = {
      ...this.current.entry,
      agents,
      agentCount: agents.length,
      status: agents.some((agent) => agent.status !== 'idle') ? 'active' : 'idle',
      lastHeartbeatAt: new Date().toISOString(),
    };
    const elapsed = Date.now() - this.lastAgentWriteAt;
    if (!this.agentTimer && elapsed >= AGENT_WRITE_THROTTLE_MS) {
      await this.flushAgents();
      return;
    }
    if (!this.agentTimer) {
      this.agentTimer = setTimeout(
        () => {
          this.agentTimer = undefined;
          void this.flushAgents();
        },
        Math.max(0, AGENT_WRITE_THROTTLE_MS - elapsed),
      );
      this.agentTimer.unref?.();
    }
  }

  private async flushAgents(): Promise<void> {
    const agents = this.pendingAgents;
    const current = this.current;
    if (!agents || !current) return;
    this.pendingAgents = undefined;
    this.lastAgentWriteAt = Date.now();
    const revision = ++this.agentRevision;
    await current.binding.client.call('publish_agents', {
      credential: current.credential,
      revision,
      agents,
    });
  }

  async markClosing(): Promise<void> {
    this.stopHeartbeat();
    this.cancelAgentTimer();
    if (this.current)
      await this.current.binding.client.call('mark_closing', {
        credential: this.current.credential,
      });
  }

  async unregister(): Promise<void> {
    this.stopHeartbeat();
    this.cancelAgentTimer();
    const current = this.current;
    this.current = undefined;
    if (current) await current.binding.client.call('release', { credential: current.credential });
  }

  async list(): Promise<SessionRegistryEntry[]> {
    const projectsDir = path.join(this.globalRoot, 'projects');
    let directories: string[] = [];
    try {
      directories = (await fs.readdir(projectsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .slice(0, 1_000)
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    const snapshots = await Promise.all(
      directories.map(async (slug) => {
        const projectDir = path.join(projectsDir, slug);
        try {
          const metadata = JSON.parse(
            await fs.readFile(sessionCatalogProjectServerMetadataPath(projectDir), 'utf8'),
          ) as { projectRoot?: unknown };
          if (typeof metadata.projectRoot !== 'string' || !metadata.projectRoot) return [];
          return await this.binding(slug, metadata.projectRoot).client.call('list_live', {});
        } catch {
          return [];
        }
      }),
    );
    return snapshots.flat();
  }

  async listByProject(projectSlug: string): Promise<SessionRegistryEntry[]> {
    const existing = [...this.clients.values()].find(
      (binding) => path.basename(binding.projectDir) === projectSlug,
    );
    if (existing) return existing.client.call('list_live', {}).catch(() => []);
    const projectDir = path.join(this.globalRoot, 'projects', projectSlug);
    try {
      const metadata = JSON.parse(
        await fs.readFile(sessionCatalogProjectServerMetadataPath(projectDir), 'utf8'),
      ) as { projectRoot?: unknown };
      if (typeof metadata.projectRoot !== 'string') return [];
      return this.binding(projectSlug, metadata.projectRoot)
        .client.call('list_live', {})
        .catch(() => []);
    } catch {
      return [];
    }
  }

  async get(sessionId: string): Promise<SessionRegistryEntry | undefined> {
    return (await this.list()).find((entry) => entry.sessionId === sessionId);
  }

  subscribeProject(
    projectSlug: string,
    projectRoot: string,
    listener: (event: SessionCatalogEvent) => void,
  ): Promise<() => Promise<void>> {
    return this.binding(projectSlug, projectRoot).client.subscribe(listener);
  }

  get registryPath(): string {
    return path.join(this.globalRoot, 'projects');
  }

  async dispose(): Promise<void> {
    await this.unregister().catch(() => undefined);
    await Promise.all([...this.clients.values()].map((binding) => binding.client.close()));
    this.clients.clear();
  }

  /** Whether this facade currently owns a live session lease. */
  ownsSession(): boolean {
    return this.current !== undefined;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }
  private cancelAgentTimer(): void {
    if (this.agentTimer) clearTimeout(this.agentTimer);
    this.agentTimer = undefined;
    this.pendingAgents = undefined;
  }

  private async heartbeat(): Promise<void> {
    const current = this.current;
    if (!current) return;
    try {
      const credential = await current.binding.client.call('heartbeat', {
        credential: current.credential,
        status: current.entry.status,
      });
      if (this.current === current) current.credential = credential;
    } catch {
      /* active writer continues; next heartbeat retries reconnect */
    }
  }
}

const registries = new Map<string, ProjectSessionRegistry>();
let lastRegistryKey: string | undefined;

export function getProjectSessionRegistry(globalRoot?: string): ProjectSessionRegistry {
  const key = globalRoot !== undefined ? path.resolve(globalRoot) : lastRegistryKey;
  if (!key)
    throw new Error('SessionRegistry not initialized. Call getSessionRegistry(globalRoot) first.');
  let registry = registries.get(key);
  if (!registry) {
    if (registries.size >= MAX_GLOBAL_ROOTS) {
      // Read-only HQ/WebUI roots are cached for IPC reuse. Evict the oldest
      // facade that does not own a lease; an active session is never displaced.
      const idle = [...registries.entries()].find(([, candidate]) => !candidate.ownsSession());
      if (!idle)
        throw new Error(`Session Registry global-root limit reached (${MAX_GLOBAL_ROOTS})`);
      registries.delete(idle[0]);
      void idle[1].dispose();
    }
    registry = new ProjectSessionRegistry(key);
    registries.set(key, registry);
  } else {
    // Maintain insertion order as a small LRU for safe idle eviction.
    registries.delete(key);
    registries.set(key, registry);
  }
  lastRegistryKey = key;
  return registry;
}

export function hasProjectSessionRegistry(globalRoot?: string): boolean {
  if (globalRoot === undefined) return registries.size > 0;
  return registries.has(path.resolve(globalRoot));
}
