import { pathToFileURL } from 'node:url';
import type {
  InitializeParams,
  InitializeResult,
  ServerCapabilities,
} from 'vscode-languageserver-protocol';
import type { ServerConfig } from '../types.js';
import type { Connection } from './connection.js';

const CLIENT_CAPABILITIES: InitializeParams['capabilities'] = {
  workspace: {
    workspaceFolders: true,
    didChangeWatchedFiles: { dynamicRegistration: false },
    symbol: {},
    executeCommand: { dynamicRegistration: false },
  },
  textDocument: {
    synchronization: {
      didSave: false,
      dynamicRegistration: false,
      willSave: false,
      willSaveWaitUntil: false,
    },
    diagnostic: { dynamicRegistration: false },
    definition: { linkSupport: true },
    references: {},
    hover: { contentFormat: ['markdown', 'plaintext'] },
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    rename: { prepareSupport: true },
    codeAction: {},
  },
  general: { positionEncodings: ['utf-16'] },
};

export async function initializeServer(
  connection: Connection,
  serverCfg: ServerConfig,
  rootPath: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ServerCapabilities> {
  const rootUri = pathToFileURL(rootPath).toString();
  const params: InitializeParams = {
    processId: process.pid,
    rootPath,
    rootUri,
    capabilities: CLIENT_CAPABILITIES,
    initializationOptions: serverCfg.initializationOptions,
    workspaceFolders: [
      {
        uri: rootUri,
        name: rootPath.split(/[\\/]/).pop()!,
      },
    ],
  };
  const result = await connection.sendRequest<InitializeResult>(
    'initialize',
    params,
    timeoutMs,
    signal,
  );
  connection.sendNotification('initialized', {});
  return result.capabilities;
}
