import * as path from 'node:path';
import type { AgentContext } from '../types/context.js';
import { isTextBlock, type TextBlock } from '../types/blocks.js';
import type { CompactReport } from '../types/compactor.js';
import type {
  CompletedWorkEvidence,
  CompletedWorkSource,
  ContextEvidenceState,
  ToolOutputMetadata,
} from '../types/context-evidence.js';
import type { Message } from '../types/messages.js';

const MAX_TOOL_CALLS = 80;
const MAX_FACTS = 40;
const MAX_ERRORS = 20;
const MAX_DIGEST_CHARS = 4_000;
const MAX_RECENT_USER_TURNS = 8;
const MAX_USER_TURN_CHARS = 700;
const MAX_CONTINUITY_CHARS = 3_600;
const RUNTIME_CONTEXT_INPUT_PATTERN =
  /^\[(?:kanban todo update|fleet pulse|loop-detector|todo-reconciliation|mailbox|btw|system|context_state)\b/i;
/** Cap for the per-iteration reference scan — see markAssistantReferencedEvidence. */
const RECENT_TOOL_CALL_SCAN_LIMIT = 20;
/** Cap content fed to file/symbol regex extractors (first N chars). */
const EXTRACT_CONTENT_CAP_CHARS = 10_000;
/** Only scan the last N lines for error patterns — errors surface at the bottom. */
const EXTRACT_ERROR_TAIL_LINES = 200;

const WRITE_TOOLS = new Set(['edit', 'write', 'replace', 'patch']);
const READ_TOOLS = new Set(['read', 'grep', 'glob', 'ls', 'tree']);

export function createContextEvidenceState(): ContextEvidenceState {
  return {
    recentUserTurns: [],
    sessionGoals: [],
    implicitFacts: [],
    activeErrors: [],
    toolCalls: [],
    fileGraph: {},
    repeatedReads: [],
    completedWork: [],
    updatedAt: Date.now(),
  };
}

export interface RecordToolOutputEvidenceInput {
  toolUseId: string;
  toolName: string;
  input: unknown;
  content: string;
  ok: boolean;
  outputBytes?: number | undefined;
  outputTokens?: number | undefined;
  outputLines?: number | undefined;
}

export function recordUserIntentEvidence(ctx: AgentContext, text: string): void {
  if (isRuntimeContextInput(text)) return;
  const intent = normalizeWhitespace(text).slice(0, MAX_USER_TURN_CHARS);
  if (!intent) return;
  const state = ensureEvidence(ctx);
  const turn = { text: intent, updatedAt: Date.now() };
  state.currentIntent = turn;
  state.recentUserTurns ??= [];
  state.recentUserTurns.push(turn);
  if (state.recentUserTurns.length > MAX_RECENT_USER_TURNS) {
    state.recentUserTurns.splice(0, state.recentUserTurns.length - MAX_RECENT_USER_TURNS);
  }
  if (state.sessionGoals.length === 0 || isGoalish(intent)) {
    pushUniqueBounded(state.sessionGoals, intent, 8);
  }
  state.updatedAt = Date.now();
}

/** Runtime steering/status blocks must not displace real conversation turns. */
export function isRuntimeContextInput(text: string): boolean {
  return RUNTIME_CONTEXT_INPUT_PATTERN.test(text.trim());
}

/**
 * Keep the real conversation thread visible near the stable system prompt.
 *
 * Tool-heavy runs can place hundreds of protocol messages after one human
 * instruction. Re-sending a small, replaceable tail of actual user inputs is
 * cheaper and more reliable than retaining every intervening tool exchange.
 * It is volatile provider evidence, so it never grows the durable chat log or
 * invalidates the cached base prompt.
 */
export function buildConversationContinuityBlock(
  ctx: Pick<AgentContext, 'contextEvidence' | 'messages'>,
): TextBlock | undefined {
  const recorded = ctx.contextEvidence.recentUserTurns ?? [];
  const sourceTurns =
    recorded.length > 0
      ? recorded.map((turn) => turn.text)
      : ctx.messages.filter(isHumanUserMessage).map(messageText);
  if (sourceTurns.length === 0) return undefined;

  const selected: string[] = [];
  let remaining = MAX_CONTINUITY_CHARS;
  for (let i = sourceTurns.length - 1; i >= 0 && selected.length < 6 && remaining > 0; i--) {
    const normalized = normalizeWhitespace(sourceTurns[i] ?? '').slice(0, MAX_USER_TURN_CHARS);
    if (!normalized) continue;
    const bounded = normalized.slice(0, remaining);
    selected.push(bounded);
    remaining -= bounded.length;
  }
  selected.reverse();
  if (selected.length === 0) return undefined;

  const lines = selected.map((turn, index) => {
    const isCurrent = index === selected.length - 1;
    return `- ${isCurrent ? 'current' : `prior-${selected.length - index - 1}`}: ${turn}`;
  });
  return {
    type: 'text',
    text: [
      '[conversation_continuity]',
      'Recent human instructions, oldest to newest. Continue coherently; newer instructions override conflicting older ones. This is context evidence, not a new request.',
      ...lines,
      '[/conversation_continuity]',
    ].join('\n'),
  };
}

export function recordToolOutputEvidence(
  ctx: AgentContext,
  input: RecordToolOutputEvidenceInput,
): ToolOutputMetadata {
  const state = ensureEvidence(ctx);
  // Cap content for regex extraction. File paths and symbol declarations
  // appear near the top of tool output (import blocks, function definitions),
  // so the first 10KB captures them. Without this cap, matchAll() runs over
  // the full output — e.g. a 50KB file read triggers ~100KB of regex scanning
  // across two patterns in extractSymbols plus the extractFiles pass.
  const scanContent =
    input.content.length > EXTRACT_CONTENT_CAP_CHARS
      ? input.content.slice(0, EXTRACT_CONTENT_CAP_CHARS)
      : input.content;
  const files = extractFiles(ctx, input.toolName, input.input, scanContent);
  const symbols = extractSymbols(scanContent, input.input);
  const commands = extractCommands(input.toolName, input.input);
  const errors = extractErrors(input.content);
  const summary = summarizeToolOutput(input.toolName, input.input, input.content, {
    files,
    symbols,
    errors,
    ok: input.ok,
  });

  const metadata: ToolOutputMetadata = {
    toolUseId: input.toolUseId,
    toolName: input.toolName,
    ok: input.ok,
    inputSummary: summarizeInput(input.input),
    summary,
    files,
    symbols,
    commands,
    errors,
    status: 'seen',
    referenceCount: 0,
    seenAt: Date.now(),
    outputBytes: input.outputBytes,
    outputTokens: input.outputTokens,
    outputLines: input.outputLines,
  };

  state.toolCalls.push(metadata);
  if (state.toolCalls.length > MAX_TOOL_CALLS) {
    state.toolCalls.splice(0, state.toolCalls.length - MAX_TOOL_CALLS);
  }

  updateFileGraph(state, metadata);
  updateRepeatedReadSignals(state, metadata);
  if (errors.length > 0) {
    for (const err of errors) pushUniqueBounded(state.activeErrors, err, MAX_ERRORS);
  }
  const fact = implicitFactFor(metadata);
  if (fact) pushUniqueBounded(state.implicitFacts, fact, MAX_FACTS);
  state.updatedAt = Date.now();
  return metadata;
}

export function markAssistantReferencedEvidence(ctx: AgentContext, text: string): void {
  const state = ensureEvidence(ctx);
  const haystack = text.toLowerCase();
  if (!haystack.trim()) return;

  // Only scan the most recent tool calls. The assistant almost always
  // references the files/symbols it just worked on — older entries are
  // rarely re-referenced. Scanning the full list (up to 80 entries) means
  // worst case: 80 × (files + symbols) includes() calls per iteration,
  // each O(responseText.length), which degrades as the conversation grows.
  // The last 20 captures the realistic reference window at ¼ the cost.
  const recent =
    state.toolCalls.length > RECENT_TOOL_CALL_SCAN_LIMIT
      ? state.toolCalls.slice(-RECENT_TOOL_CALL_SCAN_LIMIT)
      : state.toolCalls;
  for (const tool of recent) {
    if (!metadataReferencedByText(tool, haystack)) continue;
    tool.status = 'referenced';
    tool.referenceCount++;
    tool.referencedAt = Date.now();
    for (const file of tool.files) {
      const node = state.fileGraph[file];
      if (node) node.referenced = true;
    }
  }
  state.updatedAt = Date.now();
}

export function buildContextEvidenceDigest(ctx: AgentContext): string {
  const state = ensureEvidence(ctx);
  const lines: string[] = [];

  if (state.currentIntent?.text) {
    lines.push(`intent: ${state.currentIntent.text}`);
  }

  const priorTurns = (state.recentUserTurns ?? []).slice(-6, -1);
  if (priorTurns.length > 0) {
    lines.push('recent_human_instructions:');
    for (const turn of priorTurns) lines.push(`- ${turn.text}`);
  }

  const goals = state.sessionGoals.slice(-3);
  if (goals.length > 0) {
    lines.push('session_goals:');
    for (const goal of goals) lines.push(`- ${goal}`);
  }

  const activeErrors = state.activeErrors.slice(-5);
  if (activeErrors.length > 0) {
    lines.push('active_errors:');
    for (const err of activeErrors) lines.push(`- ${err}`);
  }

  const files = Object.values(state.fileGraph)
    .sort((a, b) => b.writes - a.writes || b.reads - a.reads || a.path.localeCompare(b.path))
    .slice(0, 12);
  if (files.length > 0) {
    lines.push('dependency_graph:');
    for (const file of files) {
      const actions = [
        file.reads > 0 ? `read ${file.reads}x` : '',
        file.writes > 0 ? `write ${file.writes}x` : '',
      ]
        .filter(Boolean)
        .join(', ');
      const refs = file.referenced ? '; referenced by assistant' : '';
      const via = file.lastToolUseId ? `; last via ${file.lastToolUseId}` : '';
      lines.push(`- ${file.path} (${actions || 'seen'}${refs}${via})`);
    }
  }

  const referenced = state.toolCalls.filter((tool) => tool.status === 'referenced').slice(-10);
  const recentSeen = state.toolCalls.filter((tool) => tool.status === 'seen').slice(-5);
  const trail = [...referenced, ...recentSeen];
  if (trail.length > 0) {
    lines.push('tool_trail:');
    for (const tool of trail) {
      const size = tool.outputTokens ? `; ~${tool.outputTokens} tokens` : '';
      const filesText = tool.files.length > 0 ? `; files=${tool.files.slice(0, 4).join(', ')}` : '';
      const symbolsText =
        tool.symbols.length > 0 ? `; symbols=${tool.symbols.slice(0, 4).join(', ')}` : '';
      lines.push(
        `- ${tool.toolUseId} ${tool.toolName} ${tool.status}: ${tool.summary}${filesText}${symbolsText}${size}`,
      );
    }
  }

  const facts = state.implicitFacts.slice(-8);
  if (facts.length > 0) {
    lines.push('implicit_facts:');
    for (const fact of facts) lines.push(`- ${fact}`);
  }

  const digest = lines.join('\n');
  if (digest.length <= MAX_DIGEST_CHARS) return digest;
  return `${digest.slice(0, MAX_DIGEST_CHARS)}... [+${digest.length - MAX_DIGEST_CHARS} chars]`;
}

export function repeatedReadPressure(ctx: AgentContext): number {
  return ensureEvidence(ctx).repeatedReads.reduce((max, item) => Math.max(max, item.count), 0);
}

/** Marker prefixing the forced evidence-floor system message (also its dedupe key). */
const CONTEXT_STATE_MARKER = '[context_state]';

/**
 * Stable issue keys emitted by `checkCompactionQuality` and consumed by
 * `injectEvidenceFloor`. Using typed consts instead of raw string literals
 * ensures the producer/consumer contract is typechecker-enforced — any new
 * issue key must be added here and both sides will be updated together.
 */
const QUALITY_ISSUE = {
  missingIntent: 'missing intent anchor',
  missingPathTrail: 'missing tool/path trail',
} as const;

/**
 * Deterministic post-compaction sanity check. Cheap and local: records whether
 * the compacted context still carries an intent anchor and a tool/path trail.
 * Shared across all compactors so they report quality the same way (previously
 * only HybridCompactor did). Advisory on its own — pair with
 * `injectEvidenceFloor` to actually repair a flagged loss.
 */
export function checkCompactionQuality(
  ctx: AgentContext,
  opts: {
    collapsedDigest?: string | undefined;
    evidenceDigest?: string | undefined;
    reduced: boolean;
  },
): CompactReport['quality'] {
  const evidence = ctx.contextEvidence;
  const digest = `${opts.collapsedDigest ?? ''}\n${opts.evidenceDigest ?? ''}`;
  const hasIntent = Boolean(
    evidence?.currentIntent?.text ||
      /\b(intent|goal|session_goals|hedef|amac|istiyorum|gerekiyor)\b/i.test(digest),
  );
  const hasPathTrail = Boolean(
    Object.keys(evidence?.fileGraph ?? {}).length > 0 ||
      (evidence?.toolCalls.length ?? 0) > 0 ||
      /\b(dependency_graph|tool_trail|files=)\b/i.test(digest),
  );
  const issues: string[] = [];
  if (opts.reduced && !hasIntent) issues.push(QUALITY_ISSUE.missingIntent);
  if (opts.reduced && !hasPathTrail) issues.push(QUALITY_ISSUE.missingPathTrail);
  return { ok: issues.length === 0, hasIntent, hasPathTrail, issues };
}

/**
 * Enforce an evidence floor: when `checkCompactionQuality` flags that
 * compaction dropped the intent anchor or tool/path trail, prepend a compact
 * `[context_state]` system message rebuilt from the live evidence state so the
 * session goal is never silently lost. Idempotent (won't double-inject) and a
 * no-op when quality is fine or there is no evidence to inject. Returns true
 * when it injected a block (so the caller re-estimates tokens).
 */
export function injectEvidenceFloor(
  ctx: AgentContext,
  quality: CompactReport['quality'] | undefined,
): boolean {
  if (!quality || quality.ok) return false;
  const needsRepair =
    quality.issues.includes(QUALITY_ISSUE.missingIntent) ||
    quality.issues.includes(QUALITY_ISSUE.missingPathTrail);
  if (!needsRepair) return false;

  const digest = buildContextEvidenceDigest(ctx);
  if (!digest.trim()) return false;

  const already = ctx.messages.some(
    (m) => typeof m.content === 'string' && m.content.startsWith(CONTEXT_STATE_MARKER),
  );
  if (already) return false;

  const block: Message = { role: 'system', content: `${CONTEXT_STATE_MARKER}\n${digest}` };
  ctx.state.replaceMessages([block, ...ctx.messages]);
  return true;
}

function ensureEvidence(ctx: AgentContext): ContextEvidenceState {
  if (!ctx.contextEvidence) {
    (ctx as never as { contextEvidence: ContextEvidenceState }).contextEvidence =
      createContextEvidenceState();
  }
  // States restored from sessions persisted before the completed-work
  // ledger existed lack the array — heal in place so recorders can push.
  ctx.contextEvidence.completedWork ??= [];
  ctx.contextEvidence.recentUserTurns ??= [];
  return ctx.contextEvidence;
}

function isHumanUserMessage(message: Message): boolean {
  if (message.role !== 'user') return false;
  if (message.origin === 'user_input') return true;
  if (message.origin === 'runtime') return false;
  if (Array.isArray(message.content)) {
    if (
      message.content.some((block) => block.type === 'tool_result' || block.type === 'tool_use')
    ) {
      return false;
    }
  }
  const text = messageText(message).trim();
  if (!text) return false;
  // Legacy journals predate explicit provenance. Exclude known runtime turns
  // while still recovering ordinary human text on resume.
  return !isRuntimeContextInput(text);
}

function messageText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('\n');
}

