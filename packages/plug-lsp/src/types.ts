export type {
  CodeAction,
  CompletionItem,
  CompletionList,
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  Range,
  ServerCapabilities,
  SymbolInformation,
  WorkspaceEdit,
} from 'vscode-languageserver-protocol';

export type AutoStartMode = 'lazy' | 'eager' | 'never';
export type DiagnosticsAfterEdit = 'background' | 'manual';
export type SeverityName = 'error' | 'warning' | 'info' | 'hint';

export interface ServerConfig {
  command: string;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  languages: string[];
  /** Custom filename/extension to LSP language-id mappings (for example `.vue`: `vue`). */
  fileExtensions?: Record<string, string> | undefined;
  rootPatterns?: string[] | undefined;
  initializationOptions?: unknown | undefined;
  settings?: unknown | undefined;
  startupTimeoutMs?: number | undefined;
  enabled?: boolean | undefined;
}

export interface PlugLSPConfig {
  servers: Record<string, ServerConfig>;
  autoStart: AutoStartMode;
  diagnosticsAfterEdit: DiagnosticsAfterEdit;
  diagnosticsWaitMs: number;
  severityFilter: SeverityName[];
  maxDiagnosticsPerFile: number;
  maxDiagnosticsTotal: number;
  autoDiscover: boolean;
  logServerOutput: boolean;
}

export type ServerState =
  | 'disabled'
  | 'starting'
  | 'initializing'
  | 'ready'
  | 'failed'
  | 'shutting_down'
  | 'exited'
  | 'reconnecting';

export interface TrackedDocument {
  uri: string;
  path: string;
  languageId: string;
  version: number;
  text: string;
  serverNames: Set<string>;
}

export enum LSPErrorCode {
  ServerNotFound = 'LSP_SERVER_NOT_FOUND',
  ServerNotReady = 'LSP_SERVER_NOT_READY',
  ServerFailed = 'LSP_SERVER_FAILED',
  CapabilityMissing = 'LSP_CAPABILITY_MISSING',
  RequestTimeout = 'LSP_REQUEST_TIMEOUT',
  InvalidPosition = 'LSP_INVALID_POSITION',
  InvalidRequest = 'LSP_INVALID_REQUEST',
  ProtocolError = 'LSP_PROTOCOL_ERROR',
  ApplyEditFailed = 'LSP_APPLY_EDIT_FAILED',
}

export class LSPError extends Error {
  constructor(
    readonly code: LSPErrorCode,
    message: string,
    readonly details?: unknown | undefined,
  ) {
    super(message);
    this.name = 'LSPError';
  }
}

declare module '@wrongstack/core/kernel' {
  interface EventMap {
    'lsp.server.starting': { name: string; command: string };
    'lsp.server.ready': { name: string; languages: string[] };
    'lsp.server.exited': { name: string; code: number | null; signal: string | null };
    'lsp.server.crashed': { name: string; error: string };
    'lsp.diagnostics.updated': { path: string; count: number };
    'lsp.document.opened': { path: string; language: string };
    'lsp.document.closed': { path: string };
  }
}
