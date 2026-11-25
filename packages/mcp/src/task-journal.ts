import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, withFileLock } from '@wrongstack/core/utils';
import { objectRecord } from './modern-protocol.js';
import { type MCPTaskOwner, sameTaskOwner } from './task-identity.js';
import { validateAnsweredInputs } from './task-input-state.js';
import { type MCPTask, parseTask } from './task-protocol.js';

export interface MCPTaskReceipt extends MCPTaskOwner {
  id: string;
  server: string;
  tool: string;
  binding: string;
  taskId: string;
  status: MCPTask['status'];
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number | undefined;
  answeredInputs: Record<string, string>;
  delivered: boolean;
  updatedAt: number;
  retryAfter?: number | undefined;
  /** Projection only: observer tokens never leave the journal. */
  leaseExpiresAt?: number | undefined;
}
interface Entry extends MCPTaskReceipt {
  lease?: { token: string; until: number } | undefined;
}
interface Journal {
  version: 1;
  entries: Entry[];
}
export const MCP_TASK_LEASE_MS = 90_000;
const MAX_BYTES = 1024 * 1024;

/** Durable metadata only. Every mutation holds the cross-process file lock. */
export class MCPTaskJournal {
  private readonly file: string;
  constructor(
    private readonly directory: string,
    private readonly changed?: () => void,
  ) {
    this.file = path.join(path.resolve(directory), 'journal.json');
  }
  private async read(): Promise<Journal> {
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES)
        throw new Error('Unsafe or oversized MCP task journal');
      const raw = await fs.readFile(this.file, 'utf8');
      if (Buffer.byteLength(raw) > MAX_BYTES)
        throw new Error('MCP task journal exceeds size limit');
      const parsed = objectRecord(JSON.parse(raw));
      if (
        parsed?.['version'] !== 1 ||
        !Array.isArray(parsed['entries']) ||
        parsed['entries'].length > 256
      )
        throw new Error('Invalid MCP task journal');
      const entries = parsed['entries'].map(parseEntry);
      if (
        new Set(entries.map((e) => e.id)).size !== entries.length ||
        new Set(entries.map((e) => JSON.stringify([e.binding, e.taskId]))).size !== entries.length
      )
        throw new Error('Duplicate MCP task receipts');
      return { version: 1, entries };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entries: [] };
      throw error;
    }
  }
  private async locked<T>(write: boolean, run: (journal: Journal) => T | Promise<T>): Promise<T> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Unsafe MCP task journal directory');
    const result = await withFileLock(this.file, async () => {
      const journal = await this.read(),
        result = await run(journal);
      if (write) {
        const text = JSON.stringify(journal) + '\n';
        if (Buffer.byteLength(text) > MAX_BYTES)
          throw new Error('MCP task journal exceeds size limit');
        await atomicWrite(this.file, text, { mode: 0o600 });
      }
      return structuredClone(result);
    });
    if (write) {
      try {
        this.changed?.();
      } catch {
        /* Observation is best effort. */
      }
    }
    return result;
  }
  async list(owner: MCPTaskOwner): Promise<MCPTaskReceipt[]> {
    return this.locked(false, (j) =>
      j.entries.filter((e) => sameTaskOwner(owner, e)).map(publicReceipt),
    );
  }
  async create(
    owner: MCPTaskOwner,
    server: string,
    tool: string,
    binding: string,
    task: MCPTask,
    token: string,
  ): Promise<MCPTaskReceipt> {
    return this.locked(true, (j) => {
      const prior = j.entries.find((e) => e.binding === binding && e.taskId === task.taskId);
      if (prior) {
        if (
          !sameTaskOwner(owner, prior) ||
          (prior.lease && prior.lease.until > Date.now() && prior.lease.token !== token)
        )
          throw new Error('MCP task already belongs to another observer');
        prior.lease = { token, until: Date.now() + MCP_TASK_LEASE_MS };
        return publicReceipt(prior);
      }
      if (j.entries.length >= 256) {
        const oldest = j.entries
          .filter((e) => e.delivered && (!e.lease || e.lease.until <= Date.now()))
          .sort((a, b) => a.updatedAt - b.updatedAt)[0];
        if (!oldest) throw new Error('MCP task journal has 256 uncollected receipts');
        j.entries.splice(j.entries.indexOf(oldest), 1);
      }
      const entry: Entry = {
        id: randomUUID(),
        ...owner,
        server,
        tool,
        binding,
        ...metadata(task),
        answeredInputs: {},
        delivered: false,
        updatedAt: Date.now(),
        lease: { token, until: Date.now() + MCP_TASK_LEASE_MS },
      };
      parseEntry(entry);
      j.entries.push(entry);
      return publicReceipt(entry);
    });
  }
  async claim(
    id: string,
    owner: MCPTaskOwner,
    binding: string,
    token: string,
  ): Promise<MCPTaskReceipt | undefined> {
    return this.locked(true, (j) => {
      const e = j.entries.find(
        (item) => item.id === id && item.binding === binding && sameTaskOwner(owner, item),
      );
      if (!e || e.delivered || (e.lease && e.lease.until > Date.now() && e.lease.token !== token))
        return undefined;
      e.lease = { token, until: Date.now() + MCP_TASK_LEASE_MS };
      return publicReceipt(e);
    });
  }
  async update(
    id: string,
    token: string,
    patch: {
      task?: MCPTask;
      answeredInputs?: Record<string, string>;
      delivered?: boolean;
      retryAfter?: number;
    } = {},
  ): Promise<void> {
    await this.locked(true, (j) => {
      const e = j.entries.find((item) => item.id === id);
      if (!e?.lease || e.lease.token !== token || e.lease.until <= Date.now())
        throw new Error('MCP task observer lease lost');
      if (patch.task) {
        if (patch.task.taskId !== e.taskId || patch.task.createdAt !== e.createdAt)
          throw new Error('MCP task identity changed');
        Object.assign(e, metadata(patch.task));
      }
      if (patch.answeredInputs)
        e.answeredInputs = validateAnsweredInputs({ ...e.answeredInputs, ...patch.answeredInputs });
      if (patch.delivered !== undefined) e.delivered = patch.delivered;
      if (patch.retryAfter !== undefined) e.retryAfter = patch.retryAfter;
      e.updatedAt = Date.now();
      e.lease.until = Date.now() + MCP_TASK_LEASE_MS;
      parseEntry(e);
    });
  }
  async release(id: string, token: string): Promise<void> {
    await this.locked(true, (j) => {
      const e = j.entries.find((item) => item.id === id);
      if (e?.lease?.token === token) delete e.lease;
    });
  }
}
function metadata(task: MCPTask) {
  return {
    taskId: task.taskId,
    status: task.status,
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: task.ttlMs,
    ...(task.pollIntervalMs === undefined ? {} : { pollIntervalMs: task.pollIntervalMs }),
  };
}
function publicReceipt({ lease, ...receipt }: Entry): MCPTaskReceipt {
  return { ...receipt, ...(lease ? { leaseExpiresAt: lease.until } : {}) };
}
function parseEntry(value: unknown): Entry {
  const e = objectRecord(value);
  const string = (key: string, max: number) => {
    const v = e?.[key];
    if (typeof v !== 'string' || !v || v.length > max || /[\x00-\x1f\x7f]/.test(v))
      throw new Error('Malformed MCP task receipt');
    return v;
  };
  const id = string('id', 64),
    binding = string('binding', 64);
  if (
    !/^[a-f0-9-]{36}$/.test(id) ||
    !/^[a-f0-9]{64}$/.test(binding) ||
    typeof e?.['delivered'] !== 'boolean' ||
    !Number.isSafeInteger(e['updatedAt'])
  )
    throw new Error('Malformed MCP task receipt identity');
  const task = parseTask(e),
    lease = objectRecord(e['lease']);
  if (e['retryAfter'] !== undefined && !Number.isSafeInteger(e['retryAfter']))
    throw new Error('Malformed MCP task retry time');
  if (
    e['lease'] !== undefined &&
    (!lease ||
      typeof lease['token'] !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(lease['token']) ||
      !Number.isSafeInteger(lease['until']))
  )
    throw new Error('Malformed MCP task observer lease');
  return {
    id,
    binding,
    sessionId: string('sessionId', 256),
    agentId: string('agentId', 256),
    server: string('server', 256),
    tool: string('tool', 1024),
    ...metadata(task),
    delivered: e['delivered'] as boolean,
    updatedAt: e['updatedAt'] as number,
    answeredInputs: validateAnsweredInputs(e['answeredInputs']),
    ...(e['retryAfter'] === undefined ? {} : { retryAfter: e['retryAfter'] as number }),
    ...(lease
      ? { lease: { token: lease['token'] as string, until: lease['until'] as number } }
      : {}),
  };
}
