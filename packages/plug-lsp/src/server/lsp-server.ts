import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { EventBus } from '@wrongstack/core/kernel';
import type { Logger } from '@wrongstack/core/types';
import { treeKill } from '@wrongstack/core/utils/tree-kill';
import type {
  CodeAction,
  CodeActionParams,
  CompletionItem,
  CompletionList,
  CompletionParams,
  Diagnostic,
  DocumentSymbol,
  DocumentSymbolParams,
  ExecuteCommandParams,
  Hover,
  HoverParams,
  Location,
  LocationLink,
  Position,
  PrepareRenameParams,
  ReferenceParams,
  RenameParams,
  ServerCapabilities,
  SymbolInformation,
  TextDocumentItem,
  VersionedTextDocumentIdentifier,
  WorkspaceEdit,
  WorkspaceSymbolParams,
} from 'vscode-languageserver-protocol';
import type { ServerConfig, ServerState } from '../types.js';
import { LSPError, LSPErrorCode } from '../types.js';
import { safeSpawn } from '../utils/safe-spawn.js';
import { pathToUri, uriToPath } from '../utils/uri.js';
import { Connection } from './connection.js';
import { initializeServer } from './initialize.js';

interface ServerContext {
  cwd: string;
  rootPath: string;
  log: Logger;
  events: EventBus;
  onCrash?: ((server: LSPServer) => void) | undefined;
}

export class LSPServer {
  /**
   * Hard cap on retained diagnostics entries. Each entry holds a `Diagnostic[]`
   * for one file URI; without a cap a long-lived server keeps one entry per
   * distinct URI ever opened (RAM-leak audit 2026-07-31, MEDIUM). Oldest
   * entries are evicted first; `notifyDidClose` drops entries eagerly.
   */
  static readonly MAX_DIAGNOSTICS_ENTRIES = 500;
  state: ServerState = 'exited';
  capabilities: ServerCapabilities | null = null;
  readonly diagnostics = new Map<string, Diagnostic[]>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: Connection | null = null;
  private processReachedReady = false;
  private stderrRing: string[] = [];

  constructor(
    readonly name: string,
    readonly config: ServerConfig,
    private readonly ctx: ServerContext,
  ) {
    if (config.enabled === false) this.state = 'disabled';
  }

  get rootPath(): string {
    return this.ctx.rootPath;
  }

  get lastStderr(): string {
    return this.stderrRing.slice(-20).join('\n');
  }

