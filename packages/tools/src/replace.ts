import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/contracts/types';
import { ToolValidationError } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import {
  atomicWrite,
  compilePathGlob,
  detectNewlineStyle,
  expectDefined,
  normalizeToLf,
  toStyle,
  unifiedDiff,
} from '@wrongstack/core/utils';
import { mapWithConcurrency } from './_concurrency.js';
import { compileUserRegex } from './_regex.js';
import {
  isBinaryBuffer,
  isValidUtf8,
  sha256hex,
  truncateDiffPayload,
  withPathLock,
} from './_util.js';
import { enqueueReindex } from './codebase-index/background-indexer.js';

import { assertUsableGlobFilter, resolveFiles } from './replace-file-resolution.js';

export { __resetRgDetectionForTests } from './replace-file-resolution.js';

/** Byte budget for the combined per-file diff payload — matches `maxOutputBytes`. */
const MAX_DIFF_BYTES = 262_144;

export interface ReplaceInput {
  pattern: string;
  replacement: string;
  files: string | string[];
  glob?: string | undefined;
  replace_all?: boolean | undefined;
  dry_run?: boolean | undefined;
}

export interface ReplaceOutput {
  files_modified: number;
  total_replacements: number;
  results: { path: string; replacements: number; diff?: string | undefined }[];
  dry_run: boolean;
  /** Set when the combined diff payload was truncated to the output budget. */
  note?: string | undefined;
}

