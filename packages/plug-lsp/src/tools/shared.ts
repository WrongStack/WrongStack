import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Logger } from '@wrongstack/contracts/types';
import type { DocumentTracker } from '../document-tracker.js';
import type { LineTextReader } from '../formatters/location.js';
import { splitLines } from '../position.js';
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
  if (server) return server;
  // `findForPath` returns null both when no server claims the language and
  // when the configured one is not ready (failed to spawn, still starting,
  // exited). Reporting both as "not configured" sent the model to fix config
  // that was fine; name the server and its state instead.
  const language =
    typeof registry.languageIdForPath === 'function' ? registry.languageIdForPath(filePath) : null;
  const configured =
    language && typeof registry.list === 'function'
      ? registry.list().find((candidate) => candidate.config.languages.includes(language))
      : undefined;
  if (configured) {
    throw new LSPError(
      LSPErrorCode.ServerNotReady,
      `LSP server "${configured.name}" for ${language} is ${configured.state}, not ready for ${filePath}`,
    );
  }
  throw new LSPError(LSPErrorCode.ServerNotFound, `No LSP server is configured for ${filePath}`);
}

export async function readDocumentContent(
  filePath: string,
  tracker: DocumentTracker,
): Promise<string> {
  const tracked = tracker.get(filePath);
  return tracked?.text ?? (await fs.readFile(filePath, 'utf8'));
}

/**
 * Line reader for the output formatters, so the columns a tool prints use the
 * same 1-based byte convention its inputs do. Tracked documents are read from
 * memory (the version the server answered about); others from disk, once per
 * file per call. A file that cannot be read keeps the raw column.
 */
export function createLineTextReader(tracker: DocumentTracker): LineTextReader {
  const cache = new Map<string, string[] | null>();
  return (filePath, line) => {
    let lines = cache.get(filePath);
    if (lines === undefined) {
      let text: string | undefined = tracker.get(filePath)?.text;
      if (text === undefined) {
        try {
          text = readFileSync(filePath, 'utf8');
        } catch {
          text = undefined;
        }
      }
      lines = text === undefined ? null : splitLines(text);
      cache.set(filePath, lines);
    }
    return lines?.[line];
  };
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

/**
 * The error a tool THROWS for a failure. Tools used to RETURN
 * `stringifyToolError(err)`, which the executor recorded as a successful call
 * (is_error:false). The `[code]` prefix is kept in the message; aborts
 * propagate unchanged so a cancel stays a cancel.
 */
export function toToolError(err: unknown): Error {
  if (err instanceof Error && err.name === 'AbortError') return err;
  const wrapped = new LSPError(
    err instanceof LSPError ? err.code : LSPErrorCode.ProtocolError,
    stringifyToolError(err),
    err instanceof LSPError ? err.details : undefined,
  );
  (wrapped as { cause?: unknown }).cause = err;
  return wrapped;
}
