import * as fs from 'node:fs/promises';
import type { Tool } from '@wrongstack/core';
import { safeResolve } from './_util.js';

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
    'Preview documentation comments (JSDoc/TSDoc style) that would be generated for code symbols. ' +
    'Returns a list of candidates with status `skipped` — the tool is currently a read-only preview and does NOT write to files.',
  usageHint:
    'USE FOR IMPROVING CODE DOCUMENTATION:\n\n' +
    '- Good for adding missing docs to public APIs or complex functions.\n' +
    '- Currently this is a PREVIEW-ONLY tool: it does not modify files.\n' +
    '- Use the output to decide which symbols to document manually, or pass the candidates to `edit` / `patch`.\n' +
    '- `overwrite`, `style`, and `target` parameters are accepted for future expansion but are ignored today.\n' +
    'Always review the proposed documentation before applying it — the model can hallucinate details.',
  permission: 'auto',
  mutating: false,
  timeoutMs: 30_000,
  capabilities: ['fs.read'],
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
      overwrite: {
        type: 'boolean',
        description: 'Overwrite existing docstrings (default: false)',
      },
      cwd: { type: 'string', description: 'Working directory (default: cwd)' },
    },
  },
  async execute(input, ctx) {
    const cwd = input.cwd ? safeResolve(input.cwd, ctx) : ctx.cwd;
    const style = input.style ?? 'jsdoc';
    const results: DocumentedItem[] = [];
    let filesProcessed = 0;
    let itemsDocumented = 0;

    const fileList = input.files
      ? await resolveFiles(Array.isArray(input.files) ? input.files.join(',') : input.files, cwd)
      : input.path
        ? [safeResolve(input.path, ctx)]
        : [];

    for (const absPath of fileList) {
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
          name: absPath.split('/').pop() ?? absPath,
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

async function resolveFiles(filesInput: string, cwd: string): Promise<string[]> {
  const files = Array.isArray(filesInput) ? filesInput : filesInput.split(',');
  const resolved: string[] = [];

  for (const f of files) {
    const absPath = f.trim().startsWith('/') ? f.trim() : `${cwd}/${f.trim()}`;
    try {
      const stat = await fs.stat(absPath);
      if (stat.isFile()) resolved.push(absPath);
    } catch {
      // skip
    }
  }

  return resolved;
}

function processFile(
  content: string,
  absPath: string,
  _style: string,
  _overwrite: boolean,
  target: string,
): DocumentedItem[] {
  const results: DocumentedItem[] = [];
  const functionRegex = /(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;
  const arrowRegex = /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>/g;
  const classRegex = /class\s+(\w+)/g;
  const typeRegex = /(?:type|interface)\s+(\w+)\s*[=<]/g;

  const allMatches: { name: string; sig: string; type: string; line: number }[] = [];

  if (target === 'all' || target === 'function') {
    for (const m of content.matchAll(functionRegex)) {
      if (!m[1]) continue;
      allMatches.push({
        name: m[1],
        sig: m[2] ?? '',
        type: 'function',
        line: content.slice(0, m.index).split('\n').length,
      });
    }
    for (const m of content.matchAll(arrowRegex)) {
      if (!m[1]) continue;
      allMatches.push({
        name: m[1],
        sig: m[2] ?? '',
        type: 'arrow',
        line: content.slice(0, m.index).split('\n').length,
      });
    }
  }

  if (target === 'all' || target === 'class') {
    for (const m of content.matchAll(classRegex)) {
      if (!m[1]) continue;
      allMatches.push({
        name: m[1],
        sig: '',
        type: 'class',
        line: content.slice(0, m.index).split('\n').length,
      });
    }
  }

  if (target === 'all' || target === 'type') {
    for (const m of content.matchAll(typeRegex)) {
      if (!m[1]) continue;
      allMatches.push({
        name: m[1],
        sig: m[0] ?? '',
        type: 'type',
        line: content.slice(0, m.index).split('\n').length,
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
