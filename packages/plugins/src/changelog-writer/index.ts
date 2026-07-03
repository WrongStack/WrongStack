/**
 * changelog-writer plugin — turns session activity into
 * Keep-a-Changelog entries.
 *
 * While the session runs, the plugin passively collects work signals
 * from the event bus: files touched by `write`/`edit`, and commit
 * subjects observed from `git_autocommit` / `bash git commit`
 * invocations. Commit subjects in conventional-commit format are
 * mapped to Keep-a-Changelog sections:
 *
 *   feat → Added · fix → Fixed · perf/refactor → Changed ·
 *   docs → Documentation · chore/build/ci → Maintenance ·
 *   revert/remove → Removed · sec/security → Security
 *
 * Tools:
 *  - `changelog_add`     — record an entry manually ("Added dark mode")
 *  - `changelog_preview` — render the pending Unreleased block
 *  - `changelog_write`   — merge the pending entries into
 *    `CHANGELOG.md` under `## [Unreleased]` (creates the file with a
 *    Keep-a-Changelog header when missing); pending entries are
 *    cleared after a successful write
 *
 * Both `changelog_preview` and `changelog_write` accept `polish: true`
 * to rewrite the block into user-facing release-notes wording via the
 * host LLM (`api.llm`) — provider/model follow the plugin's
 * `config.extensions['changelog-writer'].llm` override, then the
 * session default. Polish is best-effort: on any LLM failure (or when
 * the response stops looking like the block) the raw entries are used.
 *
 * Config (`config.extensions['changelog-writer']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "filePath": "CHANGELOG.md",
 *   "collectCommits": true,
 *   "maxEntries": 200
 * }
 * ```
 *
 * Toggle off with `{ "name": "changelog-writer", "enabled": false }`
 * in `config.plugins`, or `"enabled": false` in the options above.
 *
 * @public
 */

import { readFileSync, writeFileSync } from 'node:fs';
import type { Plugin } from '@wrongstack/core';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

type Section =
  | 'Added'
  | 'Changed'
  | 'Fixed'
  | 'Removed'
  | 'Security'
  | 'Documentation'
  | 'Maintenance';

export interface ChangelogEntry {
  section: Section;
  text: string;
  origin: 'commit' | 'manual';
  when: string;
}

interface ChangelogWriterState {
  entries: ChangelogEntry[];
  filesTouched: Set<string>;
  commitsSeen: number;
  writes: number;
  polishes: number;
  polishErrors: number;
  eventUnsubscribers: Array<() => void>;
}

const state: ChangelogWriterState = {
  entries: [],
  filesTouched: new Set(),
  commitsSeen: 0,
  writes: 0,
  polishes: 0,
  polishErrors: 0,
  eventUnsubscribers: [],
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface ChangelogWriterConfig {
  enabled: boolean;
  filePath: string;
  collectCommits: boolean;
  maxEntries: number;
}

const DEFAULTS: ChangelogWriterConfig = {
  enabled: true,
  filePath: 'CHANGELOG.md',
  collectCommits: true,
  maxEntries: 200,
};

function readConfig(raw: unknown): ChangelogWriterConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r['enabled'] !== false,
    filePath:
      typeof r['filePath'] === 'string' && r['filePath'].length > 0
        ? r['filePath']
        : DEFAULTS.filePath,
    collectCommits: r['collectCommits'] !== false,
    maxEntries:
      typeof r['maxEntries'] === 'number' && r['maxEntries'] >= 10
        ? r['maxEntries']
        : DEFAULTS.maxEntries,
  };
}

// ---------------------------------------------------------------------------
// Conventional-commit mapping
// ---------------------------------------------------------------------------

const TYPE_TO_SECTION: Record<string, Section> = {
  feat: 'Added',
  feature: 'Added',
  fix: 'Fixed',
  bugfix: 'Fixed',
  perf: 'Changed',
  refactor: 'Changed',
  style: 'Changed',
  docs: 'Documentation',
  doc: 'Documentation',
  chore: 'Maintenance',
  build: 'Maintenance',
  ci: 'Maintenance',
  test: 'Maintenance',
  revert: 'Removed',
  remove: 'Removed',
  sec: 'Security',
  security: 'Security',
};