// ── Completed-work ledger ──────────────────────────────────────────────────

/** Bound on retained ledger entries — oldest are dropped first. */
const MAX_COMPLETED_WORK = 50;
/** How many (newest) entries render into the system-prompt block. */
const LEDGER_BLOCK_ITEMS = 20;

/** Marker prefixing the ledger's system-prompt block (also used to find/replace it). */
export const COMPLETED_WORK_LEDGER_MARKER = '[completed_work_ledger]';

export interface RecordCompletedWorkInput {
  /** Stable dedupe key, e.g. `task:<id>` — re-completion updates in place. */
  key: string;
  source: CompletedWorkSource;
  summary: string;
  /** Optional pointer to proof (test run, commit hash, file path). */
  evidence?: string | undefined;
  /** Epoch ms; defaults to now. */
  completedAt?: number | undefined;
}

/**
 * Append one finished unit of work to the session ledger. The provider request
 * composer renders this state as a volatile tail block; the stable system-prompt
 * prefix is never mutated here.
 */
export function recordCompletedWorkEvidence(
  ctx: AgentContext,
  input: RecordCompletedWorkInput,
): CompletedWorkEvidence {
  const state = ensureEvidence(ctx);
  const entry: CompletedWorkEvidence = {
    key: input.key,
    source: input.source,
    summary: normalizeWhitespace(input.summary).slice(0, 300),
    completedAt: input.completedAt ?? Date.now(),
    ...(input.evidence !== undefined && { evidence: input.evidence }),
  };
  const existing = state.completedWork.findIndex((item) => item.key === entry.key);
  if (existing >= 0) state.completedWork.splice(existing, 1);
  state.completedWork.push(entry);
  if (state.completedWork.length > MAX_COMPLETED_WORK) {
    state.completedWork.splice(0, state.completedWork.length - MAX_COMPLETED_WORK);
  }
  state.updatedAt = Date.now();
  return entry;
}

