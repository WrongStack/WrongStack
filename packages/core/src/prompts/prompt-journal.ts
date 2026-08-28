/**
 * Hierarchical Prompt Journal & Detailed Interaction Trace Logger.
 *
 * Persists comprehensive prompt history within a clean date & session folder hierarchy
 * at `<projectRoot>/.wrongstack/prompts/`:
 *
 * ├── index.json                  <-- High-level catalog of dates, sessions & stats
 * ├── index.md                    <-- Visual navigation board linking to daily journals
 * └── YYYY-MM/                    <-- Month folder (e.g. 2026-08)
 *     └── YYYY-MM-DD/             <-- Day folder (e.g. 2026-08-15)
 *         ├── daily-summary.md    <-- Day's overview & interaction breakdown
 *         ├── session-<id>.md     <-- Rich Markdown journal for that session
 *         └── session-<id>.jsonl  <-- Machine-readable JSONL for that session
 *
 * Automatically ensures `.wrongstack/` is in `.gitignore` so traces are never
 * accidentally committed to version control.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DefaultSecretScrubber } from '../security/secret-scrubber.js';

/**
 * Module-level scrubber instance (SEC-004). One per process is enough — the
 * scrubber is stateless per call, and sharing it here matches the singleton
 * usage in `hq/redaction.ts` and `session-store.ts`.
 */
const defaultScrubber = new DefaultSecretScrubber();

export type PromptCategory =
  | 'raw_user' // Direct, unedited user prompt
  | 'refined_user' // Context-enriched / refined prompt
  | 'system_prompt' // Injected system prompt / persona
  | 'autonomous_next_step' // Autonomous loop continuation
  | 'self_healing_retry' // Error repair / targeted test failure retry
  | 'clarify_interaction' // Proactive clarification question & choice
  | 'subagent_delegation'; // Subagent prompt delegation

export interface PromptJournalEntry {
  id: string;
  timestamp: string; // ISO 8601
  sessionId: string;
  projectRoot: string;
  role: 'user' | 'system' | 'assistant' | 'tool';
  category: PromptCategory;
  content: string;
  rawContent?: string | undefined;
  metadata: {
    model?: string | undefined;
    provider?: string | undefined;
    iterationIndex?: number | undefined;
    tokenEstimate: number;
    characterCount: number;
    lineCount: number;
    activeTools?: string[] | undefined;
    contextFiles?: string[] | undefined;
    durationMs?: number | undefined;
    decisionReason?: string | undefined;
    tags?: string[] | undefined;
  };
}

export interface RecordPromptOptions {
  projectRoot: string;
  sessionId?: string | undefined;
  role?: 'user' | 'system' | 'assistant' | 'tool' | undefined;
  category: PromptCategory;
  content: string;
  rawContent?: string | undefined;
  model?: string | undefined;
  provider?: string | undefined;
  iterationIndex?: number | undefined;
  activeTools?: string[] | undefined;
  contextFiles?: string[] | undefined;
  durationMs?: number | undefined;
  decisionReason?: string | undefined;
  tags?: string[] | undefined;
}

export interface PromptJournalFilter {
  sessionId?: string | undefined;
  category?: PromptCategory | undefined;
  date?: string | undefined; // YYYY-MM-DD
  month?: string | undefined; // YYYY-MM
  since?: string | undefined;
  limit?: number | undefined;
}

export interface PromptJournalIndex {
  updatedAt: string;
  totalPrompts: number;
  totalTokensEstimated: number;
  months: Record<
    string,
    {
      days: Record<
        string,
        {
          sessions: Record<
            string,
            {
              promptCount: number;
              tokenEstimate: number;
              lastTimestamp: string;
              categories: Record<string, number>;
            }
          >;
        }
      >;
    }
  >;
}

/**
 * `ctx.meta` key the TUI's submit path stamps with the raw (pre-refinement)
 * user prompt text when the refiner rewrote the prompt. The CLI's
 * prompt-journal recorder consumes the marker to label the turn
 * `refined_user` (with `rawContent` preserved) instead of `raw_user`.
 *
 * Shared here so the two sides (TUI stamp, CLI consumer) cannot drift.
 */
export const PROMPT_JOURNAL_RAW_MARKER = 'promptJournal.raw';

/**
 * Ensures `<projectRoot>/.gitignore` contains `.wrongstack/` to keep all
 * prompt logs, telemetry, and indexes out of version control.
 */
