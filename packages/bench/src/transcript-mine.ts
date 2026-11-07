import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RecallExpectation, RetrievalExpectation, TranscriptCaseSource } from './types.js';

const EDIT_TOOLS = new Set([
  'edit',
  'write',
  'replace',
  'patch',
  'multiedit',
  'multi_edit',
  'str_replace',
  'apply_patch',
]);

const RETRIEVAL_TOOLS = new Set([
  'read',
  'grep',
  'search',
  'glob',
  'codebase_search',
  'codebase_lsp_search',
  'find',
]);

interface ParsedEvent extends Record<string, unknown> {
  type: string;
}

interface ToolUse {
  index: number;
  id: string;
  name: string;
  input: unknown;
}

interface ToolResult {
  index: number;
  id: string;
  content: unknown;
  isError: boolean;
}

/** A curator-ready candidate, not yet a runnable local-manifest task. */
export interface MinedTraceEvalDraft {
  /** Stable local identifier based on the source session and edit ordinal. */
  id: string;
  /** The latest user prompt before the edit attempt, when recorded. */
  prompt?: string | undefined;
  /** Correlation data retained so a curator can inspect the original attempt. */
  observed: {
    toolName: string;
    toolUseId: string;
    toolApplied: boolean | undefined;
  };
  /** Copy this object into a local-manifest task after fixture/grader curation. */
  traceEval: {
    source: TranscriptCaseSource;
    retrieval: RetrievalExpectation[];
    recall: RecallExpectation;
  };
  /** What still needs review before this becomes an executable benchmark case. */
  needsCuration: string[];
}

export interface MineTranscriptResult {
  /** Source JSONL copy, placed under `<outDir>/corpus/`. */
  copiedTranscriptPath: string;
  /** JSON file containing all curator-ready candidates. */
  draftsPath: string;
  sessionId: string;
  candidates: MinedTraceEvalDraft[];
}

/**
 * Mine every edit attempt in a real WrongStack session JSONL into a draft
 * corpus entry. The original transcript is copied verbatim and hash-pinned;
 * no synthetic trace is generated. Fixtures and deterministic graders still
 * require human curation because a transcript cannot reconstruct a complete
 * pre-edit worktree or an acceptance test safely.
 */
