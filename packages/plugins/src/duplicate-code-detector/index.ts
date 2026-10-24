import type { DuplicateFinding } from './duplicate-code-analysis.js';
import {
  DEFAULTS,
  evictHookIndex,
  extractFingerprintHashes,
  HOOK_WARNING_COOLDOWN_MS,
  hookIndexBudgets,
  isWithinRoot,
  readConfig,
  relativePath,
  scanPath,
  state,
} from './duplicate-code-analysis.js';

export { hashFingerprint, hookIndexBudgets } from './duplicate-code-analysis.js';

/**
 * duplicate-code-detector plugin — finds duplicated code blocks across source
 * files using normalized-line fingerprinting.
 *
 * Tools registered:
 * - detect_duplicate_code : Scan a path for duplicated blocks.
 * - duplicate_code_status : Report config + counters.
 *
 * Hooks registered:
 * - PostToolUse with matcher `write|edit` to source files, warning when the
 *   changed file introduces blocks that duplicate existing code elsewhere.
 *
 * Config (`config.extensions['duplicate-code-detector']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "minLines": 5,
 *   "threshold": 0.8,
 *   "extensions": [".ts", ".tsx", ".js", ".jsx"],
 *   "excludeDirs": ["node_modules", "dist", ".git", "coverage"],
 *   "maxFindings": 20
 * }
 * ```
 *
 * @public
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import { type Plugin, ToolValidationError } from '@wrongstack/contracts/types';
import { collectSourceFilesAsync, withinProject } from '../runtime/index.js';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'duplicate-code-detector',
  version: '0.1.0',
  description:
    'Finds duplicated code blocks across source files using normalized-line fingerprinting',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true, description: 'Master switch.' },
      minLines: {
        type: 'number',
        minimum: 2,
        maximum: 100,
        default: 8,
        description: 'Minimum number of consecutive lines to form a block.',
      },
      threshold: {
        type: 'number',
        minimum: 0.01,
        maximum: 1,
        default: 0.8,
        description: 'Similarity threshold (currently exact-match only).',
      },
      extensions: {
        type: 'array',
        items: { type: 'string' },
        default: ['.ts', '.tsx', '.js', '.jsx'],
        description: 'File extensions to scan.',
      },
      excludeDirs: {
        type: 'array',
        items: { type: 'string' },
        default: ['node_modules', 'dist', '.git', 'coverage'],
        description: 'Directory names to skip while scanning.',
      },
      maxFindings: {
        type: 'number',
        minimum: 1,
        maximum: 500,
        default: DEFAULTS.maxFindings,
        description: 'Maximum duplicate groups reported per scan.',
      },
    },
  },

  setup(api) {
    state.scanCount = 0;
    state.findingCount = 0;
    state.hookInvocationCount = 0;
    state.warningCount = 0;
    state.errorCount = 0;
    state.lastHookWarning.clear();
    state.fileIndex.clear();
    state.indexFingerprintCount = 0;
    state.hookIndexEvictions = 0;
    state.oversizedFileSkips = 0;
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['duplicate-code-detector']);
    const extensionsSet = new Set(cfg.extensions);

    /**
     * Cached read of a file's fingerprint HASH set. stat() then either return the
     * cached `Set<number>` (when mtime+size match) or read + extract + hash + cache.
     * Only compact numeric hashes are retained — never the snippet/fingerprint text.
     * Cheap stat() cost per unchanged file; only changed files pay read + extract.
     *
     * Files larger than `hookIndexBudgets.maxFileBytes` are skipped (empty set, not cached).
     * Returns null only if the file is unreadable/unstattable.
     */
    async function readCachedFingerprints(
      filePath: string,
      minLines: number,
    ): Promise<Set<number> | null> {
      let st: { mtimeMs: number; size: number };
      try {
        st = await stat(filePath);
      } catch {
        return null;
      }
      const cached = state.fileIndex.get(filePath);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        // LRU touch: re-insert to mark most-recently-used (moves to Map tail).
        state.fileIndex.delete(filePath);
        state.fileIndex.set(filePath, cached);
        return cached.fingerprints;
      }
      // Never read/extract oversized files — they'd dominate the index and the read.
      if (st.size > hookIndexBudgets.maxFileBytes) {
        if (cached) {
          state.indexFingerprintCount -= cached.fingerprints.size;
          state.fileIndex.delete(filePath);
        }
        state.oversizedFileSkips += 1;
        api.log.trace('duplicate-code-detector: skipped oversized file in hook index', {
          file: relativePath(filePath),
          sizeBytes: st.size,
          maxFileBytes: hookIndexBudgets.maxFileBytes,
        });
        return new Set();
      }
      let content: string;
      try {
        content = await readFile(filePath, 'utf-8');
      } catch {
        return null;
      }
      const fingerprints = extractFingerprintHashes(
        content,
        minLines,
        hookIndexBudgets.maxFingerprintsPerFile,
      );
      // Update the running fingerprint count, replacing any prior entry's contribution.
      if (cached) state.indexFingerprintCount -= cached.fingerprints.size;
      state.fileIndex.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, fingerprints });
      state.indexFingerprintCount += fingerprints.size;
      evictHookIndex();
      return fingerprints;
    }

    const hook = async (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { content: string; isError: boolean } | undefined;
    }): Promise<{
      decision?: 'block';
      reason?: string;
      additionalContext?: string;
      contextAs?: 'inline' | 'separate';
    } | void> => {
      if (!cfg.enabled) return;
      if (input.toolResult?.isError) return;

      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      const rawSource =
        inp['path'] ??
        inp['TargetFile'] ??
        inp['filePath'] ??
        inp['file_path'] ??
        inp['targetFile'] ??
        inp['file'];
      const sourcePath = typeof rawSource === 'string' ? rawSource : undefined;
      if (!sourcePath || typeof sourcePath !== 'string') return;

      // Snapshot cwd once, resolve against that root, then canonicalize before
      // any stat/read/cache operation. This prevents cwd changes or symlinks
      // from redirecting the persistent fingerprint index outside the project.
      const projectRoot = resolve(process.cwd());
      const resolvedFile = isAbsolute(sourcePath)
        ? resolve(sourcePath)
        : resolve(projectRoot, sourcePath);
      if (!isWithinRoot(projectRoot, resolvedFile)) return;
      let changedFile: string;
      try {
        changedFile = await realpath(resolvedFile);
      } catch {
        state.errorCount += 1;
        return;
      }
      if (!isWithinRoot(projectRoot, changedFile)) return;

      const ext = extname(sourcePath).toLowerCase();
      // Performance: uses Set.has() for O(1) lookup instead of Array.includes() O(n).
      if (!extensionsSet.has(ext)) return;

      state.hookInvocationCount += 1;

      // Throttle repeated warnings for the same file within one minute.
      // Bulk tools like `replace` can touch many files in quick succession;
      // we still report the total count, but we don't repeat the same message
      // for the same file on every edit.
      const now = Date.now();
      const lastWarning = state.lastHookWarning.get(changedFile);
      if (lastWarning !== undefined && now - lastWarning < HOOK_WARNING_COOLDOWN_MS) return;

      const changedFps = await readCachedFingerprints(changedFile, cfg.minLines);
      if (changedFps === null) {
        state.errorCount += 1;
        return;
      }
      if (changedFps.size === 0) return;

      let otherFilePaths: string[];
      try {
        otherFilePaths = await collectSourceFilesAsync(projectRoot, {
          extensions: cfg.extensions,
          excludeDirs: cfg.excludeDirs,
        });
      } catch {
        state.errorCount += 1;
        return;
      }

      // Compare fingerprint HASH sets instead of concatenating every file's
      // windows into one array (the old per-fire memory spike). Unchanged files
      // pay only a stat(); changed files pay read + extract + hash. `matched`
      // holds the changed-file fingerprints already found elsewhere (deduped),
      // so the count preserves the old "number of changed blocks duplicated
      // elsewhere" semantic without retaining any snippet text.
      const matched = new Set<number>();
      const resolvedChanged = resolve(changedFile).toLowerCase();
      for (const p of otherFilePaths) {
        // Keep the changed file out even if collection/filtering is refactored.
        if (resolve(p).toLowerCase() === resolvedChanged) continue;
        const otherFps = await readCachedFingerprints(p, cfg.minLines);
        if (otherFps === null || otherFps.size === 0) continue;
        for (const fp of changedFps) {
          if (!matched.has(fp) && otherFps.has(fp)) matched.add(fp);
        }
        if (matched.size === changedFps.size) break;
      }

      if (matched.size === 0) return;

      state.warningCount += matched.size;
      state.lastHookWarning.set(changedFile, now);
      return {
        additionalContext:
          `⚠️ duplicate-code-detector: ${sourcePath} contains ${matched.size} block(s) already present elsewhere. ` +
          `Run detect_duplicate_code for details.`,
        contextAs: 'separate',
      };
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook, {
      background: true,
    });

    // --- detect_duplicate_code tool ---
    api.tools.register({
      name: 'detect_duplicate_code',
      description:
        'Scan source files for duplicated code blocks. Uses normalized-line fingerprinting to find identical multi-line blocks across files.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', default: '.', description: 'Directory or file path to scan.' },
        },
      },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute(input: { path?: string }) {
        if (!cfg.enabled) throw new Error('duplicate-code-detector is disabled');

        const raw = input as Record<string, unknown>;
        const rawPath =
          (typeof raw['path'] === 'string' ? raw['path'] : undefined) ??
          (typeof raw['directory'] === 'string' ? raw['directory'] : undefined) ??
          (typeof raw['dir'] === 'string' ? raw['dir'] : undefined) ??
          (typeof raw['SearchDirectory'] === 'string' ? raw['SearchDirectory'] : undefined) ??
          (typeof raw['filePath'] === 'string' ? raw['filePath'] : undefined) ??
          (typeof raw['file_path'] === 'string' ? raw['file_path'] : undefined) ??
          (typeof raw['TargetFile'] === 'string' ? raw['TargetFile'] : undefined) ??
          (typeof raw['targetFile'] === 'string' ? raw['targetFile'] : undefined) ??
          (typeof raw['file'] === 'string' ? raw['file'] : undefined) ??
          '.';
        if (!withinProject(rawPath)) {
          throw new ToolValidationError({
            message: 'scan path is outside the project root',
            field: 'path',
          });
        }

        state.scanCount += 1;
        let result: { findings: DuplicateFinding[]; scannedFiles: number };
        try {
          // A missing path would otherwise walk nothing and read as no duplicates.
          await stat(resolve(process.cwd(), rawPath));
          result = await scanPath(rawPath, cfg);
        } catch (err) {
          state.errorCount += 1;
          throw new Error(
            `detect_duplicate_code failed for ${rawPath}: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }

        state.findingCount += result.findings.length;
        return {
          ok: true,
          path: relativePath(resolve(process.cwd(), rawPath)),
          scannedFiles: result.scannedFiles,
          minLines: cfg.minLines,
          findings: result.findings,
        };
      },
    });

    // --- duplicate_code_status tool ---
    api.tools.register({
      name: 'duplicate_code_status',
      description: 'Reports duplicate-code-detector state: config + counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          minLines: cfg.minLines,
          threshold: cfg.threshold,
          extensions: cfg.extensions,
          excludeDirs: cfg.excludeDirs,
          maxFindings: cfg.maxFindings,
          counters: {
            scans: state.scanCount,
            findings: state.findingCount,
            hookInvocations: state.hookInvocationCount,
            warnings: state.warningCount,
            errors: state.errorCount,
            // Hook fingerprint-index footprint (bounded; see hookIndexBudgets).
            indexedFiles: state.fileIndex.size,
            indexedFingerprints: state.indexFingerprintCount,
            hookIndexEvictions: state.hookIndexEvictions,
            oversizedFileSkips: state.oversizedFileSkips,
            // Rough retained-bytes estimate: ~8B per numeric fingerprint + ~120B
            // per file entry (key string + Set/entry overhead). Compact by design.
            approxIndexBytes: state.indexFingerprintCount * 8 + state.fileIndex.size * 120,
          },
        };
      },
    });

    api.log.info('duplicate-code-detector plugin loaded', {
      version: '0.1.0',
      minLines: cfg.minLines,
      extensions: cfg.extensions,
    });
  },

  teardown(api) {
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }
    const final = {
      scans: state.scanCount,
      findings: state.findingCount,
      hookInvocations: state.hookInvocationCount,
      warnings: state.warningCount,
      errors: state.errorCount,
    };
    state.scanCount = 0;
    state.findingCount = 0;
    state.hookInvocationCount = 0;
    state.warningCount = 0;
    state.errorCount = 0;
    state.lastHookWarning.clear();
    state.fileIndex.clear();
    state.indexFingerprintCount = 0;
    state.hookIndexEvictions = 0;
    state.oversizedFileSkips = 0;
    api.log.info('duplicate-code-detector: teardown complete', { final });
  },

  async health() {
    return {
      ok: state.errorCount === 0,
      message: state.errorCount
        ? `duplicate-code-detector: ${state.errorCount} error(s)`
        : `duplicate-code-detector: ${state.scanCount} scan(s), ${state.findingCount} duplicate group(s)`,
      counters: {
        scans: state.scanCount,
        findings: state.findingCount,
        hookInvocations: state.hookInvocationCount,
        warnings: state.warningCount,
        errors: state.errorCount,
        indexedFiles: state.fileIndex.size,
        indexedFingerprints: state.indexFingerprintCount,
        hookIndexEvictions: state.hookIndexEvictions,
        oversizedFileSkips: state.oversizedFileSkips,
      },
    };
  },
};

export default plugin;
