import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import { toErrorMessage } from '@wrongstack/core/utils/error';
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
import { resolveSpawnCommand, safeSpawn } from '../utils/safe-spawn.js';
import { pathToUri, uriKey, uriToPath } from '../utils/uri.js';
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
  /**
   * URIs for which the server has pushed at least one `publishDiagnostics`
   * since the document was last opened or edited. A push-only server reports
   * nothing until it has analysed the file, so "buffer is empty" and "file is
   * clean" are indistinguishable without this.
   */
  private readonly diagnosticsFresh = new Set<string>();
  private readonly diagnosticsWaiters = new Map<string, Set<() => void>>();
  private readonly documentRevisions = new Map<string, { version: number }>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: Connection | null = null;
  private processReachedReady = false;
  private lifecycleGeneration = 0;
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
    // `shutting_down` is terminal for this call: a concurrent
    // start would spawn a replacement that the in-flight shutdown then closes
    // and kills through `this.connection`/`this.child`.
    if (
      this.state === 'ready' ||
      this.state === 'starting' ||
      this.state === 'initializing' ||
      this.state === 'shutting_down'
    )
      return;
    if (this.config.enabled === false) {
      this.state = 'disabled';
      return;
    }
    this.state = 'starting';
    const generation = ++this.lifecycleGeneration;
    this.clearDiagnostics();
    this.processReachedReady = false;
    this.ctx.events.emit('lsp.server.starting', { name: this.name, command: this.config.command });
    const command = await resolveSpawnCommand(this.config.command, this.ctx.rootPath);
    // A shutdown requested while the command was being resolved wins; spawning
    // now would start a process nothing will ever stop.
    if (generation !== this.lifecycleGeneration || (this.state as ServerState) !== 'starting')
      return;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = safeSpawn(
        command === this.config.command ? this.config : { ...this.config, command },
        this.ctx.rootPath,
      );
    } catch (error) {
      // `safeSpawn` is synchronous and never reaches back into this server, so
      // the ownership check above still holds: no shutdown can interleave.
      this.state = 'failed';
      this.ctx.events.emit('lsp.server.crashed', {
        name: this.name,
        error: toErrorMessage(error),
      });
      throw error;
    }
    this.child = child;
    child.stderr.on('data', (chunk: Buffer) => this.captureStderr(chunk));
    child.on('exit', (code, sig) => {
      // A restart/spawn replaces `this.child` before the previous process'
      // exit event arrives. A stale event must not close the new connection or
      // overwrite the new child's state — that is what made `/lsp restart`
      // report success and then leave the server failed.
      if (this.child !== child) {
        this.ctx.events.emit('lsp.server.exited', { name: this.name, code, signal: sig });
        return;
      }
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
      this.clearDiagnostics();
    });
    child.on('error', (err) => {
      /* v8 ignore next -- stale-child error after a restart is defensive; spawn failure is covered. */
      if (this.child !== child) return;
      const shouldReconnect = this.processReachedReady;
      this.state = 'failed';
      this.clearDiagnostics();
      this.ctx.events.emit('lsp.server.crashed', { name: this.name, error: err.message });
      if (shouldReconnect) this.ctx.onCrash?.(this);
      this.processReachedReady = false;
    });

    const connection = new Connection(child.stdin, child.stdout);
    this.connection = connection;
    this.connection.onNotification('textDocument/publishDiagnostics', (params) => {
      if (this.child !== child) return;
      if (this.state !== 'ready' && this.state !== 'initializing') return;
      const p = params as {
        uri?: string | undefined;
        diagnostics?: Diagnostic[] | undefined;
        version?: number;
      };
      if (!p?.uri || !Array.isArray(p.diagnostics)) return;
      if (!this.setDiagnostics(p.uri, p.diagnostics, p.version)) return;
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
      if (this.child !== child) return;
      if (this.state === 'ready') this.state = 'failed';
      this.clearDiagnostics();
    });

    this.state = 'initializing';
    const startup = startupFailure(child);
    try {
      const capabilities = await Promise.race([
        initializeServer(
          connection,
          this.config,
          this.ctx.rootPath,
          this.config.startupTimeoutMs ?? 15_000,
          signal,
        ),
        startup.promise,
      ]);
      startup.cancel();
      if (
        generation !== this.lifecycleGeneration ||
        this.child !== child ||
        this.connection !== connection ||
        (this.state as ServerState) !== 'initializing'
      ) {
        throw new LSPError(
          LSPErrorCode.ServerNotReady,
          `Server "${this.name}" stopped during startup`,
        );
      }
      this.capabilities = capabilities;
      this.state = 'ready';
      this.processReachedReady = true;
      this.ctx.events.emit('lsp.server.ready', {
        name: this.name,
        languages: this.config.languages,
      });
    } catch (err) {
      startup.cancel();
      if (generation !== this.lifecycleGeneration || this.child !== child) throw err;
      this.state = 'failed';
      this.clearDiagnostics();
      connection.close();
      treeKill(child);
      this.processReachedReady = false;
      throw err;
    }
  }

  async shutdown(): Promise<void> {
    if (this.state === 'exited' || this.state === 'disabled') return;
    this.lifecycleGeneration++;
    this.state = 'shutting_down';
    this.clearDiagnostics();
    try {
      if (this.connection) {
        const ctrl = new AbortController();
        await this.connection
          .sendRequest('shutdown', null, 3000, ctrl.signal)
          .catch(() => undefined);
        try {
          this.connection?.sendNotification('exit', null);
        } catch {
          // The child may have closed its transport while shutdown was pending.
        }
      }
    } finally {
      this.connection?.close();
      this.connection = null;
      if (this.child && !this.child.killed) treeKill(this.child);
      this.child = null;
      this.processReachedReady = false;
      this.state = 'exited';
      this.clearDiagnostics();
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

  /** Invoke a server-specific request that has no typed WrongStack tool. */
  async customRequest(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<unknown> {
    return await this.request(method, params, timeoutMs, signal);
  }

  async pullDiagnostics(
    uri: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Diagnostic[]> {
    const key = uriKey(uri);
    const revision = this.documentRevisions.get(key);
    const connection = this.connection;
    const result = await this.request<{ kind?: string; items?: Diagnostic[] } | null>(
      'textDocument/diagnostic',
      { textDocument: { uri } },
      timeoutMs,
      signal,
    );
    signal.throwIfAborted();
    if (this.state !== 'ready' || this.connection !== connection) {
      throw new LSPError(
        LSPErrorCode.ServerNotReady,
        `Server "${this.name}" changed while requesting diagnostics`,
      );
    }
    if (this.documentRevisions.get(key) !== revision) {
      throw new LSPError(
        LSPErrorCode.InvalidRequest,
        `Document ${uri} changed while requesting diagnostics; retry the check.`,
      );
    }
    // We do not send previousResultId, so an unchanged report cannot be used
    // here. Missing/null items are not evidence that a document is clean.
    if (result?.kind !== 'full' || !Array.isArray(result.items)) {
      throw new LSPError(
        LSPErrorCode.ProtocolError,
        `Server "${this.name}" returned an invalid diagnostic report for ${uri}`,
      );
    }
    const items = result.items;
    this.setDiagnostics(uri, items);
    return items;
  }

  getDiagnostics(uri: string): Diagnostic[] {
    return this.diagnostics.get(uriKey(uri)) ?? [];
  }

  /**
   * Diagnostics for `uri`, waiting up to `timeoutMs` for the server's first
   * `publishDiagnostics` after the document was opened or edited. Push-based
   * servers analyse asynchronously, so reading the buffer the instant after
   * `didOpen` reports "no diagnostics" for a file that is about to be flagged.
   * Returns whatever is buffered once the wait ends — a timeout is not an
   * error for background/cache consumers. Explicit verification callers use
   * `requireFresh` so a timeout, stopped server, or cancellation cannot be
   * mistaken for a confirmed clean document.
   */
  async waitForDiagnostics(
    uri: string,
    timeoutMs: number,
    signal?: AbortSignal | undefined,
    requireFresh = false,
  ): Promise<Diagnostic[]> {
    const key = uriKey(uri);
    const result = (): Diagnostic[] => {
      if (requireFresh) {
        signal?.throwIfAborted();
        if (this.state !== 'ready') {
          throw new LSPError(LSPErrorCode.ServerNotReady, `Server "${this.name}" is not ready`);
        }
        if (!this.diagnosticsFresh.has(key)) {
          throw new LSPError(
            LSPErrorCode.RequestTimeout,
            `Server "${this.name}" has not reported diagnostics for ${uri} within ${timeoutMs}ms; the file has not been verified.`,
          );
        }
      }
      return this.getDiagnostics(uri);
    };
    if (
      this.diagnosticsFresh.has(key) ||
      timeoutMs <= 0 ||
      this.state !== 'ready' ||
      signal?.aborted
    ) {
      return result();
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        /* v8 ignore next -- defensive: each waiter unregisters itself, so no path calls it twice. */
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        const waiters = this.diagnosticsWaiters.get(key);
        waiters?.delete(finish);
        if (waiters?.size === 0) this.diagnosticsWaiters.delete(key);
        resolve();
      };
      if (signal?.aborted) {
        finish();
        return;
      }
      timer = setTimeout(finish, timeoutMs);
      /* v8 ignore next -- Node timers always expose unref; the guard is for non-Node hosts. */
      timer.unref?.();
      signal?.addEventListener('abort', finish, { once: true });
      const waiters = this.diagnosticsWaiters.get(key) ?? new Set<() => void>();
      waiters.add(finish);
      this.diagnosticsWaiters.set(key, waiters);
    });
    return result();
  }

  notifyDidOpen(doc: TextDocumentItem): void {
    this.documentRevisions.set(uriKey(doc.uri), { version: doc.version });
    this.diagnosticsFresh.delete(uriKey(doc.uri));
    this.notification('textDocument/didOpen', { textDocument: doc });
  }

  notifyDidChange(doc: VersionedTextDocumentIdentifier, text: string): void {
    this.documentRevisions.set(uriKey(doc.uri), { version: doc.version });
    this.diagnosticsFresh.delete(uriKey(doc.uri));
    this.notification('textDocument/didChange', {
      textDocument: doc,
      contentChanges: [{ text }],
    });
  }

  notifyDidClose(uri: string): void {
    // Eagerly drop the entry — the closed document's diagnostics are stale and
    // would otherwise be retained (and counted against the cap) forever.
    this.diagnostics.delete(uriKey(uri));
    this.diagnosticsFresh.delete(uriKey(uri));
    this.documentRevisions.delete(uriKey(uri));
    this.wakeDiagnosticsWaiters(uriKey(uri));
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
  private setDiagnostics(uri: string, diagnostics: Diagnostic[], version?: number): boolean {
    // Key on the canonical path, never the raw URI: a server may answer our
    // `file:///C:/…` with `file:///c%3A/…` and the buffer would never match.
    const key = uriKey(uri);
    const revision = this.documentRevisions.get(key);
    if (version !== undefined && revision && version !== revision.version) return false;
    if (this.diagnostics.has(key)) this.diagnostics.delete(key);
    this.diagnostics.set(key, diagnostics);
    this.diagnosticsFresh.add(key);
    this.wakeDiagnosticsWaiters(key);
    while (this.diagnostics.size > LSPServer.MAX_DIAGNOSTICS_ENTRIES) {
      const oldest = this.diagnostics.keys().next().value;
      if (oldest === undefined) break;
      this.diagnostics.delete(oldest);
      // Keep the freshness set bounded too: an evicted URI that stayed in
      // `diagnosticsFresh` would both leak forever and make waitForDiagnostics
      // return an empty buffer immediately instead of waiting for a republish.
      this.diagnosticsFresh.delete(oldest);
    }
    return true;
  }

  private wakeDiagnosticsWaiters(key: string): void {
    const waiters = this.diagnosticsWaiters.get(key);
    this.diagnosticsWaiters.delete(key);
    if (waiters) for (const wake of waiters) wake();
  }

  private clearDiagnostics(): void {
    this.diagnostics.clear();
    this.diagnosticsFresh.clear();
    this.documentRevisions.clear();
    for (const key of this.diagnosticsWaiters.keys()) this.wakeDiagnosticsWaiters(key);
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