const SECTION_ORDER: Section[] = [
  'Added',
  'Changed',
  'Fixed',
  'Removed',
  'Security',
  'Documentation',
  'Maintenance',
];

/** Parse "feat(scope): add dark mode" → { section: Added, text: "add dark mode (scope)" }. */
export function commitToEntry(subject: string): { section: Section; text: string } {
  const m = /^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/.exec(subject.trim());
  if (m?.[1] && m[3]) {
    const section = TYPE_TO_SECTION[m[1].toLowerCase()] ?? 'Changed';
    const scope = m[2] ? ` (${m[2]})` : '';
    return { section, text: `${m[3].trim()}${scope}` };
  }
  return { section: 'Changed', text: subject.trim() };
}

/** Extract the commit subject from a `git commit -m "..."` command, if any. */
export function commitSubjectFromCommand(command: string): string | null {
  if (!/\bgit\s+commit\b/.test(command)) return null;
  const m = /-m\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  const subject = m?.[1] ?? m?.[2] ?? m?.[3] ?? null;
  if (!subject) return null;
  // Multi-line -m payloads: only the first line is the subject.
  return subject.split('\n')[0]?.trim() || null;
}

// ---------------------------------------------------------------------------
// Markdown rendering / merging
// ---------------------------------------------------------------------------

const CHANGELOG_HEADER = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]
`;

export function renderUnreleasedBlock(entries: ChangelogEntry[]): string {
  const bySection = new Map<Section, string[]>();
  for (const e of entries) {
    const list = bySection.get(e.section) ?? [];
    // Dedupe identical lines (same fix recorded from commit + manual).
    if (!list.includes(e.text)) list.push(e.text);
    bySection.set(e.section, list);
  }
  const parts: string[] = [];
  for (const section of SECTION_ORDER) {
    const items = bySection.get(section);
    if (!items || items.length === 0) continue;
    parts.push(`### ${section}`);
    parts.push(...items.map((t) => `- ${t}`));
    parts.push('');
  }
  return parts.join('\n').trimEnd();
}

/**
 * Merge a rendered Unreleased block into existing changelog content:
 * inserted directly under `## [Unreleased]` (existing unreleased
 * content is preserved below the new lines). Creates the standard
 * header when the file has no Unreleased heading.
 */
