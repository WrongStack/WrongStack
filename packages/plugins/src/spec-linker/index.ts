/**
 * spec-linker plugin — markdown link auditor for plugin references.
 *
 * Two hooks:
 *  1. **PostToolUse** on `write|edit` — READ-ONLY. Scans the saved
 *     file for unlinked plugin references and surfaces them to the
 *     LLM via `additionalContext`. The LLM decides whether to fix
 *     the file in a follow-up edit.
 *
 *  2. **PreToolUse** on `write` (NOT `edit`) — AUTO-FIX. When the
 *     `autoFix` config is `true`, scans the would-be content and
 *     returns a `modifiedInput.content` where each unlinked plugin
 *     reference is wrapped in a markdown link. The tool executor
 *     then writes the fixed content instead of the original.
 *
 * Why `write` only and not `edit`? The `edit` tool's input shape
 * is `{ path, old_string, new_string }` — `new_string` is a small
 * patch, not the whole file. To auto-fix `edit` cleanly we'd have
 * to either:
 *   - parse the file, find where `old_string` lives, substitute
 *     `new_string` with the auto-fixed version, and re-derive
 *     the new `old_string` (a hard string-diff problem), or
 *   - reject `edit` and force `write` (bad UX).
 * Both are too complex for the win. `write` is the common case
 * for new files; `edit` stays read-only and the PostToolUse
 * context tells the LLM what to fix.
 *
 * The plugin catalog is sourced from `../catalog.js` (single source
 * of truth — adding a new plugin to the catalog table there is
 * enough for this plugin to start detecting it).
 *
 * Config (`config.extensions['spec-linker']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "fileGlobs": ["**\/*.md", "**\/*.mdx"],
 *   "maxReferences": 8,
 *   "autoFix": false   // when true, PreToolUse on `write` wraps unlinked
 *                      // references in markdown links via modifiedInput
 * }
 * ```
 *
 * @public
 */

import * as fs from 'node:fs/promises';
import type { Plugin } from '@wrongstack/core/types';
import { releaseHandle } from '../runtime/index.js';
import { PLUGIN_CATALOG, PLUGIN_NAMES } from '../catalog.js';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface LinkerState {
  /** PostToolUse invocations for matching files. */
  postInvocations: number;
  /** PreToolUse invocations (autoFix path). */
  preInvocations: number;
  /** Times at least one unlinked reference was surfaced (Post). */
  unlinkedCount: number;
  /** Times no references were found (clean file or no plugins mentioned). */
  cleanCount: number;
  /** Times the file was not a markdown file (skipped). */
  skippedNonMd: number;
  /** Times the file could not be read (missing, etc.). */
  readErrorCount: number;
  /** Times autoFix was applied and references were wrapped. */
  autoFixApplied: number;
  /** Post hook handle for teardown. */
  postHookUnregister: null | (() => void);
  /** Pre hook handle for teardown. */
  preHookUnregister: null | (() => void);
}