export async function ensureGitignore(projectRoot: string): Promise<void> {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  try {
    let content = '';
    try {
      content = await fs.readFile(gitignorePath, 'utf8');
    } catch {
      content = '';
    }

    if (!content.includes('.wrongstack') && !content.includes('.wrongstack/')) {
      const addition = content.endsWith('\n') || content.length === 0
        ? '.wrongstack/\n'
        : '\n.wrongstack/\n';
      await fs.writeFile(gitignorePath, content + addition, 'utf8');
    }
  } catch {
    // Non-fatal if gitignore cannot be written
  }
}

/**
 * Filename-safe form of a session id for journal files and links.
 *
 * Real session ids are `YYYY-MM-DD/sess_<ULID>` — the date prefix is a
 * subdirectory in the session store, but the prompt journal already nests
 * files under `YYYY-MM/YYYY-MM-DD/`, so a second slash would create a nested
 * path that is never created (ENOENT on append). The leaf (`sess_<ULID>`)
 * is unique and keeps the file inside the day dir. `entry.sessionId` is
 * stored verbatim; only file names and markdown links use this form.
 */
function sessionFileId(sessionId: string): string {
  const leaf = sessionId.split(/[\\/]/u).pop();
  return leaf && leaf.trim().length > 0 ? leaf : 'general';
}

/**
 * Record a comprehensive prompt entry into the hierarchical date-based prompt journal.
 */
export async function recordPromptJournalEntry(
  opts: RecordPromptOptions,
): Promise<PromptJournalEntry> {
  const now = new Date();
  const timestamp = now.toISOString();
  const dateStr = timestamp.slice(0, 10); // YYYY-MM-DD
  const monthStr = dateStr.slice(0, 7); // YYYY-MM
  const sessionId = opts.sessionId?.trim() || 'general';
  const id = `pmt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  // SEC-004: the journal persists raw user input (`raw_user`/`rawContent`)
  // and provider error text (`self_healing_retry` journals toErrorMessage) —
  // both are credential-bearing content classes. Scrub BEFORE the entry is
  // built: every write artifact (session JSONL + MD, daily summary, root
  // catalog) serializes `entry`, so this one gate covers all four. Same
  // mandatory-scrubbing contract as InputHistoryStore — a pasted credential
  // must never reach disk.
  const content = defaultScrubber.scrub(opts.content ?? '');
  const rawContent =
    typeof opts.rawContent === 'string' && opts.rawContent.length > 0
      ? defaultScrubber.scrub(opts.rawContent)
      : opts.rawContent;
  // decisionReason carries provider/retry context strings (and error-derived
  // text from the self-healing path) — same credential-bearing class as
  // content, same mandatory scrub (chimera follow-up to SEC-004).
  const decisionReason =
    typeof opts.decisionReason === 'string' && opts.decisionReason.length > 0
      ? defaultScrubber.scrub(opts.decisionReason)
      : opts.decisionReason;
  const lines = content.split('\n');
  const characterCount = content.length;
  const lineCount = lines.length;
  // Standard token estimate: ~4 characters per token
  const tokenEstimate = Math.ceil(characterCount / 4);

  const entry: PromptJournalEntry = {
    id,
    timestamp,
    sessionId,
    projectRoot: opts.projectRoot,
    role: opts.role ?? (opts.category === 'system_prompt' ? 'system' : 'user'),
    category: opts.category,
    content,
    rawContent,
    metadata: {
      model: opts.model,
      provider: opts.provider,
      iterationIndex: opts.iterationIndex,
      tokenEstimate,
      characterCount,
      lineCount,
      activeTools: opts.activeTools,
      contextFiles: opts.contextFiles,
      durationMs: opts.durationMs,
      decisionReason,
      tags: opts.tags,
    },
  };

  const basePromptsDir = path.join(opts.projectRoot, '.wrongstack', 'prompts');
  const dayDir = path.join(basePromptsDir, monthStr, dateStr);

  try {
    await fs.mkdir(dayDir, { recursive: true });
    await ensureGitignore(opts.projectRoot);

    // 1. Session JSONL file: YYYY-MM/YYYY-MM-DD/session-<leaf>.jsonl
    const sessionJsonlFile = path.join(dayDir, `session-${sessionFileId(sessionId)}.jsonl`);
    await fs.appendFile(sessionJsonlFile, JSON.stringify(entry) + '\n', 'utf8');

    // 2. Session Markdown file: YYYY-MM/YYYY-MM-DD/session-<leaf>.md
    const sessionMdFile = path.join(dayDir, `session-${sessionFileId(sessionId)}.md`);
    const mdSection = formatEntryMarkdown(entry);
    await fs.appendFile(sessionMdFile, mdSection, 'utf8');

    // 3. Update Daily Summary Markdown
    const dailySummaryFile = path.join(dayDir, 'daily-summary.md');
    await updateDailySummary(dailySummaryFile, dateStr, entry);

    // 4. Update Root index.json & index.md
    await updateRootCatalog(basePromptsDir, monthStr, dateStr, sessionId, entry);
  } catch (err) {
    // Non-fatal logging error
    console.error?.(`Failed to write hierarchical prompt journal: ${err}`);
  }

  return entry;
}

/**
 * Format a single prompt journal entry into rich Markdown.
 */
function formatEntryMarkdown(entry: PromptJournalEntry): string {
  const tagList = [
    `**Category:** \`${entry.category}\``,
    `**Role:** \`${entry.role}\``,
    entry.metadata.model ? `**Model:** \`${entry.metadata.model}\`` : null,
    `**Tokens (est):** ~${entry.metadata.tokenEstimate}`,
    entry.metadata.iterationIndex !== undefined ? `**Iteration:** #${entry.metadata.iterationIndex}` : null,
    `**Session:** \`${entry.sessionId}\``,
  ].filter(Boolean).join(' | ');

  let md = `\n### 📝 [${entry.timestamp}] \`${entry.id}\`\n${tagList}\n\n`;

  if (entry.metadata.decisionReason) {
    md += `> **Rationale:** ${entry.metadata.decisionReason}\n\n`;
  }

  if (entry.metadata.activeTools && entry.metadata.activeTools.length > 0) {
    md += `*Active Tools:* \`${entry.metadata.activeTools.join('`, `')}\`\n\n`;
  }

  if (entry.rawContent && entry.rawContent !== entry.content) {
    md += `**Raw Input:**\n\`\`\`text\n${entry.rawContent.trim()}\n\`\`\`\n\n`;
    md += `**Refined / Injected Prompt:**\n\`\`\`text\n${entry.content.trim()}\n\`\`\`\n\n`;
  } else {
    md += `**Prompt Content:**\n\`\`\`text\n${entry.content.trim()}\n\`\`\`\n\n`;
  }

  md += `---\n`;
  return md;
}