export const replaceTool: Tool<ReplaceInput, ReplaceOutput> = {
  name: 'replace',
  category: 'Transform',
  description:
    'Perform a search-and-replace across multiple files using a regex pattern. ' +
    'This is a powerful bulk transformation tool. Dry-run is ON by default — set `dry_run: false` to apply changes.',
  usageHint:
    'DANGEROUS IF USED CARELESSLY — review the diff output carefully.\n\n' +
    'Recommended workflow:\n' +
    '1. Run without `dry_run: false` first to see exactly what would change (dry-run is the default).\n' +
    '2. Review the diff output, then re-run with `dry_run: false` to apply.\n' +
    '3. Use a specific enough `pattern` (and `glob` / `files`) to avoid accidental broad changes.\n' +
    '4. `replace_all` controls whether only the first match per file or all matches are replaced.\n' +
    '5. `replacement` supports regex substitutions: `$1`–`$9` insert capture groups, `$&` inserts the whole match, and `$$` inserts a literal dollar sign.\n' +
    'This tool is excellent for large-scale refactors (renaming, import updates, etc.) but must be used with caution.',
  permission: 'confirm',
  // WS-046: gives permission decisions something to key on.
  // The file scope being rewritten, not the pattern: a trust rule should say
  // where a bulk replace may run.
  subjectKey: 'files',
  mutating: true,
  capabilities: ['fs.write'],
  icon: 'edit',
  timeoutMs: 30_000,
  maxOutputBytes: 262_144,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to match' },
      replacement: {
        type: 'string',
        description:
          'Replacement string. Supports `$1`–`$9` (capture groups), `$&` (whole match), and `$$` (literal dollar sign) — same semantics as JavaScript String.replace.',
      },
      files: {
        type: 'string',
        description: 'File(s) to target: single path, comma-separated list, or glob pattern',
      },
      glob: { type: 'string', description: 'Additional glob filter (e.g. "*.ts")' },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences in each file (default: true)',
      },
      dry_run: { type: 'boolean', description: 'Preview changes without writing (default: true)' },
    },
    required: ['pattern', 'replacement', 'files'],
  },
  async execute(input: ReplaceInput, ctx: Context, opts?: { signal?: AbortSignal }) {
    if (!input?.pattern) {
      throw new ToolValidationError({
        message: 'replace: pattern is required',
        field: 'pattern',
      });
    }
    if (input.replacement === undefined) {
      throw new ToolValidationError({
        message: 'replace: replacement is required',
        field: 'replacement',
      });
    }
    if (!input?.files) {
      throw new ToolValidationError({
        message: 'replace: files is required',
        field: 'files',
      });
    }
    // Fail fast: the filter is compiled by core's matcher before any file is
    // read, and a filter it cannot express would otherwise narrow every entry
    // away and report zero modifications as a success.
    if (input.glob) assertUsableGlobFilter(input.glob);

    const signal = opts?.signal ?? ctx.signal;
    signal?.throwIfAborted();

    const replaceAll = input.replace_all ?? true;
    // Always compile with 'g' so matchAll() works — matchAll throws
    // TypeError on non-global regexes. The replaceAll flag controls
    // how many matches we act on, not whether the regex is global.
    const compiled = compileUserRegex(input.pattern, 'g');
    if (!compiled.ok) {
      throw new ToolValidationError({
        message: `replace: ${compiled.reason}`,
        field: 'pattern',
      });
    }
    const re = compiled.regex;
    const globRe = input.glob ? compilePathGlob(input.glob) : null;
    const dryRun = input.dry_run ?? true;

    const fileList = await resolveFiles(input.files, ctx, globRe);

    // Resolve the project root through realpath ONCE so the sandbox check
    // below compares like-for-like with realpath(file). The project root
    // itself can be a symlink or short name — e.g. macOS temp dirs live under
    // /var -> /private/var, and Windows CI runners expose an 8.3 short name
    // (C:\Users\RUNNER~1\...). Comparing realpath(file) against the raw root
    // then makes every legitimately-inside file look "outside" and skips it.
    const realRoot = await fs.realpath(ctx.projectRoot).catch(() => ctx.projectRoot);

    const fileResults = await mapWithConcurrency(fileList, 16, async (absPath) => {
      signal?.throwIfAborted();
      // Use lstat to detect symlinks. resolveFiles already applies
      // safeResolve, but a symlink with a target outside the project
      // root would still pass that string check — explicitly skip it
      // so we never read or write through a link.
      const lstat = await fs.lstat(absPath).catch((err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        /* v8 ignore next -- non-ENOENT lstat failure (EACCES etc.) is a defensive rethrow. */
        throw err;
      });
      if (!lstat?.isFile()) return null;
      if (lstat.isSymbolicLink()) return null;

      // Cross-check via realpath: if the resolved target lives outside the
      // project root (e.g. a bind mount or a parent-dir traversal we missed),
      // skip rather than rewrite through it.
      let realPath: string;
      try {
        realPath = await fs.realpath(absPath);
      } catch {
        /* v8 ignore next -- realpath failing after a successful lstat is a TOCTOU race; defensive. */
        return null;
      }
      const rel = path.relative(realRoot, realPath);
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;

      // Read -> rewrite -> write runs alone per file: two agents in one
      // process would otherwise both rewrite the same original.
      return withPathLock(realPath, async () => {
        // Now stat the real target so we use its mode for atomicWrite.
        const stat = await fs.stat(realPath).catch(() => null);
        if (!stat?.isFile()) return null;

        let content: string;
        try {
          const buf = await fs.readFile(realPath);
          // Not UTF-8 text: rewriting it from a utf8 decode would corrupt every
          // non-ASCII byte, so it is skipped like a binary file.
          if (isBinaryBuffer(buf) || !isValidUtf8(buf)) return null;
          content = buf.toString('utf8');
        } catch {
          /* v8 ignore next -- readFile failing after a successful stat is a TOCTOU race; defensive. */
          return null;
        }

        const style = detectNewlineStyle(content);
        const contentLf = normalizeToLf(content);
        re.lastIndex = 0;
        const allMatches = [...contentLf.matchAll(re)];
        if (allMatches.length === 0) return null;

        // When replace_all is false, only act on the first match.
        const matches = replaceAll ? allMatches : allMatches.slice(0, 1);
        const count = matches.length;

        // Rebuild: single forward pass through matches to avoid quadratic intermediate string allocations.
        let newContentLf = '';
        let lastIdx = 0;
        for (let i = 0; i < matches.length; i++) {
          const m = expectDefined(matches[i]);
          const matchIdx = expectDefined(m.index);
          newContentLf +=
            contentLf.slice(lastIdx, matchIdx) + expandReplacement(input.replacement, m);
          lastIdx = matchIdx + m[0].length;
        }
        newContentLf += contentLf.slice(lastIdx);
        re.lastIndex = 0;

        if (!dryRun) {
          const newContent = toStyle(newContentLf, style);
          // Write to the real path (already validated inside project root)
          // so atomicWrite's temp-and-rename can't be redirected through a
          // freshly-planted symlink at absPath.
          signal?.throwIfAborted();
          await atomicWrite(realPath, newContent, { mode: stat.mode & 0o777 });
          // Same bookkeeping as `edit`: record the new mtime + hash (tagged
          // 'write' so the permission bypass does not widen) so a later `edit`
          // of this file doesn't trip the stale-read guard on our own write,
          // and record the change for session rewind. Optional calls: embedders
          // may hand in a duck-typed Context without these members.
          const written = await fs.stat(realPath).catch(() => null);
          if (written) {
            ctx.recordRead?.(realPath, written.mtimeMs, 'write', sha256hex(newContent));
          }
          ctx.session?.recordFileChange?.({
            path: realPath,
            action: 'modified',
            before: content,
            after: newContent,
          });
        }

        const isIdentical = newContentLf === contentLf;
        const rawDiff: string | undefined =
          dryRun || matches.length > 0
            ? isIdentical
              ? '(no-op: replacement produced identical content)'
              : unifiedDiff(content, toStyle(newContentLf, style), {
                  fromFile: absPath,
                  toFile: absPath,
                })
            : undefined;

        return {
          path: absPath,
          replacements: count,
          rawDiff,
          isIdentical,
        };
      });
    });

    const results: ReplaceOutput['results'] = [];
    let totalReplacements = 0;
    // Combined diff budget across all files: once spent, later diffs are
    // omitted (the summary counters still report every file).
    let diffBytesUsed = 0;
    let diffsOmitted = 0;
    let diffsTruncated = 0;

    for (const item of fileResults) {
      if (!item) continue;
      totalReplacements += item.replacements;

      let diff = item.rawDiff;
      if (diff !== undefined) {
        const remaining = MAX_DIFF_BYTES - diffBytesUsed;
        if (remaining <= 0) {
          diff = undefined;
          diffsOmitted++;
        } else {
          const capped = truncateDiffPayload(diff, remaining);
          if (capped.truncated) diffsTruncated++;
          diff = capped.text;
          diffBytesUsed += Buffer.byteLength(diff, 'utf8');
        }
      }

      results.push({
        path: item.path,
        replacements: item.replacements,
        diff,
      });
    }

    if (!dryRun && results.length > 0) {
      try {
        enqueueReindex({
          projectRoot: ctx.projectRoot,
          files: results.map((r) => r.path),
        });
      } catch {
        // Non-fatal background reindex
      }
    }

    const hasIdentical = fileResults.some((r) => r?.isIdentical);
    const overBudget = diffsOmitted > 0 || diffsTruncated > 0;
    const notes: string[] = [];
    if (overBudget) {
      notes.push(
        `Diff payload exceeded the 256 KiB output budget: ${diffsTruncated} diff(s) truncated, ` +
          `${diffsOmitted} diff(s) omitted. Replacement counts are complete; use the read tool to inspect individual files.`,
      );
    }
    if (hasIdentical && !overBudget) {
      notes.push(
        'Some replacements produced content identical to existing files (see no-op diff).',
      );
    }
    return {
      files_modified: results.length,
      total_replacements: totalReplacements,
      results,
      dry_run: dryRun,
      note: notes.length > 0 ? notes.join('\n') : undefined,
    };
  },
};

/**
 * Expand a replacement template against one regex match with JavaScript
 * `String.prototype.replace` semantics: `$1`–`$9` insert capture groups
 * (empty when the group did not participate), `$&` inserts the whole match,
 * and `$$` inserts a literal `$`. A `$` followed by anything else — or a
 * digit that exceeds the pattern's group count — stays literal, mirroring
 * String.replace.
 */
function expandReplacement(template: string, match: RegExpMatchArray): string {
  if (!template.includes('$')) return template;
  let out = '';
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch !== '$') {
      out += ch;
      continue;
    }
    const next = template[i + 1];
    if (next === '$') {
      out += '$';
      i++;
    } else if (next === '&') {
      out += match[0];
      i++;
    } else if (next !== undefined && next >= '1' && next <= '9') {
      const idx = next.charCodeAt(0) - 48;
      if (idx < match.length) {
        out += match[idx] ?? '';
        i++;
      } else {
        // Group does not exist in the pattern: keep `$N` literal.
        out += '$';
      }
    } else {
      out += '$';
    }
  }
  return out;
}