const state: LinkerState = {
  postInvocations: 0,
  preInvocations: 0,
  unlinkedCount: 0,
  cleanCount: 0,
  skippedNonMd: 0,
  readErrorCount: 0,
  autoFixApplied: 0,
  postHookUnregister: null,
  preHookUnregister: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface SpecLinkerConfig {
  enabled: boolean;
  /** Glob-style extensions to scan. Defaults to markdown only. */
  fileGlobs: string[];
  /** Hard cap on the number of unlinked references in the injected context. */
  maxReferences: number;
  /**
   * When true, the PreToolUse hook on `write` wraps unlinked
   * references in markdown links via `modifiedInput.content`.
   * Default false (read-only by default; opt in for the
   * auto-fix convenience).
   */
  autoFix: boolean;
}

const DEFAULTS: SpecLinkerConfig = {
  enabled: true,
  fileGlobs: ['**/*.md', '**/*.mdx'],
  maxReferences: 8,
  autoFix: false,
};

function readConfig(raw: unknown): SpecLinkerConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r['enabled'] !== false,
    fileGlobs: Array.isArray(r['fileGlobs'])
      ? (r['fileGlobs'] as unknown[]).filter((g): g is string => typeof g === 'string')
      : DEFAULTS.fileGlobs,
    maxReferences:
      typeof r['maxReferences'] === 'number' && r['maxReferences'] > 0
        ? r['maxReferences']
        : DEFAULTS.maxReferences,
    autoFix: r['autoFix'] === true,
  };
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/** True if the file path matches any of the configured globs. */
function fileMatchesGlobs(filePath: string, globs: string[]): boolean {
  const lower = filePath.toLowerCase();
  return globs.some((g) => {
    // Translate `**\/*.md` → `**/*.md` (Windows path-safe)
    const normalized = g.replace(/\\/g, '/').toLowerCase();
    // Strip the `**/` prefix so we match the basename and any
    // subdirectory. So `**/*.md` matches `foo.md` and `x/y.md`.
    const pattern = normalized.replace(/^\*\*\//, '');
    // A simple extension match: `*.md` -> ends-with `.md`.
    if (pattern.startsWith('*.')) {
      return lower.endsWith(pattern.slice(1));
    }
    // Fallback: substring match.
    return lower.includes(pattern);
  });
}

/** True if `name` appears as a markdown link `[name](` or inline code `` `name` ``. */
function isWrappedAsLinkOrCode(line: string, name: string): boolean {
  const lower = line.toLowerCase();
  const target = name.toLowerCase();
  // Markdown link: [name](
  if (lower.includes(`[${target}](`)) return true;
  // Inline code: `name`
  if (lower.includes(`\`${target}\``)) return true;
  // Markdown link with label containing the name (e.g. [the `secret-scanner`
  // plugin](./src/secret-scanner))
  if (new RegExp(`\\[[^\\]]*\`${escapeRegExp(target)}\`[^\\]]*\\]\\(`, 'i').test(line)) return true;
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mapMarkdownFences(lines: string[]): boolean[] {
  const fenced = new Array<boolean>(lines.length).fill(false);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      fenced[i] = true;
      inFence = !inFence;
      continue;
    }
    fenced[i] = inFence;
  }
  return fenced;
}

/**
 * Find all unlinked plugin references on the given lines.
 * Returns a list of plugin names in their original casing.
 */
function findUnlinkedReferences(lines: string[], names: string[]): string[] {
  const found = new Map<string, true>(); // preserve original casing
  const fencedLines = mapMarkdownFences(lines);
  for (let i = 0; i < lines.length; i++) {
    if (fencedLines[i]) continue;
    const line = lines[i]!;
    if (line.length === 0) continue;
    for (const name of names) {
      // Word-boundary check: the name must appear as a complete
      // token, not as a substring of a longer identifier. We also
      // exclude hyphenated continuations (`secret-scanner-config`
      // should not match `secret-scanner`) and dot-continuations
      // (`secret-scanner.json`).
      const re = new RegExp(`(^|[^\\w-])${escapeRegExp(name)}(?![\\w-])`, 'i');
      if (re.test(line) && !isWrappedAsLinkOrCode(line, name)) {
        if (!found.has(name)) found.set(name, true);
      }
    }
  }
  return [...found.keys()];
}

/**
 * Replace each unlinked plugin reference in `content` with a
 * markdown link `[name](path)`. The replacement preserves the
 * original casing of each plugin name (case-insensitive match,
 * case-preserving substitution).
 *
 * The replacement is done in two passes per occurrence:
 *  1. Find the match range via the same word-boundary regex
 *     as `findUnlinkedReferences`.
 *  2. Skip if the line at the match contains a markdown link
 *     or inline code wrapping the name.
 *  3. Otherwise substitute `[name](path)`.
 *
 * Returns the rewritten content. If `content` is unchanged, the
 * returned string is `===` equal to the input — callers can use
 * that to skip the no-op write.
 */
function wrapUnlinkedReferences(content: string): string {
  const lines = content.split('\n');
  const fencedLines = mapMarkdownFences(lines);
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (fencedLines[i]) continue;
    const line = lines[i]!;
    if (line.length === 0) continue;
    const newLine = wrapLineReferences(line);
    if (newLine !== line) {
      lines[i] = newLine;
      changed = true;
    }
  }
  return changed ? lines.join('\n') : content;
}

