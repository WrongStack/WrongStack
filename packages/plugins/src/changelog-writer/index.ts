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
import { isAbsolute, relative, resolve } from 'node:path';
import { type Plugin, ToolValidationError } from '@wrongstack/contracts/types';
import { BoundedSet } from '../runtime/index.js';
import type { ChangelogEntry, Section } from './changelog-format.js';
import { mergeIntoChangelog, renderUnreleasedBlock, SECTION_ORDER } from './changelog-format.js';

export type { ChangelogEntry } from './changelog-format.js';
export { mergeIntoChangelog, renderUnreleasedBlock } from './changelog-format.js';

interface ChangelogWriterState {
  entries: ChangelogEntry[];
  /**
   * Paths touched this session. Bounded — an unbounded set grew one entry
   * per distinct file for the whole session; only the newest 50 are ever
   * reported, so retaining every path served no purpose.
   */
  filesTouched: BoundedSet<string>;
  commitsSeen: number;
  writes: number;
  polishes: number;
  polishErrors: number;
  eventUnsubscribers: Array<() => void>;
}

const state: ChangelogWriterState = {
  entries: [],
  filesTouched: new BoundedSet<string>({ max: 2_000 }),
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

function resolveProjectPath(rawPath: string, cwd = process.cwd()): string | null {
  const root = resolve(cwd);
  const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  const rel = relative(root, resolved);
  if (rel === '' || (rel.split(/[\\/]/)[0] !== '..' && !isAbsolute(rel))) return resolved;
  return null;
}

function readConfig(raw: unknown): ChangelogWriterConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r['enabled'] !== false,
    filePath:
      typeof r['filePath'] === 'string' && r['filePath'].length > 0
        ? (resolveProjectPath(r['filePath']) ?? '')
        : (resolveProjectPath(DEFAULTS.filePath) ?? DEFAULTS.filePath),
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
  // Global options may precede the subcommand (`git -C pkg commit`), and the
  // message flag comes combined (`-am`), attached (`-m"…"`) or as
  // `--message=…`: the old `-m\s+` grammar missed all of them, so those
  // commits never reached the changelog.
  if (!/\bgit(?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+commit\b/.test(command)) return null;
  const m =
    /(?:^|\s)(?:-[A-Za-z]*m|--message)(?:=|\s+)?(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+))/.exec(
      command,
    );
  const rawSubject = m?.[1] ? m[1].replace(/\\"/g, '"') : (m?.[2] ?? m?.[3] ?? null);
  if (!rawSubject) return null;
  // Multi-line -m payloads: only the first line is the subject.
  return rawSubject.split('\n')[0]?.trim() || null;
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
  capabilities: { tools: true, llm: true },
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
    state.filesTouched = new BoundedSet<string>({ max: 2_000 });
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
          {
            system: 'You are a precise technical release-notes editor.',
            role: 'document',
          },
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
        if (
          toolName === 'write' ||
          toolName === 'edit' ||
          toolName === 'write_to_file' ||
          toolName === 'replace_file_content'
        ) {
          const raw =
            input['path'] ??
            input['TargetFile'] ??
            input['filePath'] ??
            input['targetFile'] ??
            input['file_path'] ??
            input['file'];
          if (typeof raw === 'string' && raw) state.filesTouched.add(raw);
          return;
        }
        if (toolName === 'git_autocommit') {
          const type = typeof input['type'] === 'string' ? input['type'] : '';
          const msg = typeof input['message'] === 'string' ? input['message'] : '';
          const subject = msg ? (type && !msg.startsWith(type) ? `${type}: ${msg}` : msg) : null;
          if (subject) {
            state.commitsSeen += 1;
            api.metrics.counter('commits_seen');
            const { section, text } = commitToEntry(subject);
            addEntry({ section, text, origin: 'commit', when: new Date().toISOString() });
          }
          return;
        }
        if (toolName === 'bash' || toolName === 'exec') {
          const command =
            typeof input['command'] === 'string'
              ? input['command']
              : typeof input['CommandLine'] === 'string'
                ? input['CommandLine']
                : typeof input['cmd'] === 'string'
                  ? input['cmd']
                  : '';
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

    // Entries describe "this session's" work, but the plugin is set up once
    // per PROCESS and the host outlives any one session (the WebUI opens
    // additional sessions in the same process). Only a completed write
    // cleared the buffer, so an unwritten session's entries were carried into
    // the next one and rendered as its work. Registered OUTSIDE the
    // collectCommits branch: a manually added note must be cleared too.
    // Guarded like pr-drafter's subscription — minimal hosts omit onEvent.
    if (api.onEvent) {
      const offSession = api.onEvent('session.ended', () => {
        state.entries = [];
        state.filesTouched = new BoundedSet<string>({ max: 2_000 });
      });
      state.eventUnsubscribers.push(offSession);
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
        if (!cfg.enabled) throw new Error('changelog-writer is disabled');
        const raw = (input ?? {}) as Record<string, unknown>;
        const rawText =
          input.text ??
          raw['message'] ??
          raw['entry'] ??
          raw['content'] ??
          raw['description'] ??
          raw['desc'] ??
          raw['summary'] ??
          raw['body'] ??
          raw['note'] ??
          raw['item'];
        const text = String(rawText ?? '').trim();
        if (!text) {
          throw new ToolValidationError({ message: 'entry text must not be empty', field: 'text' });
        }
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
        const rawInput = (input ?? {}) as Record<string, unknown>;
        const shouldPolish =
          input.polish === true ||
          rawInput['use_llm'] === true ||
          rawInput['useLlm'] === true ||
          rawInput['ai'] === true ||
          rawInput['use_ai'] === true;
        const raw = renderUnreleasedBlock(state.entries);
        const markdown = raw ? await maybePolish(raw, shouldPolish) : '';
        return {
          ok: true,
          enabled: cfg.enabled,
          filePath: cfg.filePath,
          pendingEntries: state.entries.length,
          filesTouched: [...state.filesTouched].slice(0, 50),
          commitsSeen: state.commitsSeen,
          polished: shouldPolish && markdown !== raw,
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
        if (!cfg.enabled) throw new Error('changelog-writer is disabled');
        if (!cfg.filePath) {
          throw new Error('filePath must stay within the current project directory');
        }
        if (state.entries.length === 0) {
          throw new Error('no pending entries — add some with changelog_add first');
        }
        const rawInput = (input ?? {}) as Record<string, unknown>;
        const shouldPolish =
          input.polish === true ||
          rawInput['use_llm'] === true ||
          rawInput['useLlm'] === true ||
          rawInput['ai'] === true ||
          rawInput['use_ai'] === true;
        const block = await maybePolish(renderUnreleasedBlock(state.entries), shouldPolish);
        let existing: string | null = null;
        try {
          existing = readFileSync(cfg.filePath, 'utf-8');
        } catch (err) {
          // Only a missing file means "create it"; any other read failure must
          // not fall through to overwriting an existing changelog.
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new Error(
              `failed to read ${cfg.filePath}: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err },
            );
          }
          existing = null;
        }
        try {
          writeFileSync(cfg.filePath, mergeIntoChangelog(existing, block));
        } catch (err) {
          throw new Error(
            `failed to write ${cfg.filePath}: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
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
    state.filesTouched = new BoundedSet<string>({ max: 2_000 });
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
