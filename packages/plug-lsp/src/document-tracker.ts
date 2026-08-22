import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { EventBus, EventMap } from '@wrongstack/core/kernel';
import type { Logger } from '@wrongstack/core/types';
import type { TextDocumentItem } from 'vscode-languageserver-protocol';
import { languageIdFor } from './language-detect.js';
import type { LSPServer } from './server/lsp-server.js';
import type { ServerLister } from './shared-types.js';
import type { TrackedDocument } from './types.js';
import { pathToUri } from './utils/uri.js';

/**
 * A single file larger than this is not tracked. Language servers do not give
 * useful diagnostics on generated bundles or lockfiles, and one `read` of such
 * a file used to pin its entire contents for the life of the process.
 */
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

/** Total live document text held by the tracker. */
const MAX_TRACKED_BYTES = 32 * 1024 * 1024;

/** Hard cap on tracked documents, independent of their size. */
const MAX_TRACKED_DOCS = 200;

export class DocumentTracker {
  private readonly docs = new Map<string, TrackedDocument>();
  /**
   * LRU bookkeeping kept beside `docs` so the shared `TrackedDocument` shape
   * stays untouched. `docs` previously only ever grew — the sole removal was
   * `forceCloseAll()` — so every file ever read or written stayed resident in
   * full for the whole session.
   */
  private readonly lastUsed = new Map<string, number>();
  private clock = 0;
  private trackedBytes = 0;
  private cwd: string;

  constructor(
    private readonly registry: () => ServerLister,
    private readonly log: Logger,
    cwd: string,
    private readonly events?: EventBus | undefined,
  ) {
    this.cwd = cwd;
  }

  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  async handleToolExecuted(event: EventMap['tool.executed']): Promise<void> {
    if (!event.ok) return;
    if (event.name !== 'read' && event.name !== 'edit' && event.name !== 'write') return;
    const input = event.input as { path?: unknown | undefined } | undefined;
    if (!input || typeof input.path !== 'string') return;
    const absPath = this.resolve(input.path);
    if (event.name === 'read') await this.open(absPath);
    else await this.fileWritten(absPath);
  }