function wrapLineReferences(line: string): string {
  let out = '';
  let cursor = 0;
  // Iterate over all plugin names; for each, walk the line and
  // find the leftmost non-overlapping match starting from the
  // current cursor. We rebuild the line as a sequence of
  // (raw, replacement) segments.
  type Span = { start: number; end: number; name: string };
  const spans: Span[] = [];

  for (const name of PLUGIN_NAMES) {
    // Case-insensitive match but preserve the original substring
    // for substitution. The `i` flag handles the match; the
    // capture group around the name lets us pull the original
    // casing back out without re-implementing the regex.
    const re = new RegExp(`(^|[^\\w-])(${escapeRegExp(name)})(?![\\w-])`, 'gi');
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic RegExp.exec loop
    while ((m = re.exec(line)) !== null) {
      const leadingLen = m[1]!.length;
      const nameStart = m.index + leadingLen;
      const nameEnd = nameStart + m[2]!.length;
      const originalName = line.slice(nameStart, nameEnd);
      if (isWrappedAsLinkOrCode(line, originalName)) continue;
      if (spans.some((s) => !(nameEnd <= s.start || nameStart >= s.end))) {
        continue;
      }
      spans.push({ start: nameStart, end: nameEnd, name: originalName });
      re.lastIndex = nameEnd;
    }
  }

  if (spans.length === 0) return line;

  spans.sort((a, b) => a.start - b.start);

  for (const span of spans) {
    out += line.slice(cursor, span.start);
    const path = PLUGIN_CATALOG.get(span.name.toLowerCase()) ?? `./src/${span.name.toLowerCase()}`;
    out += `[${span.name}](${path})`;
    cursor = span.end;
  }
  out += line.slice(cursor);
  return out;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'spec-linker',
  version: '0.2.0',
  description:
    'Markdown link auditor for plugin references. PostToolUse surfaces unlinked references; PreToolUse on `write` (autoFix) wraps them in markdown links via modifiedInput.',
  apiVersion: '^0.1.10',
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true, description: 'Master switch.' },
      fileGlobs: {
        type: 'array',
        items: { type: 'string' },
        default: DEFAULTS.fileGlobs,
        description: 'Glob patterns to match (markdown by default).',
      },
      maxReferences: {
        type: 'number',
        minimum: 1,
        maximum: 50,
        default: 8,
        description: 'Hard cap on the number of unlinked references in the injected context.',
      },
      autoFix: {
        type: 'boolean',
        default: false,
        description:
          'When true, the PreToolUse hook on `write` returns a `modifiedInput.content` where each unlinked plugin reference is wrapped in a markdown link. Default false (opt in).',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.postInvocations = 0;
    state.preInvocations = 0;
    state.unlinkedCount = 0;
    state.cleanCount = 0;
    state.skippedNonMd = 0;
    state.readErrorCount = 0;
    state.autoFixApplied = 0;
    state.postHookUnregister = releaseHandle(state.postHookUnregister);
    state.preHookUnregister = releaseHandle(state.preHookUnregister);

    const cfg = readConfig(api.config.extensions?.['spec-linker']);

    // ── PostToolUse: read-only audit ─────────────────────────────────
    const postHook = async (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { content: string; isError: boolean } | undefined;
    }): Promise<{ additionalContext?: string } | void> => {
      if (!cfg.enabled) return;
      if (input.toolResult?.isError) return;

      const toolName = input.toolName ?? '';
      if (toolName !== 'write' && toolName !== 'edit') return;

      const inp = (input.toolInput ?? {}) as { path?: string };
      const filePath = inp.path;
      if (!filePath || typeof filePath !== 'string') return;

      if (!fileMatchesGlobs(filePath, cfg.fileGlobs)) {
        state.skippedNonMd += 1;
        return;
      }

      state.postInvocations += 1;

      let content: string;
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) return;
        content = await fs.readFile(filePath, 'utf-8');
      } catch {
        state.readErrorCount += 1;
        return;
      }

      const unlinked = findUnlinkedReferences(content.split('\n'), [...PLUGIN_NAMES]);
      if (unlinked.length === 0) {
        state.cleanCount += 1;
        return;
      }

      state.unlinkedCount += 1;
      const limited = unlinked.slice(0, cfg.maxReferences);
      const overflow = unlinked.length - limited.length;

      const lines = limited
        .map(
          (name) => `- \`${name}\` → \`[${name}](${PLUGIN_CATALOG.get(name) ?? `./src/${name}`})\``,
        )
        .join('\n');
      const overflowNote = overflow > 0 ? `\n- …and ${overflow} more` : '';

      return {
        additionalContext:
          `\n🔗 spec-linker: ${unlinked.length} unlinked plugin reference(s) in '${filePath}'. ` +
          `Consider wrapping them in markdown links to keep the docs navigable:\n` +
          `${lines}${overflowNote}`,
      };
    };
    state.postHookUnregister = api.registerHook('PostToolUse', 'write|edit', postHook as never, { background: true });

    // ── PreToolUse: auto-fix on `write` only ─────────────────────────
    if (cfg.autoFix) {
      const preHook = async (input: {
        toolName?: string | undefined;
        toolInput?: unknown;
      }): Promise<{
        decision?: 'allow' | 'block';
        modifiedInput?: Record<string, unknown>;
        additionalContext?: string;
      } | void> => {
        if (!cfg.enabled) return;
        // Auto-fix targets `write` only — see file-level comment
        // for why we don't touch `edit` (partial-string complexity).
        if (input.toolName !== 'write') return;

        const inp = (input.toolInput ?? {}) as { path?: string; content?: string };
        const filePath = inp.path;
        if (!filePath || typeof filePath !== 'string') return;
        if (!fileMatchesGlobs(filePath, cfg.fileGlobs)) return;
        if (typeof inp.content !== 'string' || inp.content.length === 0) return;

        state.preInvocations += 1;
        const fixed = wrapUnlinkedReferences(inp.content);
        if (fixed === inp.content) return; // no-op

        state.autoFixApplied += 1;
        return {
          decision: 'allow',
          modifiedInput: { ...inp, content: fixed, path: filePath },
          additionalContext: `\n🔗 spec-linker (autoFix): wrapped unlinked plugin reference(s) in '${filePath}'.`,
        };
      };
      state.preHookUnregister = api.registerHook('PreToolUse', 'write', preHook as never, {
        name: 'spec-linker-autofix',
        stage: 'mutate',
        failurePolicy: 'open',
      });
    }

    // ── spec_linker_status tool ───────────────────────────────────────
    api.tools.register({
      name: 'spec_linker_status',
      description:
        'Reports spec-linker state: config, counters (post + pre hooks), and the canonical plugin catalog used for detection.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          fileGlobs: cfg.fileGlobs,
          maxReferences: cfg.maxReferences,
          autoFix: cfg.autoFix,
          counters: {
            postInvocations: state.postInvocations,
            preInvocations: state.preInvocations,
            unlinked: state.unlinkedCount,
            clean: state.cleanCount,
            skippedNonMd: state.skippedNonMd,
            readErrors: state.readErrorCount,
            autoFixApplied: state.autoFixApplied,
          },
          catalogSize: PLUGIN_NAMES.length,
        };
      },
    });

    api.log.info('spec-linker plugin loaded', {
      version: '0.2.0',
      enabled: cfg.enabled,
      fileGlobs: cfg.fileGlobs,
      autoFix: cfg.autoFix,
      catalogSize: PLUGIN_NAMES.length,
    });
  },

  teardown(api) {
    for (const off of [state.postHookUnregister, state.preHookUnregister]) {
      if (off) {
        try {
          off();
        } catch {
          // best-effort
        }
      }
    }
    state.postHookUnregister = null;
    state.preHookUnregister = null;
    const final = {
      postInvocations: state.postInvocations,
      preInvocations: state.preInvocations,
      unlinked: state.unlinkedCount,
      clean: state.cleanCount,
      skippedNonMd: state.skippedNonMd,
      readErrors: state.readErrorCount,
      autoFixApplied: state.autoFixApplied,
    };
    state.postInvocations = 0;
    state.preInvocations = 0;
    state.unlinkedCount = 0;
    state.cleanCount = 0;
    state.skippedNonMd = 0;
    state.readErrorCount = 0;
    state.autoFixApplied = 0;
    api.log.info('spec-linker: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message: `spec-linker: post=${state.postInvocations} pre=${state.preInvocations}, unlinked=${state.unlinkedCount}, autoFix=${state.autoFixApplied}, clean=${state.cleanCount}, non-md=${state.skippedNonMd}`,
      counters: {
        postInvocations: state.postInvocations,
        preInvocations: state.preInvocations,
        unlinked: state.unlinkedCount,
        clean: state.cleanCount,
        skippedNonMd: state.skippedNonMd,
        readErrors: state.readErrorCount,
        autoFixApplied: state.autoFixApplied,
      },
    };
  },
};

export default plugin;
