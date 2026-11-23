import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { ToolCallPipelinePayload } from '@wrongstack/core/agent';
import { InjectionTracker } from '../middleware/injection-tracker.js';
import {
  createSageToolCallMiddleware,
  type SageRetrieverLike,
  type SageToolCallMiddlewareOptions,
} from '../middleware/tool-call-memory.js';
import { isProgressLogText } from '../shared/progress-log.js';
import type { Sage } from '../types.js';

/**
 * Offline replay of tool-result injection.
 *
 * Sessions do not persist which memories were injected (evidence rides in
 * ephemeral provider blocks) and the store's audit log keeps only the last
 * 1,000 events, so injection quality cannot be read back from history. This
 * replays the real tool calls of logged sessions through the production
 * middleware against a fixed memory snapshot, then scores what it injected
 * against what the agent did next in the same turn. Every configuration sees
 * identical inputs, so thresholds can be compared on evidence instead of
 * intuition.
 *
 * The labels are proxies: `cited`/`matched` use the production use-credit
 * signal (id citation, then the tracker's lexical match) on the assistant text
 * that followed the call; `editTouched` means the memory is anchored to a file
 * the agent edited later in the turn. Judged precision needs external labels.
 */

export interface ReplayCase {
  id: string;
  sessionId: string;
  turn: number;
  toolUseId: string;
  toolName: string;
  input: unknown;
  result: string;
  /** Assistant text after the call, until the next user turn. */
  followingText: string;
  /** Paths written by edit-like calls after this one in the same turn. */
  editedPaths: string[];
  /** The user message that opened the turn (trimmed). */
  userGoal: string;
}

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
const MAX_RESULT_CHARS = 20_000;

interface Block {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: Block) =>
      block?.type === 'text' && typeof block.text === 'string' ? block.text : '',
    )
    .filter(Boolean)
    .join('\n');
}

function inputPaths(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const record = input as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ['path', 'file_path', 'filePath', 'target']) {
    if (typeof record[key] === 'string') out.push(record[key] as string);
  }
  if (Array.isArray(record.paths)) {
    for (const value of record.paths) if (typeof value === 'string') out.push(value);
  }
  return out;
}

/** Mine replay cases from one session JSONL (the `SessionEvent` log). */
export function mineReplayCases(jsonl: string, sessionId: string): ReplayCase[] {
  type Item =
    | { kind: 'tool'; turn: number; block: Block }
    | { kind: 'text'; turn: number; text: string };
  const items: Item[] = [];
  const results = new Map<string, { text: string; isError: boolean }>();
  const goals: string[] = [];
  let turn = -1;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === 'user_input') {
      turn++;
      goals[turn] = textOf(event.content).slice(0, 600);
    } else if (event.type === 'tool_result' && typeof event.id === 'string') {
      const content = event.content;
      const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
      results.set(event.id, {
        text: text.slice(0, MAX_RESULT_CHARS),
        isError: event.isError === true,
      });
    } else if (event.type === 'message_appended' && turn >= 0) {
      const message = event.message as { role?: string; content?: unknown } | undefined;
      if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
      for (const block of message.content as Block[]) {
        if (block?.type === 'tool_use' && typeof block.id === 'string' && block.name) {
          items.push({ kind: 'tool', turn, block });
        } else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          items.push({ kind: 'text', turn, text: block.text });
        }
      }
    }
  }

  const cases: ReplayCase[] = [];
  items.forEach((item, index) => {
    if (item.kind !== 'tool') return;
    const toolUseId = item.block.id as string;
    const following: string[] = [];
    const edited: string[] = [];
    for (let j = index + 1; j < items.length && items[j]!.turn === item.turn; j++) {
      const next = items[j]!;
      if (next.kind === 'text') following.push(next.text);
      else if (EDIT_TOOLS.has(String(next.block.name).toLowerCase())) {
        // A failed edit wrote nothing. A result-less edit (legacy/in-flight
        // logs) keeps the previous behaviour; only an explicit failure is
        // excluded, so `editTouched` does not credit a memory for a write that
        // never happened.
        if (results.get(next.block.id as string)?.isError !== true) {
          edited.push(...inputPaths(next.block.input));
        }
      }
    }
    cases.push({
      id: `${sessionId}#${toolUseId}`,
      sessionId,
      turn: item.turn,
      toolUseId,
      toolName: String(item.block.name),
      input: item.block.input ?? {},
      result: results.get(toolUseId)?.text ?? '',
      followingText: following.join('\n'),
      editedPaths: [...new Set(edited)],
      userGoal: goals[item.turn] ?? '',
    });
  });
  return cases;
}

export interface ReplayConfig {
  name: string;
  options?: Partial<
    Pick<
      SageToolCallMiddlewareOptions,
      | 'maxHintsPerTool'
      | 'maxCharsPerTool'
      | 'minScore'
      | 'minImportance'
      | 'relationFloor'
      | 'repeatCooldownMs'
      | 'taskAware'
      | 'triggers'
    >
  >;
}

export interface ReplayCaseResult {
  caseId: string;
  sessionId: string;
  toolName: string;
  injected: string[];
  chars: number;
  cited: string[];
  matched: string[];
  editTouched: string[];
}

export interface ReplayRun {
  config: ReplayConfig;
  results: ReplayCaseResult[];
}

/**
 * Replay `cases` through the production tool-call middleware.
 *
 * `retriever` must read a fixed snapshot; its `recordInjection`/`recordUse`
 * are replaced with no-ops so one run cannot change the counters (and so the
 * scores) the next configuration sees.
 */