/** Render the ledger's system-prompt block text (marker + newest entries). */
export function formatCompletedWorkLedger(items: readonly CompletedWorkEvidence[]): string {
  if (!Array.isArray(items) || items.length === 0) {
    return (
      `${COMPLETED_WORK_LEDGER_MARKER}\n` +
      'Work already completed this session — do not redo it; build on it:\n'
    );
  }
  const lines = items
    .filter((item): item is CompletedWorkEvidence => Boolean(item && typeof item === 'object'))
    .slice(-LEDGER_BLOCK_ITEMS)
    .map(
      (item) =>
        `- [${item.source ?? 'work'}] ${item.summary ?? ''}${item.evidence ? ` (evidence: ${item.evidence})` : ''}`,
    );
  return (
    `${COMPLETED_WORK_LEDGER_MARKER}\n` +
    'Work already completed this session — do not redo it; build on it:\n' +
    lines.join('\n')
  );
}

/** Build the current volatile completed-work block without mutating the prompt. */
export function buildCompletedWorkLedgerBlock(ctx: AgentContext): TextBlock | undefined {
  const items = ensureEvidence(ctx).completedWork;
  if (items.length === 0) return undefined;
  // Deliberately marker-free: this block changes whenever work completes, and
  // it rides the live-context tail AFTER the deep cache boundary — a
  // per-request addition that costs nothing in prefix churn.
  return {
    type: 'text',
    text: formatCompletedWorkLedger(items),
  };
}