async function updateDailySummary(
  summaryFile: string,
  dateStr: string,
  entry: PromptJournalEntry,
): Promise<void> {
  try {
    let content = '';
    try {
      content = await fs.readFile(summaryFile, 'utf8');
    } catch {
      content = `# 📅 Daily Prompt Summary — ${dateStr}\n\n| Time | ID | Session | Category | Model | Tokens | Rationale |\n| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
    }

    const time = entry.timestamp.slice(11, 19);
    const model = entry.metadata.model ?? '-';
    const reason = entry.metadata.decisionReason ? entry.metadata.decisionReason.slice(0, 40) : '-';
    const row = `| ${time} | [\`${entry.id}\`](session-${sessionFileId(entry.sessionId)}.md) | \`${entry.sessionId}\` | \`${entry.category}\` | ${model} | ~${entry.metadata.tokenEstimate} | ${reason} |\n`;

    await fs.writeFile(summaryFile, content + row, 'utf8');
  } catch {
    // Non-fatal
  }
}

async function updateRootCatalog(
  baseDir: string,
  monthStr: string,
  dateStr: string,
  sessionId: string,
  entry: PromptJournalEntry,
): Promise<void> {
  const indexJsonFile = path.join(baseDir, 'index.json');
  const indexMdFile = path.join(baseDir, 'index.md');

  let catalog: PromptJournalIndex;
  try {
    const raw = await fs.readFile(indexJsonFile, 'utf8');
    catalog = JSON.parse(raw) as PromptJournalIndex;
  } catch {
    catalog = {
      updatedAt: entry.timestamp,
      totalPrompts: 0,
      totalTokensEstimated: 0,
      months: {},
    };
  }

  catalog.updatedAt = entry.timestamp;
  catalog.totalPrompts += 1;
  catalog.totalTokensEstimated += entry.metadata.tokenEstimate;

  if (!catalog.months[monthStr]) {
    catalog.months[monthStr] = { days: {} };
  }
  const monthData = catalog.months[monthStr]!;
  if (!monthData.days[dateStr]) {
    monthData.days[dateStr] = { sessions: {} };
  }
  const dayData = monthData.days[dateStr]!;
  if (!dayData.sessions[sessionId]) {
    dayData.sessions[sessionId] = {
      promptCount: 0,
      tokenEstimate: 0,
      lastTimestamp: entry.timestamp,
      categories: {},
    };
  }
  const sessionData = dayData.sessions[sessionId]!;
  sessionData.promptCount += 1;
  sessionData.tokenEstimate += entry.metadata.tokenEstimate;
  sessionData.lastTimestamp = entry.timestamp;
  sessionData.categories[entry.category] = (sessionData.categories[entry.category] ?? 0) + 1;

  try {
    await fs.writeFile(indexJsonFile, JSON.stringify(catalog, null, 2), 'utf8');

    // Generate clean root index.md
    let md = `# 🗂️ Prompt Journal Navigation Index\n\n`;
    md += `* **Total Prompts Logged:** ${catalog.totalPrompts}\n`;
    md += `* **Total Tokens (est):** ~${catalog.totalTokensEstimated.toLocaleString()}\n`;
    md += `* **Last Recorded Activity:** ${catalog.updatedAt}\n\n`;
    md += `## 📅 Recorded Dates & Sessions\n\n`;
    md += `| Date | Session | Prompts | Tokens (est) | Daily Log | Session Log |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;

    for (const [m, mObj] of Object.entries(catalog.months).sort().reverse()) {
      for (const [d, dObj] of Object.entries(mObj.days).sort().reverse()) {
        for (const [sId, sData] of Object.entries(dObj.sessions)) {
          const dailyLink = `[daily-summary.md](./${m}/${d}/daily-summary.md)`;
          const sessionLink = `[session-${sessionFileId(sId)}.md](./${m}/${d}/session-${sessionFileId(sId)}.md)`;
          md += `| **${d}** | \`${sId}\` | ${sData.promptCount} | ~${sData.tokenEstimate.toLocaleString()} | ${dailyLink} | ${sessionLink} |\n`;
        }
      }
    }

    await fs.writeFile(indexMdFile, md, 'utf8');
  } catch {
    // Non-fatal
  }
}