export function mergeIntoChangelog(existing: string | null, block: string): string {
  if (!existing?.trim()) {
    return `${CHANGELOG_HEADER}\n${block}\n`;
  }
  const unreleasedRe = /^##\s*\[?unreleased\]?.*$/im;
  const m = unreleasedRe.exec(existing);
  if (!m || m.index === undefined) {
    // No Unreleased section — insert one after the first H1 (or at top).
    const h1 = /^#\s.*$/m.exec(existing);
    if (h1 && h1.index !== undefined) {
      const insertAt = h1.index + h1[0].length;
      return `${existing.slice(0, insertAt)}\n\n## [Unreleased]\n\n${block}\n${existing.slice(insertAt)}`;
    }
    return `## [Unreleased]\n\n${block}\n\n${existing}`;
  }
  const insertAt = m.index + m[0].length;
  return `${existing.slice(0, insertAt)}\n\n${block}\n${existing.slice(insertAt)}`;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'changelog-writer',
  version: '0.1.0',
  description:
    'Collects session work (commits, edits, manual notes) and writes Keep-a-Changelog entries under [Unreleased] on demand',
  apiVersion: '^0.1.10',
  capabilities: { tools: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true, description: 'Master switch.' },
      filePath: {
        type: 'string',
        default: 'CHANGELOG.md',
        description: 'Changelog file path (relative to the session cwd or absolute).',
      },
      collectCommits: {
        type: 'boolean',
        default: true,
        description: 'Auto-collect entries from conventional commit subjects seen this session.',
      },
      maxEntries: {
        type: 'number',
        minimum: 10,
        default: 200,
        description: 'Cap on pending entries held in memory.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.entries = [];
    state.filesTouched = new Set();
    state.commitsSeen = 0;
    state.writes = 0;
    for (const off of state.eventUnsubscribers) {
      try {
        off();
      } catch {
        // best-effort
      }
    }
    state.eventUnsubscribers = [];

    const cfg = readConfig(api.config.extensions?.['changelog-writer']);

    const addEntry = (entry: ChangelogEntry): void => {
      state.entries.push(entry);
      if (state.entries.length > cfg.maxEntries) {
        state.entries.splice(0, state.entries.length - cfg.maxEntries);
      }
    };

    // Rewrite the rendered block into user-facing wording via the host
    // LLM. Best-effort: any failure (no api.llm, provider error, or a
    // response that no longer looks like a Keep-a-Changelog block)
    // falls back to the raw block — a polish must never lose entries.
    const maybePolish = async (block: string, polish: boolean): Promise<string> => {
      if (!polish || !block || !api.llm) return block;
      try {
        const result = await api.llm.complete(
          'Rewrite this Keep-a-Changelog block into concise, user-facing release-notes wording. ' +
            'Keep the EXACT markdown structure: the same "### Section" headings, one "- " bullet per entry, ' +
            'no entries added or removed. Output ONLY the markdown block.\n\n' +
            block,
          { system: 'You are a precise technical release-notes editor.', maxTokens: 1_500 },
        );
        const text = result.text.trim();
        if (!text.startsWith('###')) return block;
        state.polishes += 1;
        api.metrics.counter('polishes');
        return text;
      } catch {
        state.polishErrors += 1;
        return block;
      }
    };

    // ── Passive collection from the event bus ─────────────────────────
    if (cfg.enabled && cfg.collectCommits) {
      const off = api.onPattern('tool.*', (eventName: string, payload: unknown) => {
        if (!/completed|result|executed/.test(eventName)) return;
        const p = payload as {
          tool?: string;
          name?: string;
          input?: Record<string, unknown>;
          isError?: boolean;
        } | null;
        if (p?.isError) return;
        const toolName = p?.tool ?? p?.name ?? '';
        const input = p?.input ?? {};
        if (toolName === 'write' || toolName === 'edit') {
          const raw = input['path'] ?? input['file_path'] ?? input['filePath'];
          if (typeof raw === 'string' && raw) state.filesTouched.add(raw);
          return;
        }
        if (toolName === 'bash' || toolName === 'exec') {
          const command = typeof input['command'] === 'string' ? input['command'] : '';
          const subject = command ? commitSubjectFromCommand(command) : null;
          if (subject) {
            state.commitsSeen += 1;
            api.metrics.counter('commits_seen');
            const { section, text } = commitToEntry(subject);
            addEntry({ section, text, origin: 'commit', when: new Date().toISOString() });
          }
        }
      });
      state.eventUnsubscribers.push(off);
    }

    // ── changelog_add ─────────────────────────────────────────────────
    api.tools.register({
      name: 'changelog_add',
      description:
        'Record a changelog entry for the pending [Unreleased] block (written later via changelog_write).',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The entry text, user-facing wording.' },
          section: {
            type: 'string',
            enum: SECTION_ORDER,
            description: 'Keep-a-Changelog section (default Changed).',
          },
        },
        required: ['text'],
      },
      permission: 'auto',
      category: 'Docs',
      mutating: false,
      async execute(input: { text: string; section?: string | undefined }) {
        if (!cfg.enabled) return { ok: false, error: 'changelog-writer is disabled' };
        const text = String(input.text ?? '').trim();
        if (!text) return { ok: false, error: 'entry text must not be empty' };
        const section = SECTION_ORDER.includes(input.section as Section)
          ? (input.section as Section)
          : 'Changed';
        addEntry({ section, text, origin: 'manual', when: new Date().toISOString() });
        return { ok: true, pendingEntries: state.entries.length };
      },
    });

    // ── changelog_preview ─────────────────────────────────────────────
    api.tools.register({
      name: 'changelog_preview',
      description:
        'Render the pending [Unreleased] changelog block collected this session without writing anything. Pass polish:true to rewrite entries into user-facing wording via the LLM.',
      inputSchema: {
        type: 'object',
        properties: {
          polish: {
            type: 'boolean',
            description: 'Rewrite entries into user-facing wording via the LLM (api.llm).',
          },
        },
      },
      permission: 'auto',
      category: 'Docs',
      mutating: false,
      async execute(input: { polish?: boolean | undefined }) {
        const raw = renderUnreleasedBlock(state.entries);
        const markdown = raw ? await maybePolish(raw, input.polish === true) : '';
        return {
          ok: true,
          enabled: cfg.enabled,
          filePath: cfg.filePath,
          pendingEntries: state.entries.length,
          filesTouched: [...state.filesTouched].slice(0, 50),
          commitsSeen: state.commitsSeen,
          polished: input.polish === true && markdown !== raw,
          llmAvailable: Boolean(api.llm),
          markdown: markdown || '(no pending entries)',
        };
      },
    });

    // ── changelog_write ───────────────────────────────────────────────
    api.tools.register({
      name: 'changelog_write',
      description:
        'Merge the pending entries into the changelog file under ## [Unreleased] (creates the file when missing). Clears pending entries on success. Pass polish:true to rewrite entries into user-facing wording via the LLM first.',
      inputSchema: {
        type: 'object',
        properties: {
          polish: {
            type: 'boolean',
            description:
              'Rewrite entries into user-facing wording via the LLM (api.llm) before writing.',
          },
        },
      },
      permission: 'confirm',
      category: 'Docs',
      mutating: true,
      async execute(input: { polish?: boolean | undefined }) {
        if (!cfg.enabled) return { ok: false, error: 'changelog-writer is disabled' };
        if (state.entries.length === 0) {
          return { ok: false, error: 'no pending entries — add some with changelog_add first' };
        }
        const block = await maybePolish(
          renderUnreleasedBlock(state.entries),
          input.polish === true,
        );
        let existing: string | null = null;
        try {
          existing = readFileSync(cfg.filePath, 'utf-8');
        } catch {
          existing = null;
        }
        try {
          writeFileSync(cfg.filePath, mergeIntoChangelog(existing, block));
        } catch (err) {
          return {
            ok: false,
            error: `failed to write ${cfg.filePath}: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        const written = state.entries.length;
        state.entries = [];
        state.writes += 1;
        api.metrics.counter('writes');
        return {
          ok: true,
          filePath: cfg.filePath,
          entriesWritten: written,
          created: existing === null,
        };
      },
    });

    api.log.info('changelog-writer plugin loaded', {
      version: '0.1.0',
      enabled: cfg.enabled,
      filePath: cfg.filePath,
      collectCommits: cfg.collectCommits,
    });
  },

  teardown(api) {
    for (const off of state.eventUnsubscribers) {
      try {
        off();
      } catch {
        // best-effort
      }
    }
    state.eventUnsubscribers = [];
    const final = {
      pendingEntries: state.entries.length,
      commitsSeen: state.commitsSeen,
      writes: state.writes,
      filesTouched: state.filesTouched.size,
    };
    state.entries = [];
    state.filesTouched = new Set();
    state.commitsSeen = 0;
    state.writes = 0;
    api.log.info('changelog-writer: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message: `changelog-writer: ${state.entries.length} pending entr(ies), ${state.commitsSeen} commit(s) collected, ${state.writes} write(s)`,
      counters: {
        pendingEntries: state.entries.length,
        commitsSeen: state.commitsSeen,
        writes: state.writes,
        filesTouched: state.filesTouched.size,
      },
    };
  },
};

export default plugin;