  async start(signal: AbortSignal = new AbortController().signal): Promise<void> {
    if (this.state === 'ready' || this.state === 'starting' || this.state === 'initializing')
      return;
    if (this.config.enabled === false) {
      this.state = 'disabled';
      return;
    }
    this.state = 'starting';
    this.processReachedReady = false;
    this.ctx.events.emit('lsp.server.starting', { name: this.name, command: this.config.command });
    const child = safeSpawn(this.config, this.ctx.rootPath);
    this.child = child;
    child.stderr.on('data', (chunk: Buffer) => this.captureStderr(chunk));
    child.on('exit', (code, sig) => {
      const shouldReconnect = this.processReachedReady;
      this.connection?.close();
      this.connection = null;
      this.child = null;
      if (this.state !== 'shutting_down' && this.state !== 'exited') {
        this.state = 'failed';
        this.ctx.events.emit('lsp.server.crashed', {
          name: this.name,
          error: `process exited code=${code ?? 'null'} signal=${sig ?? 'null'}`,
        });
        if (shouldReconnect) this.ctx.onCrash?.(this);
      }
      this.ctx.events.emit('lsp.server.exited', { name: this.name, code, signal: sig });
      this.processReachedReady = false;
    });
    child.on('error', (err) => {
      const shouldReconnect = this.processReachedReady;
      this.state = 'failed';
      this.ctx.events.emit('lsp.server.crashed', { name: this.name, error: err.message });
      if (shouldReconnect) this.ctx.onCrash?.(this);
      this.processReachedReady = false;
    });

    this.connection = new Connection(child.stdin, child.stdout);
    this.connection.onNotification('textDocument/publishDiagnostics', (params) => {
      const p = params as { uri?: string | undefined; diagnostics?: Diagnostic[] | undefined };
      if (!p.uri || !Array.isArray(p.diagnostics)) return;
      this.setDiagnostics(p.uri, p.diagnostics);
      this.ctx.events.emit('lsp.diagnostics.updated', {
        path: p.uri.startsWith('file:') ? uriToPath(p.uri) : p.uri,
        count: p.diagnostics.length,
      });
    });
    this.connection.onNotification('window/logMessage', (params) => {
      if (this.config.enabled !== false && params && this.config) {
        this.ctx.log.debug(`LSP ${this.name} log`, params);
      }
    });
    this.connection.onClose(() => {
      if (this.state === 'ready') this.state = 'failed';
    });

    this.state = 'initializing';
    const startup = startupFailure(child);
    try {
      this.capabilities = await Promise.race([
        initializeServer(
          this.connection,
          this.config,
          this.ctx.rootPath,
          this.config.startupTimeoutMs ?? 15_000,
          signal,
        ),
        startup.promise,
      ]);
      startup.cancel();
      this.state = 'ready';
      this.processReachedReady = true;
      this.ctx.events.emit('lsp.server.ready', {
        name: this.name,
        languages: this.config.languages,
      });
    } catch (err) {
      startup.cancel();
      this.state = 'failed';
      this.connection?.close();
      treeKill(child);
      this.processReachedReady = false;
      throw err;
    }
  }

  async shutdown(): Promise<void> {
    if (this.state === 'exited' || this.state === 'disabled') return;
    this.state = 'shutting_down';
    try {
      if (this.connection) {
        const ctrl = new AbortController();
        await this.connection
          .sendRequest('shutdown', null, 3000, ctrl.signal)
          .catch(() => undefined);
        this.connection.sendNotification('exit', null);
      }
    } finally {
      this.connection?.close();
      this.connection = null;
      if (this.child && !this.child.killed) treeKill(this.child);
      this.child = null;
      this.processReachedReady = false;
      this.state = 'exited';
    }
  }

