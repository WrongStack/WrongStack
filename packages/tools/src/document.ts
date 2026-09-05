import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import type { Tool } from '@wrongstack/core/types';
import { ensureInsideRoot, safeResolveReal } from './_util.js';

interface DocumentInput {
  target: 'file' | 'function' | 'class' | 'type' | 'all';
  path?: string | undefined;
  files?: string | string[] | undefined;
  style?: 'jsdoc' | 'tsdoc' | 'block' | undefined;
  overwrite?: boolean | undefined;
  cwd?: string | undefined;
}

interface DocumentedItem {
  path: string;
  name: string;
  signature: string;
  docstring: string;
  status: 'documented' | 'skipped' | 'error';
  error?: string | undefined;
}

interface DocumentOutput {
  files_processed: number;
  items_documented: number;
  results: DocumentedItem[];
  style: string;
}

export const documentTool: Tool<DocumentInput, DocumentOutput> = {
  name: 'document',
  category: 'Project',
  description:
    'DEPRECATED — read-only preview stub that lists undocumented symbols as `skipped` candidates. ' +
    'It never writes files and does not generate real docstrings. ' +
    'If the auto-doc plugin is enabled, use its `auto_doc` tool (with `dry_run: true` to preview) instead.',
  usageHint:
    'Deprecated: this tool only lists undocumented symbols with placeholder comments — it does not generate real JSDoc/TSDoc and writes nothing. ' +
    'When the auto-doc plugin is enabled, prefer its `auto_doc` tool (`dry_run: true` for previewing, without it for writing).',
  permission: 'auto',
  mutating: false,
  timeoutMs: 30_000,
  capabilities: ['fs.read'],
  icon: 'document',
  inputSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: ['file', 'function', 'class', 'type', 'all'],
        description: 'What to document',
      },
      path: {
        type: 'string',
        description: 'Specific file path to document',
      },
      files: {
        type: 'string',
        description: 'File(s) to process: single path, comma-separated list, or glob',
      },
      style: {
        type: 'string',
        enum: ['jsdoc', 'tsdoc', 'block'],
        description: 'Documentation style (default: jsdoc)',
      },

      cwd: { type: 'string', description: 'Working directory (default: cwd)' },
    },
  },
  async execute(input, ctx, _opts) {
    const signal = _opts?.signal ?? ctx?.signal;
    signal?.throwIfAborted();
    const cwd = input.cwd ? await safeResolveReal(input.cwd, ctx) : ctx.cwd;
    const style = input.style ?? 'jsdoc';
    const results: DocumentedItem[] = [];
    let filesProcessed = 0;
    let itemsDocumented = 0;

    const fileList = input.files
      ? await resolveFiles(
          Array.isArray(input.files) ? input.files.join(',') : input.files,
          cwd,
          ctx,
        )
      : input.path
        ? [await safeResolveReal(input.path, ctx)]
        : [];

    for (const absPath of fileList) {
      if (signal?.aborted) break;
      try {
        const content = await fs.readFile(absPath, 'utf8');
        filesProcessed++;
        const processed = processFile(
          content,
          absPath,
          style,
          input.overwrite ?? false,
          input.target ?? 'all',
        );
        results.push(...processed);
        itemsDocumented += processed.filter((r) => r.status === 'documented').length;
      } catch (e) {
        results.push({
          path: absPath,
          name: path.basename(absPath),
          signature: '',
          docstring: '',
          status: 'error',
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return {
      files_processed: filesProcessed,
      items_documented: itemsDocumented,
      results,
      style,
    };
  },
};

function getLineNumber(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

async function resolveFiles(filesInput: string, cwd: string, ctx: Context): Promise<string[]> {
  const files = filesInput.split(',');
  const resolved: string[] = [];

  for (const f of files) {
    const entry = f.trim();
    if (!entry) continue;
    let absPath: string;
    try {
      // Same containment as `input.path`: resolve relative entries against the
      // (already-contained) cwd and reject anything that escapes the project
      // root — including Windows absolute paths, which the old POSIX-only
      // leading-'/' check let through unresolved.
      absPath = ensureInsideRoot(path.resolve(cwd, entry), ctx);
    } catch {
      // Outside the project root — skip rather than read it.
      continue;
    }
    try {
      const stat = await fs.stat(absPath);
      if (stat.isFile()) resolved.push(absPath);
    } catch {
      // skip
    }
  }

  return [...new Set(resolved)];
}

function processFile(
  content: string,
  absPath: string,
  _style: string,
  _overwrite: boolean,
  target: string,
): DocumentedItem[] {
  const results: DocumentedItem[] = [];
  // These must be global — `String.prototype.matchAll` throws on a non-global
  // RegExp, which previously made processFile throw and report every file as an
  // error instead of returning documentation candidates.
  const functionRegex = /(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;
  const arrowRegex = /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>/g;
  const classRegex = /class\s+(\w+)/g;
  const typeRegex = /(?:type|interface)\s+(\w+)\s*[=<]/g;

  const allMatches: { name: string; sig: string; type: string; line: number }[] = [];

  if (target === 'all' || target === 'function') {
    for (const m of content.matchAll(functionRegex)) {
      /* v8 ignore next -- capture group (\w+) is mandatory, so m[1] is always defined; defensive. */
      if (!m[1]) continue;
      allMatches.push({
        name: m[1],
        sig: m[2] ?? '',
        type: 'function',
        line: getLineNumber(content, m.index),
      });
    }
    for (const m of content.matchAll(arrowRegex)) {
      /* v8 ignore next -- capture group (\w+) is mandatory, so m[1] is always defined; defensive. */
      if (!m[1]) continue;
      allMatches.push({
        name: m[1],
        sig: m[2] ?? '',
        type: 'arrow',
        line: getLineNumber(content, m.index),
      });
    }
  }

  if (target === 'all' || target === 'class') {
    for (const m of content.matchAll(classRegex)) {
      /* v8 ignore next -- capture group (\w+) is mandatory, so m[1] is always defined; defensive. */
      if (!m[1]) continue;
      allMatches.push({
        name: m[1],
        sig: '',
        type: 'class',
        line: getLineNumber(content, m.index),
      });
    }
  }

  if (target === 'all' || target === 'type') {
    for (const m of content.matchAll(typeRegex)) {
      /* v8 ignore next -- capture group (\w+) is mandatory, so m[1] is always defined; defensive. */
      if (!m[1]) continue;
      allMatches.push({
        name: m[1],
        sig: m[0] ?? '',
        type: 'type',
        line: getLineNumber(content, m.index),
      });
    }
  }

  for (const m of allMatches) {
    results.push({
      path: absPath,
      name: m.name,
      signature: m.sig,
      docstring: `/** ${m.name} - documented at line ${m.line} */`,
      status: 'skipped',
    });
  }

  return results;
}
