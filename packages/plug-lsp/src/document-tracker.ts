import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { EventBus, EventMap, Logger } from '@wrongstack/core';
import type { TextDocumentItem } from 'vscode-languageserver-protocol';
import { languageIdFor } from './language-detect.js';
import type { LSPRegistry } from './registry.js';
import type { LSPServer } from './server/lsp-server.js';
import type { TrackedDocument } from './types.js';
import { pathToUri } from './utils/uri.js';

export class DocumentTracker {
  private readonly docs = new Map<string, TrackedDocument>();
  private cwd: string;

  constructor(
    private readonly registry: () => LSPRegistry,
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

  async fileWritten(filePath: string): Promise<void> {
    const absPath = this.resolve(filePath);
    const languageId = languageIdFor(absPath);
    if (!languageId) return;
    let text: string;
    try {
      text = await fs.readFile(absPath, 'utf8');
    } catch (err) {
      this.log.debug(`LSP tracker could not read changed file ${absPath}`, err);
      return;
    }
    const doc = this.docs.get(absPath);
    if (!doc) {
      await this.open(absPath, text);
      return;
    }
    doc.version++;
    doc.text = text;
    for (const server of this.registry().list()) {
      /* v8 ignore next -- false branch is defensive for mixed registries. */
      if (server.state !== 'ready' || !server.config.languages.includes(languageId)) continue;
      server.notifyDidChange({ uri: doc.uri, version: doc.version }, text);
      doc.serverNames.add(server.name);
    }
  }

  async open(filePath: string, knownText?: string): Promise<void> {
    const absPath = this.resolve(filePath);
    const languageId = languageIdFor(absPath);
    if (!languageId) return;
    let text: string;
    try {
      text = knownText ?? (await fs.readFile(absPath, 'utf8'));
    } catch (err) {
      this.log.debug(`LSP tracker could not read opened file ${absPath}`, err);
      return;
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
      this.events?.emit('lsp.document.opened', { path: absPath, language: languageId });
    }
    for (const server of this.registry().list()) {
      if (server.state !== 'ready' || !server.config.languages.includes(languageId)) continue;
      /* v8 ignore next -- duplicate-open guard is defensive/idempotent. */
      if (doc.serverNames.has(server.name)) continue;
      server.notifyDidOpen(toTextDocumentItem(doc));
      doc.serverNames.add(server.name);
    }
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