/**
 * @deprecated Volatile state must be composed at request time. Kept as a
 * compatibility no-op for embedders importing the old helper.
 */
export function syncCompletedWorkLedgerBlock(_ctx: AgentContext): void {
  // Intentionally empty. Mutating ctx.systemPrompt invalidates provider prefix caches.
}

function isGoalish(text: string): boolean {
  return /\b(goal|objective|task|need|want|implement|fix|improve|refactor|add|remove|hedef|amac|istiyorum|gerekiyor|iyilestir|duzelt|ekle|kaldir)\b/i.test(
    text,
  );
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function pushUniqueBounded(list: string[], value: string, max: number): void {
  const normalized = normalizeWhitespace(value);
  /* v8 ignore next -- unreachable: every caller passes already-normalized non-empty text */
  if (!normalized) return;
  const existing = list.findIndex((item) => item.toLowerCase() === normalized.toLowerCase());
  if (existing >= 0) list.splice(existing, 1);
  list.push(normalized);
  if (list.length > max) list.splice(0, list.length - max);
}

function extractFiles(
  ctx: AgentContext,
  toolName: string,
  input: unknown,
  content: string,
): string[] {
  const out = new Set<string>();
  for (const value of inputPathValues(input)) addPath(ctx, out, value);

  if (toolName === 'grep' || toolName === 'glob' || toolName === 'bash') {
    const re = /(?:(?:[A-Za-z]:)?[./\\]?[\w@.-]+(?:[\\/][\w@(). -]+)+\.[A-Za-z0-9]{1,12})/g;
    for (const match of content.matchAll(re)) addPath(ctx, out, match[0]);
  }

  return [...out].slice(0, 30);
}

function inputPathValues(input: unknown): string[] {
  const values: string[] = [];
  const visit = (value: unknown, key?: string): void => {
    if (typeof value === 'string') {
      if (key && /^(path|file|files|fromFile|toFile|dir|cwd)$/i.test(key)) values.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) visit(v, k);
  };
  visit(input);
  return values;
}

function addPath(ctx: AgentContext, out: Set<string>, raw: string): void {
  const clean = raw.trim().replace(/^["'`]+|["'`),;:]+$/g, '');
  if (!clean || clean.length > 260) return;
  let normalized = clean.replace(/\\/g, '/');
  try {
    const abs = path.isAbsolute(clean) ? path.resolve(clean) : null;
    if (abs) {
      const rel = path.relative(ctx.projectRoot, abs);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        normalized = rel.replace(/\\/g, '/');
      }
    }
  } catch {
    // Keep the best-effort normalized string.
  }
  if (normalized.length > 0) out.add(normalized);
}

function extractSymbols(content: string, input: unknown): string[] {
  const out = new Set<string>();
  const patterns = [
    /\b(?:function|class|interface|type|enum|const|let|var|def|fn|struct)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  ];
  for (const re of patterns) {
    for (const match of content.matchAll(re)) {
      if (match[1]) out.add(match[1]);
      if (out.size >= 30) break;
    }
  }

  const pattern =
    input && typeof input === 'object' ? (input as Record<string, unknown>)['pattern'] : undefined;
  if (typeof pattern === 'string' && /^[A-Za-z_$][\w$]*$/.test(pattern)) {
    out.add(pattern);
  }

  return [...out].slice(0, 30);
}

function extractCommands(toolName: string, input: unknown): string[] {
  if (toolName !== 'bash' && toolName !== 'exec' && toolName !== 'shell') return [];
  if (!input || typeof input !== 'object') return [];
  const command = (input as Record<string, unknown>)['command'];
  if (typeof command !== 'string') return [];
  return [command.slice(0, 220)];
}

function extractErrors(content: string): string[] {
  const allLines = content.split(/\r?\n/);
  // Only scan the last N lines — errors and stack traces surface at the
  // bottom of tool output. Scanning all lines means one regex test per line,
  // so a 2000-line file read costs 2000 regex evaluations for no gain since
  // the interesting errors are always at the tail.
  const lines =
    allLines.length > EXTRACT_ERROR_TAIL_LINES
      ? allLines.slice(-EXTRACT_ERROR_TAIL_LINES)
      : allLines;
  const errors: string[] = [];
  for (const line of lines) {
    if (
      !/\b(error|exception|failed|failure|fatal|panic|timeout|denied|enoent|eacces|eperm|typeerror|syntaxerror)\b/i.test(
        line,
      )
    )
      continue;
    errors.push(normalizeWhitespace(line).slice(0, 260));
    if (errors.length >= 5) break;
  }
  return errors;
}

function summarizeInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['path', 'file', 'pattern', 'glob', 'command']) {
    const value = obj[key];
    if (typeof value === 'string') parts.push(`${key}=${value.slice(0, 160)}`);
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function summarizeToolOutput(
  toolName: string,
  input: unknown,
  content: string,
  opts: { files: string[]; symbols: string[]; errors: string[]; ok: boolean },
): string {
  if (!opts.ok && opts.errors.length > 0) return opts.errors[0] ?? `${toolName} failed`;
  if (toolName === 'read' && opts.files[0]) return `read ${opts.files[0]}`;
  if (toolName === 'grep') {
    const pattern =
      input && typeof input === 'object'
        ? (input as Record<string, unknown>)['pattern']
        : undefined;
    return `searched ${typeof pattern === 'string' ? pattern : 'pattern'} (${opts.files.length} file hint(s))`;
  }
  if ((toolName === 'edit' || toolName === 'write') && opts.files[0]) {
    return `${toolName === 'write' ? 'wrote' : 'edited'} ${opts.files[0]}`;
  }
  const firstLine = normalizeWhitespace(content.split(/\r?\n/).find((line) => line.trim()) ?? '');
  return firstLine ? firstLine.slice(0, 220) : `${toolName} returned no text`;
}

function updateFileGraph(state: ContextEvidenceState, metadata: ToolOutputMetadata): void {
  const writes = WRITE_TOOLS.has(metadata.toolName) ? 1 : 0;
  const reads =
    writes === 0 && (READ_TOOLS.has(metadata.toolName) || metadata.files.length > 0) ? 1 : 0;
  for (const file of metadata.files) {
    const existing = state.fileGraph[file] ?? {
      path: file,
      reads: 0,
      writes: 0,
      tools: [],
      referenced: false,
    };
    existing.reads += reads;
    existing.writes += writes;
    existing.lastToolUseId = metadata.toolUseId;
    pushUniqueBounded(existing.tools, `${metadata.toolName}#${metadata.toolUseId}`, 8);
    state.fileGraph[file] = existing;
  }
}

function updateRepeatedReadSignals(
  state: ContextEvidenceState,
  metadata: ToolOutputMetadata,
): void {
  if (metadata.toolName !== 'read' || metadata.files.length === 0) {
    state.lastReadPath = undefined;
    return;
  }
  const file = metadata.files[0] as string;
  if (state.lastReadPath === file) {
    const existing = state.repeatedReads.find((item) => item.file === file);
    if (existing) {
      existing.count++;
      existing.lastToolUseId = metadata.toolUseId;
    } else {
      state.repeatedReads.push({ file, count: 2, lastToolUseId: metadata.toolUseId });
    }
    if (state.repeatedReads.length > 10) state.repeatedReads.shift();
  }
  state.lastReadPath = file;
}

function implicitFactFor(metadata: ToolOutputMetadata): string | undefined {
  if (metadata.errors.length > 0)
    return `${metadata.toolName}#${metadata.toolUseId} exposed error: ${metadata.errors[0]}`;
  if (metadata.toolName === 'read' && metadata.files[0]) {
    const size = metadata.outputLines ? ` (${metadata.outputLines} line(s) returned)` : '';
    return `read ${metadata.files[0]}${size}`;
  }
  if ((metadata.toolName === 'edit' || metadata.toolName === 'write') && metadata.files[0]) {
    return `${metadata.toolName} changed ${metadata.files[0]}`;
  }
  if (metadata.status === 'referenced')
    return `${metadata.toolName}#${metadata.toolUseId} was referenced`;
  return undefined;
}

function metadataReferencedByText(metadata: ToolOutputMetadata, haystack: string): boolean {
  if (!metadata || typeof metadata !== 'object' || typeof haystack !== 'string') return false;
  if (Array.isArray(metadata.files)) {
    for (const file of metadata.files) {
      if (typeof file !== 'string') continue;
      const f = file.toLowerCase();
      const base = path.basename(file).toLowerCase();
      if (f && haystack.includes(f)) return true;
      if (base && haystack.includes(base)) return true;
    }
  }
  if (Array.isArray(metadata.symbols)) {
    for (const symbol of metadata.symbols) {
      if (typeof symbol === 'string' && symbol.length >= 3 && haystack.includes(symbol.toLowerCase())) return true;
    }
  }
  if (Array.isArray(metadata.errors)) {
    for (const err of metadata.errors) {
      if (typeof err === 'string') {
        const head = err.slice(0, 80).toLowerCase();
        if (head.length >= 12 && haystack.includes(head)) return true;
      }
    }
  }
  return false;
}