export async function mineTranscript(opts: {
  transcriptPath: string;
  outDir: string;
}): Promise<MineTranscriptResult> {
  const sourcePath = path.resolve(opts.transcriptPath);
  let raw: string;
  try {
    raw = await fs.readFile(sourcePath, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot read session transcript ${sourcePath}: ${detail}`);
  }
  const events = parseEvents(raw);
  const sessionId = sessionIdOf(events);
  if (!sessionId) {
    throw new Error(`session transcript ${sourcePath} has no session_start/session_resumed id`);
  }

  const sha256 = createHash('sha256').update(raw).digest('hex');
  const corpusDir = path.resolve(opts.outDir, 'corpus');
  await fs.mkdir(corpusDir, { recursive: true });
  const copiedTranscriptPath = path.join(
    corpusDir,
    `${safeName(sessionId)}-${sha256.slice(0, 12)}.jsonl`,
  );
  await copyPinnedTranscript(copiedTranscriptPath, raw);

  const relativeTranscriptPath = `./corpus/${path.basename(copiedTranscriptPath)}`;
  const candidates = buildCandidates(events, {
    sessionId,
    transcriptPath: relativeTranscriptPath,
    sha256,
  });
  const draftsPath = path.resolve(opts.outDir, 'trace-eval-drafts.json');
  const artifact = {
    version: 1,
    source: {
      sessionId,
      transcriptPath: relativeTranscriptPath,
      sha256,
    },
    candidates,
  };
  await fs.writeFile(draftsPath, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
  return { copiedTranscriptPath, draftsPath, sessionId, candidates };
}

function buildCandidates(
  events: ParsedEvent[],
  sourceBase: Omit<TranscriptCaseSource, 'eventStart' | 'eventEnd'>,
): MinedTraceEvalDraft[] {
  const toolUses = new Map<string, ToolUse>();
  const activeUses = new Map<string, string>();
  const toolResults = new Map<string, ToolResult[]>();
  const toolEnds = new Map<string, boolean[]>();
  const toolEndIndexes = new Map<string, number>();
  const prompts: Array<{ index: number; text: string }> = [];
  const candidates: MinedTraceEvalDraft[] = [];
  let ordinal = 0;

  for (const [index, event] of events.entries()) {
    if (event.type === 'user_input') {
      const text = contentText(event['content']);
      if (text) prompts.push({ index, text });
      continue;
    }
    if (event.type === 'tool_use') {
      const id = stringValue(event['id']);
      const name = stringValue(event['name']);
      const actorKey = toolKey(event);
      if (id && name && actorKey) {
        const key = JSON.stringify([actorKey, index]);
        toolUses.set(key, { index, id, name, input: event['input'] });
        activeUses.set(actorKey, key);
      }
      continue;
    }
    if (event.type === 'tool_result') {
      const id = stringValue(event['id']);
      const key = activeUses.get(toolKey(event) ?? '');
      if (!id || !key) continue;
      const rows = toolResults.get(key) ?? [];
      rows.push({ index, id, content: event['content'], isError: event['isError'] === true });
      toolResults.set(key, rows);
      continue;
    }
    if (event.type === 'tool_call_end') {
      const key = activeUses.get(toolKey(event) ?? '');
      if (!key) continue;
      const outcomes = toolEnds.get(key) ?? [];
      outcomes.push(event['ok'] === true);
      toolEnds.set(key, outcomes);
      if (!toolEndIndexes.has(key)) toolEndIndexes.set(key, index);
    }
  }

  for (const [key, use] of toolUses) {
    if (!EDIT_TOOLS.has(use.name.toLowerCase().replace(/-/g, '_'))) continue;
    ordinal++;
    const endingIndex = toolEndIndexes.get(key) ?? use.index;
    const prompt = latestPrompt(prompts, use.index);
    const retrieval = suggestRetrieval(toolUses, toolResults, use.index);
    const inputContains = suggestIntentMarkers(use.input);
    const needsCuration: string[] = [
      'Capture the full pre-edit worktree as templateDir and add deterministic grader assertions.',
    ];
    if (retrieval.length === 0) {
      needsCuration.push(
        'Choose a required retrieval evidence marker; no successful retrieval result preceded this edit.',
      );
    }
    if (inputContains.length === 0) {
      needsCuration.push('Choose stable correct-intent input markers for the edit invocation.');
    }
    if (!prompt)
      needsCuration.push('Provide the task prompt; no preceding user_input was recorded.');

    candidates.push({
      id: `${safeName(sourceBase.sessionId)}-edit-${ordinal}`,
      ...(prompt ? { prompt: prompt.text } : {}),
      observed: {
        toolName: use.name,
        toolUseId: use.id,
        toolApplied: toolEnds.get(key)?.some((ok) => ok),
      },
      traceEval: {
        source: { ...sourceBase, eventStart: prompt?.index ?? use.index, eventEnd: endingIndex },
        retrieval,
        recall: {
          toolNames: [use.name],
          inputContains,
        },
      },
      needsCuration,
    });
  }
  return candidates;
}

function suggestRetrieval(
  toolUses: ReadonlyMap<string, ToolUse>,
  toolResults: ReadonlyMap<string, ToolResult[]>,
  beforeIndex: number,
): RetrievalExpectation[] {
  const rows: Array<{ index: number; name: string; marker: string }> = [];
  for (const [id, results] of toolResults) {
    const use = toolUses.get(id);
    // Tool names come from whichever surface recorded the session: the native
    // registry spells the index tools with hyphens ('codebase-search',
    // builtin.ts), while the MCP surface uses underscores ('codebase_search').
    // Normalize hyphens to underscores for the set lookup so both spellings of
    // every entry match; the recorded toolNames keep the transcript's own
    // spelling. An exact-only compare silently skipped every native
    // codebase-search retrieval, leaving drafts with empty retrieval evidence
    // and a false 'no successful retrieval' curation note.
    if (
      !use ||
      use.index >= beforeIndex ||
      !RETRIEVAL_TOOLS.has(use.name.toLowerCase().replace(/-/g, '_'))
    ) {
      continue;
    }
    for (const result of results) {
      if (result.isError || result.index >= beforeIndex) continue;
      const marker = conciseMarker(serialise(result.content));
      if (marker) rows.push({ index: result.index, name: use.name, marker });
    }
  }
  const latest = rows.sort((a, b) => b.index - a.index)[0];
  return latest ? [{ toolNames: [latest.name], contains: latest.marker }] : [];
}

function suggestIntentMarkers(input: unknown): string[] {
  const leaves = stringLeaves(input);
  const paths = leaves.filter(({ key }) => /(?:path|file)/i.test(key));
  const edits = leaves.filter(
    ({ key }) =>
      /(?:new|replace|content|patch|insert|text|value)/i.test(key) && !/(?:old|search)/i.test(key),
  );
  const selected = [...paths, ...edits, ...leaves]
    .map(({ value }) => conciseMarker(JSON.stringify(value).slice(1, -1)))
    .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index)
    .slice(0, 2);
  return selected;
}

function stringLeaves(value: unknown, key = ''): Array<{ key: string; value: string }> {
  if (typeof value === 'string') return [{ key, value }];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => stringLeaves(item, `${key}[${index}]`));
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([childKey, childValue]) =>
    stringLeaves(childValue, key ? `${key}.${childKey}` : childKey),
  );
}

function latestPrompt(
  prompts: Array<{ index: number; text: string }>,
  beforeIndex: number,
): { index: number; text: string } | undefined {
  for (let index = prompts.length - 1; index >= 0; index--) {
    const prompt = prompts[index];
    if (prompt && prompt.index < beforeIndex) return prompt;
  }
  return undefined;
}

function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((block) =>
      isRecord(block) && typeof block['text'] === 'string' ? [block['text']] : [],
    )
    .join('\n')
    .trim();
  return text || undefined;
}

function sessionIdOf(events: ParsedEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== 'session_start' && event.type !== 'session_resumed') continue;
    const id = stringValue(event['id']);
    if (id) return id;
  }
  return undefined;
}

function parseEvents(raw: string): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line);
      if (isRecord(parsed) && typeof parsed['type'] === 'string')
        events.push(parsed as ParsedEvent);
    } catch {
      // Preserve the source copy verbatim but ignore a partial/corrupt line when mining.
    }
  }
  return events;
}

async function copyPinnedTranscript(destination: string, raw: string): Promise<void> {
  try {
    const existing = await fs.readFile(destination, 'utf8');
    if (existing === raw) return;
    throw new Error(`refusing to overwrite a different corpus transcript at ${destination}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.writeFile(destination, raw, 'utf8');
      return;
    }
    throw err;
  }
}

function conciseMarker(value: string): string {
  return value.trim().slice(0, 160);
}

function serialise(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toolKey(event: ParsedEvent): string | undefined {
  const id = stringValue(event['id']);
  if (!id) return undefined;
  const actor = typeof event['agentId'] === 'string' ? event['agentId'] : '';
  return JSON.stringify([actor, id]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
}