export async function replayInjection(input: {
  projectRoot: string;
  retriever: SageRetrieverLike;
  getMemory: (id: string) => Promise<Sage | undefined>;
  cases: readonly ReplayCase[];
  config: ReplayConfig;
}): Promise<ReplayRun> {
  const { projectRoot, cases, config } = input;
  let captured: string[] = [];
  const retriever: SageRetrieverLike = {
    ...input.retriever,
    recordInjection: async (ids: string[]) => {
      captured.push(...ids);
    },
    recordUse: async () => {},
  };
  const tracker = new InjectionTracker();
  const middleware = createSageToolCallMiddleware({
    ...config.options,
    memory: retriever,
    tracker,
    verifyOnMutation: false,
  });

  const results: ReplayCaseResult[] = [];
  for (const replayCase of cases) {
    captured = [];
    const payload = {
      toolUse: {
        type: 'tool_use',
        id: replayCase.toolUseId,
        name: replayCase.toolName,
        input: replayCase.input,
      },
      result: {
        type: 'tool_result',
        tool_use_id: replayCase.toolUseId,
        name: replayCase.toolName,
        content: replayCase.result,
      },
      ctx: {
        projectRoot,
        cwd: projectRoot,
        session: { id: replayCase.sessionId },
        signal: new AbortController().signal,
        meta: {},
      },
    } as unknown as ToolCallPipelinePayload;
    try {
      await middleware.handler(payload, async (p) => p);
    } catch {
      // Injection is fail-open in production; a replay error is an empty case.
    }
    const evidence = (payload.ctx as { memoryEvidence?: Array<{ text: string }> }).memoryEvidence;
    const chars = evidence?.reduce((sum, entry) => sum + entry.text.length, 0) ?? 0;
    const injected = [...new Set(captured)];
    const matched = replayCase.followingText
      ? tracker.consumeMatches(replayCase.followingText, Date.now(), replayCase.sessionId)
      : [];
    const cited = injected.filter((id) => replayCase.followingText.includes(id));
    const editTouched: string[] = [];
    if (replayCase.editedPaths.length > 0) {
      const edited = new Set(replayCase.editedPaths.map((p) => normalizePath(projectRoot, p)));
      for (const id of injected) {
        const memory = await input.getMemory(id);
        if (memory?.anchors.some((a) => a.path && edited.has(normalizePath(projectRoot, a.path)))) {
          editTouched.push(id);
        }
      }
    }
    results.push({
      caseId: replayCase.id,
      sessionId: replayCase.sessionId,
      toolName: replayCase.toolName,
      injected,
      chars,
      cited,
      matched: matched.filter((id) => injected.includes(id)),
      editTouched,
    });
  }
  return { config, results };
}

function normalizePath(root: string, value: string): string {
  const absolute = path.isAbsolute(value) ? value : path.join(root, value);
  return path.relative(root, absolute).replaceAll('\\', '/').toLowerCase();
}

export interface ReplaySummary {
  config: string;
  cases: number;
  casesWithInjection: number;
  injections: number;
  uniqueMemories: number;
  avgCharsPerInjectingCase: number;
  /** Injections later cited by id or matched by the production tracker. */
  usedRate: number;
  citedRate: number;
  /** Injections anchored to a file the agent edited later in the turn. */
  editTouchedRate: number;
  progressLogShare: number;
  /** Injections with a path anchor that no longer exists on disk. */
  missingAnchorShare: number;
  topMemories: Array<{ id: string; injections: number; used: number; text: string }>;
}

export async function summarizeReplay(
  run: ReplayRun,
  projectRoot: string,
  getMemory: (id: string) => Promise<Sage | undefined>,
): Promise<ReplaySummary> {
  const perMemory = new Map<string, { injections: number; used: number }>();
  let injections = 0;
  let used = 0;
  let cited = 0;
  let editTouched = 0;
  let chars = 0;
  let injecting = 0;
  for (const result of run.results) {
    if (result.injected.length === 0) continue;
    injecting++;
    chars += result.chars;
    const usedIds = new Set([...result.cited, ...result.matched]);
    for (const id of result.injected) {
      injections++;
      const slot = perMemory.get(id) ?? { injections: 0, used: 0 };
      slot.injections++;
      if (usedIds.has(id)) {
        slot.used++;
        used++;
      }
      perMemory.set(id, slot);
    }
    cited += result.cited.length;
    editTouched += result.editTouched.length;
  }
  let progressLog = 0;
  let missingAnchor = 0;
  const texts = new Map<string, string>();
  for (const [id, slot] of perMemory) {
    const memory = await getMemory(id);
    if (!memory) continue;
    texts.set(id, memory.text);
    if (isProgressLogText(memory.text)) progressLog += slot.injections;
    const missing = memory.anchors.some(
      (anchor) =>
        anchor.path &&
        anchor.type !== 'command' &&
        anchor.type !== 'agent' &&
        !existsSync(path.join(projectRoot, anchor.path)),
    );
    if (missing) missingAnchor += slot.injections;
  }
  const ratio = (n: number) => (injections === 0 ? 0 : n / injections);
  return {
    config: run.config.name,
    cases: run.results.length,
    casesWithInjection: injecting,
    injections,
    uniqueMemories: perMemory.size,
    avgCharsPerInjectingCase: injecting === 0 ? 0 : Math.round(chars / injecting),
    usedRate: ratio(used),
    citedRate: ratio(cited),
    editTouchedRate: ratio(editTouched),
    progressLogShare: ratio(progressLog),
    missingAnchorShare: ratio(missingAnchor),
    topMemories: [...perMemory]
      .sort((a, b) => b[1].injections - a[1].injections)
      .slice(0, 10)
      .map(([id, slot]) => ({ id, ...slot, text: (texts.get(id) ?? '').slice(0, 120) })),
  };
}