/**
 * Read prompt journal entries hierarchically across all date directories.
 */
export async function getPromptJournalEntries(
  projectRoot: string,
  filter: PromptJournalFilter = {},
): Promise<PromptJournalEntry[]> {
  const basePromptsDir = path.join(projectRoot, '.wrongstack', 'prompts');
  const results: PromptJournalEntry[] = [];

  try {
    const months = await fs.readdir(basePromptsDir);

    for (const month of months) {
      if (!/^\d{4}-\d{2}$/.test(month)) continue;
      if (filter.month && filter.month !== month) continue;

      const monthDir = path.join(basePromptsDir, month);
      const days = await fs.readdir(monthDir);

      for (const day of days) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        if (filter.date && filter.date !== day) continue;

        const dayDir = path.join(monthDir, day);
        const files = await fs.readdir(dayDir);

        const jsonlFiles = files.filter((f) => f.startsWith('session-') && f.endsWith('.jsonl'));

        for (const jsonlFile of jsonlFiles) {
          const sessionMatch = jsonlFile.match(/^session-(.+)\.jsonl$/);
          const sId = sessionMatch ? sessionMatch[1] : undefined;
          if (filter.sessionId && sId !== sessionFileId(filter.sessionId)) continue;

          const filePath = path.join(dayDir, jsonlFile);
          const content = await fs.readFile(filePath, 'utf8');
          const lines = content.split('\n');

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line) as PromptJournalEntry;
              // Normalize both sides so a full `YYYY-MM-DD/sess_<ulid>` filter
              // and its leaf form resolve the same entries.
              if (
                filter.sessionId &&
                sessionFileId(entry.sessionId) !== sessionFileId(filter.sessionId)
              ) {
                continue;
              }
              if (filter.category && entry.category !== filter.category) continue;
              if (filter.since && entry.timestamp < filter.since) continue;
              results.push(entry);
            } catch {
              // ignore malformed lines
            }
          }
        }
      }
    }
  } catch {
    return [];
  }

  // Sort chronologically
  results.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (filter.limit && results.length > filter.limit) {
    return results.slice(-filter.limit);
  }

  return results;
}
