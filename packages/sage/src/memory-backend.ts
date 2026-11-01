/**
 * `Sage.service` backend selection.
 *
 * - `local` (default): the project SAGE server / inline SQLite port — unchanged.
 * - `wrongmemory`: one {@link WrongMemoryPort}; registers or locates the project
 *   via `project.register`/`project.list` and never constructs a SQLite store.
 * - `auto`: WrongMemory only when a daemon is reachable (never started by the
 *   probe) AND the project root is already registered; otherwise `local`.
 *   The choice is made once, in `initialize()`.
 */
import type {
  MemoryCapability,
  MemoryEntry,
  MemoryHealth,
  MemoryPort,
  MemoryRelevanceContext,
  MemoryScope,
  ScoredEntry,
} from '@wrongstack/contracts/types';
import type { ConnectOptions } from '@wrongstack/wrongmemory-client';
import { createProjectSageMemoryPort } from './memory-port.js';
import type { ProjectSageMemoryPortOptions } from './remote-memory-port.js';
import {
  probeWrongMemoryProject,
  type WrongMemoryClientLike,
  WrongMemoryNotImplementedError,
  WrongMemoryPort,
} from './wrongmemory-port.js';

export type SageServiceMode = 'local' | 'wrongmemory' | 'auto';

export interface SageServiceSelection {
  mode?: SageServiceMode | undefined;
  startPolicy?: 'on-demand' | 'never' | undefined;
  projectId?: string | undefined;
  dataRoot?: string | undefined;
  daemonPath?: string | undefined;
}

export interface SageMemoryPortForServiceOptions extends ProjectSageMemoryPortOptions {
  service?: SageServiceSelection | undefined;
  /** Local backend factory (tests). Defaults to {@link createProjectSageMemoryPort}. */
  createLocal?: ((options: ProjectSageMemoryPortOptions) => MemoryPort) | undefined;
  /** WrongMemory connection factory (tests). */
  connect?: ((options: ConnectOptions) => Promise<WrongMemoryClientLike>) | undefined;
}

export function resolveSageServiceMode(service: SageServiceSelection | undefined): SageServiceMode {
  const mode = service?.mode;
  return mode === 'wrongmemory' || mode === 'auto' ? mode : 'local';
}

function wrongMemoryPort(
  options: SageMemoryPortForServiceOptions,
  overrides: { projectId?: string | undefined; register?: boolean } = {},
): WrongMemoryPort {
  const service = options.service ?? {};
  return new WrongMemoryPort({
    projectRoot: options.projectRoot,
    projectId: overrides.projectId ?? service.projectId,
    dataRoot: service.dataRoot,
    daemonPath: service.daemonPath,
    startPolicy: service.startPolicy ?? 'on-demand',
    register: overrides.register ?? true,
    getSessionId: options.getSessionId,
    connect: options.connect,
  });
}

/** Build the host memory port for the configured `Sage.service` mode. */
export function createSageMemoryPortForService(
  options: SageMemoryPortForServiceOptions,
): MemoryPort {
  const { service: _service, createLocal, connect: _connect, ...localOptions } = options;
  const local = createLocal ?? createProjectSageMemoryPort;
  switch (resolveSageServiceMode(options.service)) {
    case 'wrongmemory':
      return wrongMemoryPort(options);
    case 'auto':
      return new AutoSageMemoryPort(options, () => local(localOptions));
    case 'local':
      return local(localOptions);
  }
}

/** Raised when an `auto` port is used before `initialize()` picked a backend. */
export class SageBackendNotSelectedError extends Error {
  readonly code = 'SAGE_BACKEND_NOT_SELECTED' as const;
  constructor() {
    super('SAGE_BACKEND_NOT_SELECTED: call initialize() before using the auto memory port');
    this.name = 'SageBackendNotSelectedError';
  }
}