  async definition(
    params: TextDocumentPositionParamsLike,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Location[] | LocationLink[] | null> {
    return await this.request('textDocument/definition', params, timeoutMs, signal);
  }

  async references(
    params: ReferenceParams,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Location[] | null> {
    return await this.request('textDocument/references', params, timeoutMs, signal);
  }

  async hover(params: HoverParams, timeoutMs: number, signal: AbortSignal): Promise<Hover | null> {
    return await this.request('textDocument/hover', params, timeoutMs, signal);
  }

  async completion(
    params: CompletionParams,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<CompletionItem[] | CompletionList | null> {
    return await this.request('textDocument/completion', params, timeoutMs, signal);
  }

  async documentSymbol(
    params: DocumentSymbolParams,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
    return await this.request('textDocument/documentSymbol', params, timeoutMs, signal);
  }

  async workspaceSymbol(
    params: WorkspaceSymbolParams,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<SymbolInformation[] | null> {
    return await this.request('workspace/symbol', params, timeoutMs, signal);
  }

  async prepareRename(
    params: PrepareRenameParams,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<
    | { range: unknown; placeholder?: string | undefined }
    | import('vscode-languageserver-protocol').Range
    | null
  > {
    return await this.request('textDocument/prepareRename', params, timeoutMs, signal);
  }

  async rename(
    params: RenameParams,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<WorkspaceEdit | null> {
    return await this.request('textDocument/rename', params, timeoutMs, signal);
  }

  async codeAction(
    params: CodeActionParams,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<CodeAction[]> {
    return (await this.request('textDocument/codeAction', params, timeoutMs, signal)) ?? [];
  }

  async executeCommand(
    params: ExecuteCommandParams,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<unknown> {
    return await this.request('workspace/executeCommand', params, timeoutMs, signal);
  }

  async pullDiagnostics(
    uri: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Diagnostic[]> {
    const result = await this.request<{ items?: Diagnostic[] | undefined }>(
      'textDocument/diagnostic',
      { textDocument: { uri } },
      timeoutMs,
      signal,
    );
    const items = result?.items ?? [];
    this.setDiagnostics(uri, items);
    return items;
  }

  getDiagnostics(uri: string): Diagnostic[] {
    return this.diagnostics.get(uri) ?? [];
  }

  notifyDidOpen(doc: TextDocumentItem): void {
    this.notification('textDocument/didOpen', { textDocument: doc });
  }

  notifyDidChange(doc: VersionedTextDocumentIdentifier, text: string): void {
    this.notification('textDocument/didChange', {
      textDocument: doc,
      contentChanges: [{ text }],
    });
  }

  notifyDidClose(uri: string): void {
    // Eagerly drop the entry — the closed document's diagnostics are stale and
    // would otherwise be retained (and counted against the cap) forever.
    this.diagnostics.delete(uri);
    this.notification('textDocument/didClose', { textDocument: { uri } });
  }

  textDocumentIdentifier(filePath: string): { uri: string } {
    return { uri: pathToUri(filePath) };
  }

  private async request<T>(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<T> {
    if (this.state !== 'ready' || !this.connection) {
      throw new LSPError(LSPErrorCode.ServerNotReady, `Server "${this.name}" is not ready`);
    }
    return await this.connection.sendRequest<T>(method, params, timeoutMs, signal);
  }

  private notification(method: string, params: unknown): void {
    if (this.state !== 'ready' || !this.connection) return;
    this.connection.sendNotification(method, params);
  }

  /**
   * Store diagnostics with LRU semantics: re-insert so the entry becomes
   * most-recently-used, then evict the oldest entries past the cap.
   */
  private setDiagnostics(uri: string, diagnostics: Diagnostic[]): void {
    if (this.diagnostics.has(uri)) this.diagnostics.delete(uri);
    this.diagnostics.set(uri, diagnostics);
    while (this.diagnostics.size > LSPServer.MAX_DIAGNOSTICS_ENTRIES) {
      const oldest = this.diagnostics.keys().next().value;
      if (oldest === undefined) break;
      this.diagnostics.delete(oldest);
    }
  }

  private captureStderr(chunk: Buffer): void {
    const lines = chunk.toString('utf8').split(/\r?\n/).filter(Boolean);
    this.stderrRing.push(...lines);
    if (this.stderrRing.length > 100) this.stderrRing = this.stderrRing.slice(-100);
  }
}

interface TextDocumentPositionParamsLike {
  textDocument: { uri: string };
  position: Position;
}

function startupFailure(child: ChildProcessWithoutNullStreams): {
  promise: Promise<never>;
  cancel: () => void;
} {
  let rejectStartup!: (reason: unknown) => void;
  const promise = new Promise<never>((_, reject) => {
    rejectStartup = reject;
  });
  const cleanup = () => {
    child.off('error', onError);
    child.off('exit', onExit);
  };
  const onError = (err: Error) => {
    cleanup();
    rejectStartup(
      new LSPError(LSPErrorCode.ServerFailed, `LSP server failed to start: ${err.message}`, err),
    );
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    cleanup();
    rejectStartup(
      new LSPError(
        LSPErrorCode.ServerFailed,
        `LSP server exited during startup code=${code ?? 'null'} signal=${signal ?? 'null'}`,
      ),
    );
  };
  child.once('error', onError);
  child.once('exit', onExit);
  return { promise, cancel: cleanup };
}

/** Direct-module test seam; not re-exported by the package barrel. */
export const lspServerCoverage = { startupFailure };
