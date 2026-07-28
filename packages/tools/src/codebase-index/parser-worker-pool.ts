import * as fs from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { isFrugalPerf } from '@wrongstack/core/utils';
import type { ParserWorkerRequest, ParserWorkerResponse } from './parser-worker-protocol.js';
import type { FileSymbols, SymbolLang } from './schema.js';

const MIN_WORKER_FILES = 512;
const MAX_PARSE_WORKERS = 4;
const MIN_WORKER_SYSTEM_MEMORY = 8 * 1024 * 1024 * 1024;

interface ParserTask {
  id: number;
  file: string;
  lang: SymbolLang;
  resolve: (parsed: FileSymbols) => void;
  reject: (error: Error) => void;
}

interface WorkerSlot {
  worker: Worker;
  task?: ParserTask | undefined;
}

export class ParserWorkerTaskError extends Error {
  constructor(
    readonly stage: 'read' | 'parse',
    message: string,
  ) {
    super(message);
    this.name = 'ParserWorkerTaskError';
  }
}

export function isWorkerParseLang(lang: string): lang is 'ts' | 'tsx' | 'js' | 'jsx' {
  return lang === 'ts' || lang === 'tsx' || lang === 'js' || lang === 'jsx';
}

export function resolveParserWorkerCount(fileCount: number): number {
  const configured = process.env.WRONGSTACK_INDEX_PARSE_WORKERS?.trim();
  if (configured) {
    const parsed = Number.parseInt(configured, 10);
    if (Number.isFinite(parsed)) return Math.max(0, Math.min(MAX_PARSE_WORKERS, parsed));
  }
  if (isFrugalPerf() || fileCount < MIN_WORKER_FILES || totalmem() < MIN_WORKER_SYSTEM_MEMORY) {
    return 0;
  }
  const cores = Math.max(1, availableParallelism());
  return Math.min(2, Math.max(0, cores - 1));
}

/**
 * Small, rebuild-scoped worker pool for the expensive TypeScript compiler AST
 * parser. Workers read files themselves so queued batches retain paths rather
 * than duplicate source strings in the project-server heap.
 */
export class ParserWorkerPool {
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: ParserTask[] = [];
  private nextId = 1;
  private closed = false;

  static create(fileCount: number): ParserWorkerPool | undefined {
    const workerCount = resolveParserWorkerCount(fileCount);
    if (workerCount === 0) return undefined;
    const workerUrl = new URL('./parser-worker.js', import.meta.url);
    if (workerUrl.protocol !== 'file:' || !fs.existsSync(fileURLToPath(workerUrl))) {
      return undefined;
    }
    return new ParserWorkerPool(workerCount, workerUrl);
  }

  constructor(
    private readonly workerCount: number,
    private readonly workerUrl: URL,
  ) {}

  parse(file: string, lang: SymbolLang): Promise<FileSymbols> {
    if (this.closed) return Promise.reject(new Error('parser worker pool is closed'));
    if (this.slots.length === 0) {
      for (let i = 0; i < this.workerCount; i++) this.spawn();
    }
    return new Promise<FileSymbols>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, file, lang, resolve, reject });
      this.pump();
    });
  }

  async close(reason = new Error('parser worker pool closed')): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const task of this.queue.splice(0)) task.reject(reason);
    const slots = this.slots.splice(0);
    for (const slot of slots) {
      slot.task?.reject(reason);
      slot.task = undefined;
    }
    await Promise.allSettled(slots.map((slot) => slot.worker.terminate()));
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private spawn(): void {
    const slot: WorkerSlot = {
      worker: new Worker(this.workerUrl, { name: 'wrongstack-index-parser' }),
    };
    this.slots.push(slot);
    slot.worker.on('message', (message: ParserWorkerResponse) => {
      const task = slot.task;
      if (!task || task.id !== message.id) return;
      slot.task = undefined;
      if (message.ok) task.resolve(message.parsed);
      else task.reject(new ParserWorkerTaskError(message.stage, message.error));
      this.pump();
    });
    slot.worker.on('error', (error) =>
      this.failSlot(slot, error instanceof Error ? error : new Error(String(error))),
    );
    slot.worker.on('exit', (code) => {
      if (!this.closed) {
        this.failSlot(slot, new Error(`parser worker exited with code ${code}`));
      }
    });
  }

  private failSlot(slot: WorkerSlot, error: Error): void {
    const index = this.slots.indexOf(slot);
    if (index < 0) return;
    this.slots.splice(index, 1);
    slot.task?.reject(error);
    slot.task = undefined;
    void slot.worker.terminate();
    if (!this.closed) {
      this.spawn();
      this.pump();
    }
  }

  private pump(): void {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (slot.task) continue;
      const task = this.queue.shift();
      if (!task) break;
      slot.task = task;
      const message: ParserWorkerRequest = { id: task.id, file: task.file, lang: task.lang };
      slot.worker.postMessage(message);
    }
  }
}