/** `auto` mode: picks WrongMemory or local once, in `initialize()`, then delegates. */
export class AutoSageMemoryPort implements MemoryPort {
  private delegate: MemoryPort | undefined;
  private selecting: Promise<MemoryPort> | undefined;
  private backend: 'wrongmemory' | 'local' | undefined;

  constructor(
    private readonly options: SageMemoryPortForServiceOptions,
    private readonly createLocal: () => MemoryPort,
  ) {}

  /** `undefined` until `initialize()` resolved. */
  getSelectedBackend(): 'wrongmemory' | 'local' | undefined {
    return this.backend;
  }

  async initialize(): Promise<void> {
    this.selecting ??= this.select();
    await this.selecting;
  }

  private async select(): Promise<MemoryPort> {
    const service = this.options.service ?? {};
    const project = await probeWrongMemoryProject({
      projectRoot: this.options.projectRoot,
      projectId: service.projectId,
      dataRoot: service.dataRoot,
      connect: this.options.connect,
    });
    let port: MemoryPort;
    if (project) {
      port = wrongMemoryPort(this.options, { projectId: project.projectId, register: false });
      this.backend = 'wrongmemory';
    } else {
      port = this.createLocal();
      this.backend = 'local';
    }
    await port.initialize();
    this.delegate = port;
    return port;
  }

  private active(): MemoryPort {
    if (!this.delegate) throw new SageBackendNotSelectedError();
    return this.delegate;
  }

  getCapability<T>(capability: MemoryCapability<T>): T | undefined {
    return this.active().getCapability(capability);
  }

  async health(): Promise<MemoryHealth> {
    if (!this.delegate) {
      return { status: 'unavailable', backend: 'auto', details: { error: 'backend not selected' } };
    }
    return this.delegate.health();
  }

  async dispose(): Promise<void> {
    await this.delegate?.dispose();
  }

  withTraceId(traceId: string): this {
    this.active().withTraceId(traceId);
    return this;
  }

  getBackend(): unknown {
    return this.delegate?.getBackend?.() ?? { kind: 'auto', selected: this.backend };
  }

  readAll(): Promise<string> {
    return this.active().readAll();
  }
  read(scope: MemoryScope): Promise<string> {
    return this.active().read(scope);
  }
  remember(
    text: string,
    scope?: MemoryScope,
    metadata?: Omit<Partial<MemoryEntry>, 'scope' | 'text' | 'ts'>,
  ): Promise<void> {
    return this.active().remember(text, scope, metadata);
  }
  forget(query: string, scope?: MemoryScope): Promise<number> {
    return this.active().forget(query, scope);
  }
  consolidate(scope: MemoryScope): Promise<void> {
    return this.active().consolidate(scope);
  }
  clear(scope?: MemoryScope): Promise<void> {
    return this.active().clear(scope);
  }
  list(scope?: MemoryScope, limit?: number): Promise<MemoryEntry[]> {
    return this.active().list(scope, limit);
  }
  search(query: string, scope?: MemoryScope, limit?: number): Promise<MemoryEntry[]> {
    return this.active().search(query, scope, limit);
  }
  findRelated(text: string, scope?: MemoryScope, limit?: number): Promise<MemoryEntry[]> {
    const port = this.active();
    if (!port.findRelated) return Promise.reject(new WrongMemoryNotImplementedError('findRelated'));
    return port.findRelated(text, scope, limit);
  }
  scoreRelevant(
    context: MemoryRelevanceContext,
    scope?: MemoryScope,
    limit?: number,
  ): Promise<ScoredEntry[]> {
    const port = this.active();
    if (!port.scoreRelevant) {
      return Promise.reject(new WrongMemoryNotImplementedError('scoreRelevant'));
    }
    return port.scoreRelevant(context, scope, limit);
  }
  hygiene(options?: Parameters<NonNullable<MemoryPort['hygiene']>>[0]): Promise<unknown> {
    const port = this.active();
    if (!port.hygiene) return Promise.reject(new WrongMemoryNotImplementedError('hygiene'));
    return port.hygiene(options);
  }
}