  /**
   * Read a file for tracking, refusing anything over {@link MAX_DOCUMENT_BYTES}.
   * The `stat` comes first so an oversized file is never materialized at all.
   */
  private async readTrackable(absPath: string, label: string): Promise<string | null> {
    try {
      const stat = await fs.stat(absPath);
      if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES) return null;
      return await fs.readFile(absPath, 'utf8');
    } catch (err) {
      this.log.debug(`LSP tracker could not read ${label} ${absPath}`, err);
      return null;
    }
  }

  async fileWritten(filePath: string): Promise<void> {
    const absPath = this.resolve(filePath);
    const languageId = languageIdFor(absPath);
    if (!languageId) return;
    const text = await this.readTrackable(absPath, 'changed file');
    if (text === null) return;
    const doc = this.docs.get(absPath);
    if (!doc) {
      await this.open(absPath, text);
      return;
    }
    doc.version++;
    this.accountText(doc.text, text);
    doc.text = text;
    this.touch(absPath);
    for (const server of this.registry().list()) {
      /* v8 ignore next -- false branch is defensive for mixed registries. */
      if (server.state !== 'ready' || !server.config.languages.includes(languageId)) continue;
      server.notifyDidChange({ uri: doc.uri, version: doc.version }, text);
      doc.serverNames.add(server.name);
    }
    this.enforceBudget();
  }

  async open(filePath: string, knownText?: string): Promise<void> {
    const absPath = this.resolve(filePath);
    const languageId = languageIdFor(absPath);
    if (!languageId) return;
    let text: string;
    if (knownText !== undefined) {
      // A caller-supplied body still counts against the per-document cap.
      if (knownText.length > MAX_DOCUMENT_BYTES) return;
      text = knownText;
    } else {
      const read = await this.readTrackable(absPath, 'file');
      if (read === null) return;
      text = read;
    }
    let doc = this.docs.get(absPath);
    /* v8 ignore next -- both create and existing paths are covered; branch accounting is source-map noisy. */
    if (!doc) {
      doc = {
        uri: pathToUri(absPath),
        path: absPath,
        languageId,
        version: 1,
        text,
        serverNames: new Set(),
      };
      this.docs.set(absPath, doc);
      this.accountText(undefined, text);
      this.events?.emit('lsp.document.opened', { path: absPath, language: languageId });
    } else if (knownText !== undefined && knownText !== doc.text) {
      doc.version++;
      this.accountText(doc.text, knownText);
      doc.text = knownText;
      for (const server of this.registry().list()) {
        if (server.state !== 'ready' || !server.config.languages.includes(languageId)) continue;
        if (!doc.serverNames.has(server.name)) continue;
        server.notifyDidChange({ uri: doc.uri, version: doc.version }, knownText);
      }
    }
    this.touch(absPath);
    for (const server of this.registry().list()) {
      if (server.state !== 'ready' || !server.config.languages.includes(languageId)) continue;
      /* v8 ignore next -- duplicate-open guard is defensive/idempotent. */
      if (doc.serverNames.has(server.name)) continue;
      server.notifyDidOpen(toTextDocumentItem(doc));
      doc.serverNames.add(server.name);
    }
    this.enforceBudget();
  }

  async reopenForServer(server: LSPServer): Promise<void> {
    /* v8 ignore next -- non-ready guard is covered but branch accounting is source-map noisy. */
    if (server.state !== 'ready') return;
    for (const doc of this.docs.values()) {
      /* v8 ignore next -- mixed-language registries are covered elsewhere. */
      if (!server.config.languages.includes(doc.languageId)) continue;
      server.notifyDidOpen(toTextDocumentItem(doc));
      doc.serverNames.add(server.name);
    }
  }

  async forceCloseAll(): Promise<void> {
    for (const doc of this.docs.values()) {
      for (const server of this.registry().list()) {
        /* v8 ignore next -- close only applies to ready servers that saw the doc. */
        if (server.state === 'ready' && doc.serverNames.has(server.name)) {
          server.notifyDidClose(doc.uri);
          this.events?.emit('lsp.document.closed', { path: doc.path });
        }
      }
    }
    this.docs.clear();
    this.lastUsed.clear();
    this.trackedBytes = 0;
  }

  /** Record a document as most-recently-used. */
  private touch(absPath: string): void {
    this.lastUsed.set(absPath, ++this.clock);
  }

  /** Adjust the running byte total when a document's text is replaced. */
  private accountText(previous: string | undefined, next: string | undefined): void {
    this.trackedBytes -= previous?.length ?? 0;
    this.trackedBytes += next?.length ?? 0;
  }

  /** Close and forget one document, keeping servers in sync. */
  private evict(absPath: string): void {
    const doc = this.docs.get(absPath);
    /* v8 ignore next -- eviction order is derived directly from docs.keys(). */
    if (!doc) return;
    for (const server of this.registry().list()) {
      if (server.state === 'ready' && doc.serverNames.has(server.name)) {
        server.notifyDidClose(doc.uri);
      }
    }
    this.events?.emit('lsp.document.closed', { path: doc.path });
    this.accountText(doc.text, undefined);
    this.docs.delete(absPath);
    this.lastUsed.delete(absPath);
  }

  /** Drop least-recently-used documents until back inside both budgets. */
  private enforceBudget(): void {
    if (this.docs.size <= MAX_TRACKED_DOCS && this.trackedBytes <= MAX_TRACKED_BYTES) return;
    const order = [...this.docs.keys()].sort(
      (a, b) => this.lastUsed.get(a)! - this.lastUsed.get(b)!,
    );
    for (const absPath of order) {
      if (this.docs.size <= MAX_TRACKED_DOCS && this.trackedBytes <= MAX_TRACKED_BYTES) break;
      // Keep at least one document so the most recent read stays usable.
      /* v8 ignore next -- one trackable document cannot exceed the byte budget. */
      if (this.docs.size <= 1) break;
      this.evict(absPath);
    }
  }

  get(filePath: string): TrackedDocument | null {
    return this.docs.get(this.resolve(filePath)) ?? null;
  }

  list(): readonly TrackedDocument[] {
    return Array.from(this.docs.values());
  }

  private resolve(filePath: string): string {
    return path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(this.cwd, filePath);
  }
}

function toTextDocumentItem(doc: TrackedDocument): TextDocumentItem {
  return {
    uri: doc.uri,
    languageId: doc.languageId,
    version: doc.version,
    text: doc.text,
  };
}
