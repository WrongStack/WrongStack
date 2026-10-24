import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { InProcessHook } from '@wrongstack/contracts/types';
import type { Diagnostic } from 'vscode-languageserver-protocol';
import { formatDiagnostics } from './formatters/diagnostics.js';
import { supportsPullDiagnostics } from './server/capabilities.js';
import type { LSPServer } from './server/lsp-server.js';
import {
  createLineTextReader,
  requireServer,
  resolveInputPath,
  type ToolDeps,
} from './tools/shared.js';
import { pathToUri } from './utils/uri.js';

async function stillMatches(file: string, text: string, signal: AbortSignal): Promise<boolean> {
  const expected = Buffer.from(text, 'utf8');
  let offset = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 65_536, signal })) {
    const bytes = chunk as Buffer;
    if (
      offset + bytes.length > expected.length ||
      !bytes.equals(expected.subarray(offset, offset + bytes.length))
    )
      return false;
    offset += bytes.length;
  }
  return offset === expected.length;
}

/** Same-call feedback; freshness failures never become a clean-file claim. */
export function createPostEditFeedback(
  deps: ToolDeps,
  captureCurrent: (cwd: string) => () => boolean,
): InProcessHook {
  return async (input, runtime) => {
    if (deps.cfg.diagnosticsAfterEdit !== 'background' || input.toolResult?.isError) return;
    const args = input.toolInput as
      | { path?: unknown; file?: unknown; dry_run?: unknown }
      | undefined;
    if (args?.dry_run === true) return;
    const current = captureCurrent(input.cwd);
    if (!current()) return;
    const bulk = input.toolName === 'replace' || input.toolName === 'patch';
    const target = args?.path ?? args?.file;
    const targets = bulk
      ? input.toolResult?.modifiedPaths
      : typeof target === 'string'
        ? [target]
        : [];
    if (!targets) {
      if (input.toolName === 'replace' && args?.dry_run !== false) return;
      if (deps.registry.list().length === 0) return;
      return {
        additionalContext:
          '[Post-edit LSP feedback] Bulk-write file scope unavailable; files not verified. Use lsp_diagnostics or tests/typecheck.',
        contextAs: 'inline',
      };
    }
    const files = [
      ...new Set(targets.map((file) => resolveInputPath(file, { cwd: input.cwd }))),
    ].filter((file) => {
      const language = deps.registry.languageIdForPath(file);
      return language && deps.registry.list().some((s) => s.config.languages.includes(language));
    });
    const omitted = Math.max(0, files.length - 8) + (input.toolResult?.modifiedPathsOmitted ?? 0);
    if (files.length === 0 && omitted === 0) return;
    const selected = files.slice(0, 8);
    const label = (value: string, limit = 512) => {
      const encoded = JSON.stringify(value);
      return encoded.length > limit ? `${encoded.slice(0, limit - 2)}…"` : encoded;
    };
    const deadline = new AbortController();
    const waitMs = Math.min(deps.cfg.diagnosticsWaitMs, 5000);
    const timer = setTimeout(
      () => deadline.abort(new Error('LSP feedback deadline exceeded')),
      waitMs,
    );
    const signal = AbortSignal.any([runtime.signal, deadline.signal]);
    const snapshots: Array<{
      file: string;
      version: number;
      text: string;
      server: LSPServer;
      diagnostics: Diagnostic[];
    }> = [];
    const unavailable: string[] = [];
    try {
      for (const file of selected) {
        if (!current() || runtime.signal.aborted) return;
        try {
          signal.throwIfAborted();
          const server = await requireServer(deps.registry, file, signal);
          if (!current() || !(await deps.tracker.open(file)))
            throw new Error('Document unavailable');
          const doc = deps.tracker.get(file);
          if (!doc) throw new Error('Document unavailable');
          const { version, text } = doc;
          const uri = pathToUri(file);
          const diagnostics =
            server.capabilities && supportsPullDiagnostics(server.capabilities)
              ? await server.pullDiagnostics(uri, waitMs, signal)
              : await server.waitForDiagnostics(uri, waitMs, signal, true);
          signal.throwIfAborted();
          snapshots.push({ file, version, text, server, diagnostics });
        } catch {
          unavailable.push(file);
        }
      }
      const identities: string[] = [];
      const byFile = new Map<string, Diagnostic[]>();
      // Recheck earlier files after later analysis; a bulk edit is not a single
      // atomic LSP snapshot and its first file may have changed in the meantime.
      for (const { file, version, text, server, diagnostics } of snapshots) {
        try {
          signal.throwIfAborted();
          const matches = await stillMatches(file, text, signal);
          signal.throwIfAborted();
          if (
            deps.registry.get(server.name) !== server ||
            server.state !== 'ready' ||
            deps.tracker.get(file)?.version !== version ||
            !matches
          )
            throw new Error('Stale analysis');
          const hash = createHash('sha256').update(text).digest('hex');
          identities.push(
            `${label(file)}; version=${version}; sha256=${hash}; server=${label(server.name, 128)}.`,
          );
          byFile.set(file, diagnostics);
        } catch {
          unavailable.push(file);
        }
      }
      if (!current() || runtime.signal.aborted) return;
      const output =
        byFile.size === 0
          ? ''
          : formatDiagnostics(byFile, {
              cwd: input.cwd,
              severityFilter: deps.cfg.severityFilter,
              maxPerFile: deps.cfg.maxDiagnosticsPerFile,
              maxTotal: deps.cfg.maxDiagnosticsTotal,
              lineText: createLineTextReader(deps.tracker),
            });
      const received = [...byFile.values()].reduce(
        (total, diagnostics) => total + diagnostics.length,
        0,
      );
      const notices = unavailable.map(
        (file) => `${label(file)}: current diagnostics unavailable; file not verified.`,
      );
      if (omitted > 0)
        notices.push(
          `${omitted} additional file scope entries not checked; files not verified (feedback limit).`,
        );
      const prefix = `[Post-edit LSP feedback] ${identities.join('\n')}\n${notices.join('\n')}\n`;
      const suffix = `\nReceived ${received} diagnostics; displayed severities: ${deps.cfg.severityFilter.join(', ')}. Verified file(s): ${byFile.size}.\nFile-scoped LSP analysis only; diagnostics may predate this edit. Tests/typecheck remain required. Use lsp_diagnostics for unverified files.`;
      const remaining = Math.max(0, Math.min(7000, 8000 - prefix.length - suffix.length - 32));
      const body =
        output.length > remaining
          ? `${output.slice(0, remaining)}\n[diagnostics truncated]`
          : output;
      return {
        additionalContext: `${prefix}${body}${suffix}`,
        contextAs: 'inline',
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
