import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Logger } from '@wrongstack/core/types';
import type { DocumentTracker } from '../document-tracker.js';
import type { LSPRegistry } from '../registry.js';
import type { LSPServer } from '../server/lsp-server.js';
import type { PlugLSPConfig } from '../types.js';
import { LSPError, LSPErrorCode } from '../types.js';
import { pathToUri } from '../utils/uri.js';

export interface ToolDeps {
  registry: LSPRegistry;
  tracker: DocumentTracker;
  cfg: PlugLSPConfig;
  log: Logger;
}

/**
 * The plugin's single path resolver. Every LSP entry point — tools and the
 * post-edit diagnostics listener in `index.ts` — routes through here so the
 * absolute/relative branch lives in one reviewed place instead of being
 * re-derived per call site (see the path-resolution-convention arch gate).
 * No project-root containment: LSP legitimately navigates outside the session
 * cwd (dependency sources, SDK/stdlib files a definition jumps into).
 */
export function resolveInputPath(inputPath: string, ctx: { cwd: string }): string {
  return path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.resolve(ctx.cwd, inputPath);
}

export async function requireServer(
  registry: LSPRegistry,
  filePath: string,
  signal: AbortSignal,
): Promise<LSPServer> {
  const server = await registry.findForPath(filePath, signal);
  if (!server) {
    throw new LSPError(LSPErrorCode.ServerNotFound, `No LSP server is configured for ${filePath}`);
  }
  return server;
}

export async function readDocumentContent(
  filePath: string,
  tracker: DocumentTracker,
): Promise<string> {
  const tracked = tracker.get(filePath);
  return tracked?.text ?? (await fs.readFile(filePath, 'utf8'));
}

export function textDocumentPosition(
  uriPath: string,
  position: { line: number; character: number },
) {
  return { textDocument: { uri: pathToUri(uriPath) }, position };
}

export function stringifyToolError(err: unknown): string {
  if (err instanceof LSPError) return `[${err.code}] ${err.message}`;
  if (err instanceof Error) return `[${LSPErrorCode.ProtocolError}] ${err.message}`;
  return `[${LSPErrorCode.ProtocolError}] ${String(err)}`;
}
