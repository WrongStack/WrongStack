import * as path from 'node:path';
import type { RunResult } from '../core/agent-types.js';
import type { Context } from '../core/context.js';
import type { OneShotOrchestrator } from '../execution/one-shot-llm.js';
import type { AfterRunHook, AgentExtension } from '../extension/extension-points.js';
import type { MemoryEntry, MemoryStore } from '../types/memory.js';
import type { Provider } from '../types/provider.js';
import {
  readBundledInstructionText,
  renderInstructionTemplate,
} from '../utils/instruction-file.js';

// ── Types ───────────────────────────────────────────────────────────────

/**
 * Minimal interface for writing to SAGE without importing
 * @wrongstack/sage (core cannot depend on sage).
 * Tools like the consolidator use this to route adds through
 * rememberSage rather than the legacy MemoryStore.remember(),
 * making them visible to searchSage/turn-middleware.
 */
type ConsolidatorSageKind =
  | 'fact'
  | 'decision'
  | 'convention'
  | 'preference'
  | 'anti_pattern'
  | 'warning'
  | 'workflow'
  | 'bug_root_cause'
  | 'file_note'
  | 'symbol_note'
  | 'command_note'
  | 'session_digest';

interface ConsolidatorMemoryAnchor {
  type: 'file' | 'directory' | 'symbol' | 'package' | 'command' | 'test' | 'git';
  path?: string | undefined;
  symbol?: string | undefined;
  command?: string | undefined;
}

interface ConsolidatorSageRecord {
  text: string;
  scope?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface ConsolidatorSage {
  rememberSage(input: {
    text: string;
    scope?: string | undefined;
    kind?: ConsolidatorSageKind | undefined;
    tags?: string[] | undefined;
    priority?: string | undefined;
    importance?: number | undefined;
    confidence?: number | undefined;
    persistence?: 'long_lived' | 'short_lived' | undefined;
    anchors?: ConsolidatorMemoryAnchor[] | undefined;
    sources?: Array<{ type: string; sessionId?: string | undefined }> | undefined;
    ownerSessionId?: string | undefined;
    expiresAt?: string | undefined;
  }): Promise<unknown>;
  listSage?(statuses?: Array<'active'>): Promise<unknown[]>;
  searchSage?(
    query: string,
    opts?: { limit?: number; scope?: 'project'; includeStatuses?: Array<'active'> },
  ): Promise<unknown[]>;
}

function isSageRecord(value: unknown): value is ConsolidatorSageRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { text?: unknown }).text === 'string'
  );
}

function toPromptEntries(records: unknown[], limit: number): MemoryEntry[] {
  return records
    .filter(isSageRecord)
    .filter((record) => record.scope === 'project')
    .slice(0, limit)
    .map((record) => ({
      scope: 'project-memory',
      text: record.text,
      ts: record.updatedAt ?? record.createdAt ?? '',
    }));
}

function toSageKind(type: string | undefined): ConsolidatorSageKind {
  switch (type) {
    case 'decision':
    case 'convention':
    case 'preference':
    case 'anti_pattern':
    case 'warning':
    case 'workflow':
    case 'bug_root_cause':
    case 'file_note':
    case 'symbol_note':
    case 'command_note':
      return type;
    case 'reference':
      return 'file_note';
    default:
      return 'fact';
  }
}

function importanceFromPriority(priority: string | undefined): number {
  switch (priority) {
    case 'critical':
      return 0.95;
    case 'high':
      return 0.8;
    case 'medium':
      return 0.55;
    case 'low':
      return 0.25;
    default:
      return 0.6;
  }
}

export interface ConsolidationOp {
  /**
   * Add-only by design. The consolidator runs unattended after every
   * successful session, so LLM-issued delete/edit ops used to give an
   * unsupervised model a substring-matched deletion path over the whole
   * memory store (see the 2026-07 mass-deletion postmortem). Removals and
   * corrections belong to explicit review flows (memory_delete /
   * memory_update / ReviewQueue), never to this hook.
   */
  action: 'add';
  /** The fact to remember. */
  text?: string | undefined;
  /** Memory type for categorization. */
  type?: string | undefined;
  /** Tags for grouping. */
  tags?: string[] | undefined;
  /** Priority level. */
  priority?: string | undefined;
  /** Confidence that the statement is durable and supported by the evidence. */
  confidence?: number | undefined;
  /** Concrete retrieval anchors grounded in files, symbols, packages, tests, or commands touched. */
  anchors?: ConsolidatorMemoryAnchor[] | undefined;
}

interface ConsolidationResponse {
  operations: ConsolidationOp[];
  summary?: string | undefined;
}

export interface MemoryConsolidatorOptions {
  memoryStore: MemoryStore;
  /**
   * Optional SAGE writer. When provided, the consolidator routes
   * adds through `rememberSage()` and reads existing entries for dedup
   * context via `searchSage()` instead of the legacy `MemoryStore`.
   * This makes consolidator-sourced memories visible to the turn-middleware
   * (searchSage, retrieveForPath) which only queries SAGE.
   */
  Sage?: ConsolidatorSage | undefined;
  /**
   * Provider used for the consolidation LLM call. Uses the session's
   * provider by default.
   */
  provider?: Provider | undefined;
  /**
   * Model override for the consolidation call. Uses the session's model
   * by default. A smaller/faster model is recommended (e.g. deepseek-chat, haiku, flash).
   */
  model?: string | undefined;
  /**
   * Minimum session iterations before consolidation fires.
   * Sessions shorter than this are skipped (default 2).
   */
  minIterations?: number | undefined;
  /**
   * Maximum memory entries to include in the prompt as context.
   */
  maxExistingEntries?: number | undefined;
  /**
   * OneShotOrchestrator for the consolidation LLM call. When set, uses
   * it instead of the direct provider.complete() path, gaining fallback
   * chain support and cheap-model defaulting.
   */
  oneShotOrchestrator?: OneShotOrchestrator | undefined;
}

// ── Prompt ──────────────────────────────────────────────────────────────

function buildConsolidationPrompt(
  finalText: string,
  iterations: number,
  existingEntries: MemoryEntry[],
  evidence: string,
): string {
  const existingBlock =
    existingEntries.length > 0
      ? `\n\nExisting memory entries:\n${existingEntries
          .map((e) => `- [${e.ts.slice(0, 10)}] ${e.text}`)
          .join('\n')}`
      : '';

  return renderInstructionTemplate(readBundledInstructionText('llm/memory-consolidator.md'), {
    iterations: String(iterations),
    summary: finalText.slice(0, 3000),
    evidence,
    existingEntries: existingBlock,
  });
}

function relativeEvidencePath(projectRoot: string, filePath: string): string {
  const relative = path.relative(projectRoot, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.replaceAll('\\', '/')
    : filePath.replaceAll('\\', '/');
}

function safeCommandEvidence(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const command = value.trim().replace(/\s+/g, ' ').slice(0, 300);
  if (!command) return undefined;
  if (/(?:password|passwd|secret|token|api[_-]?key|authorization|bearer)\s*[:=]/i.test(command)) {
    return '[redacted sensitive command]';
  }
  return command;
}

function buildSessionEvidence(ctx: Context): string {
  const projectRoot = ctx.projectRoot ?? ctx.cwd ?? '';
  const read = [...(ctx.readFiles ?? [])]
    .slice(-20)
    .map((file) => relativeEvidencePath(projectRoot, file));
  const written = [...(ctx.writtenFiles ?? [])]
    .slice(-20)
    .map((file) => relativeEvidencePath(projectRoot, file));
  const commands = (ctx.sideEffects ?? []).slice(-10).map((effect) => ({
    tool: effect.toolName,
    risk: effect.risk,
    command: safeCommandEvidence(effect.input['command']),
    outcome: effect.outcome?.slice(0, 160),
  }));
  const completedTodos = (ctx.todos ?? [])
    .filter((todo) => todo.status === 'completed')
    .slice(-10)
    .map((todo) => todo.content.slice(0, 240));

  return JSON.stringify(
    {
      projectRoot: projectRoot.replaceAll('\\', '/'),
      readFiles: read,
      writtenFiles: written,
      commands,
      completedTodos,
      kanban: ctx.currentKanbanTaskId
        ? { boardId: ctx.currentKanbanBoardId, taskId: ctx.currentKanbanTaskId }
        : undefined,
    },
    null,
    2,
  ).slice(0, 6000);
}

function normalizeConsolidatorAnchors(value: unknown): ConsolidatorMemoryAnchor[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed = new Set<ConsolidatorMemoryAnchor['type']>([
    'file',
    'directory',
    'symbol',
    'package',
    'command',
    'test',
    'git',
  ]);
  const anchors: ConsolidatorMemoryAnchor[] = [];
  for (const raw of value.slice(0, 5)) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Record<string, unknown>;
    if (!allowed.has(candidate['type'] as ConsolidatorMemoryAnchor['type'])) continue;
    const anchor: ConsolidatorMemoryAnchor = {
      type: candidate['type'] as ConsolidatorMemoryAnchor['type'],
    };
    if (typeof candidate['path'] === 'string' && candidate['path'].trim()) {
      anchor.path = candidate['path'].trim().slice(0, 500);
    }
    if (typeof candidate['symbol'] === 'string' && candidate['symbol'].trim()) {
      anchor.symbol = candidate['symbol'].trim().slice(0, 300);
    }
    if (typeof candidate['command'] === 'string' && candidate['command'].trim()) {
      anchor.command = safeCommandEvidence(candidate['command']);
    }
    anchors.push(anchor);
  }
  return anchors.length > 0 ? anchors : undefined;
}

function normalizeConfidence(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0.5, Math.min(1, value))
    : 0.78;
}

// ── Consolidator ────────────────────────────────────────────────────────

export class SessionMemoryConsolidator implements AgentExtension {
  name = 'session-memory-consolidator';
  owner = 'core';

  private readonly memoryStore: MemoryStore;
  private readonly Sage?: ConsolidatorSage | undefined;
  private readonly provider?: Provider | undefined;
  private readonly model?: string | undefined;
  private readonly minIterations: number;
  private readonly maxExistingEntries: number;
  private readonly oneShotOrchestrator?: OneShotOrchestrator | undefined;

  constructor(opts: MemoryConsolidatorOptions) {
    this.memoryStore = opts.memoryStore;
    this.Sage = opts.Sage;
    this.provider = opts.provider;
    this.model = opts.model;
    // Every meaningful run is eligible. The LLM still returns an empty
    // operation list when the turn contains no durable project knowledge.
    this.minIterations = opts.minIterations ?? 1;
    this.maxExistingEntries = opts.maxExistingEntries ?? 15;
    this.oneShotOrchestrator = opts.oneShotOrchestrator;
  }

  afterRun: AfterRunHook = async (ctx: Context, result: RunResult) => {
    // Only consolidate successful sessions with meaningful output
    if (result.status !== 'done') return;
    if (!result.finalText || result.finalText.trim().length < 20) return;
    if (result.iterations < this.minIterations) return;

    const provider = this.provider ?? ctx.provider;
    if (!provider?.complete) return;

    // Capture narrowed values for the fire-and-forget closure.
    const _finalText: string = result.finalText;
    const _iterations: number = result.iterations;
    const _model: string | undefined = this.model ?? ctx.model;
    const _sessionId: string = ctx.session.id;
    const _evidence = buildSessionEvidence(ctx);

    // Await the write boundary. A fire-and-forget consolidator could be killed
    // when the process/session closed immediately after a response, making
    // supposedly durable memory depend on teardown timing.
    try {
      // Load existing memory through the same backend contract used for writes.
      // SQLite-shaped SAGE stores intentionally do not implement the
      // legacy MemoryStore.list() interface.
      let existingEntries: MemoryEntry[];
      if (this.Sage) {
        const records = this.Sage.listSage
          ? await this.Sage.listSage(['active'])
          : ((await this.Sage.searchSage?.('', {
              limit: this.maxExistingEntries,
              scope: 'project',
              includeStatuses: ['active'],
            })) ?? []);
        existingEntries = toPromptEntries(records, this.maxExistingEntries);
      } else {
        existingEntries = await this.memoryStore.list('project-memory', this.maxExistingEntries);
      }
      const prompt = buildConsolidationPrompt(_finalText, _iterations, existingEntries, _evidence);

      // Call the LLM with a focused, one-shot prompt
      let text: string;
      if (this.oneShotOrchestrator) {
        const oneShotResult = await this.oneShotOrchestrator.call({
          system: prompt,
          userPrompt: 'Review the session and return memory operations as JSON.',
          model: _model ?? 'deepseek-chat',
          maxTokens: 500,
          timeoutMs: 15_000,
        });
        text = oneShotResult.text;
      } else {
        // Legacy path: direct provider.complete()
        const signal = AbortSignal.timeout(15_000);
        const response = await provider.complete(
          {
            model: _model,
            system: [{ type: 'text', text: prompt }],
            messages: [
              { role: 'user', content: 'Review the session and return memory operations as JSON.' },
            ],
            maxTokens: 500,
          },
          { signal },
        );
        text = response.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim();
      }
      if (!text) return;

      // Extract JSON from possible markdown wrapper
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const parsed: ConsolidationResponse = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed.operations) || parsed.operations.length === 0) return;

      // Apply operations (add-only: anything else the model emits is ignored)
      let added = 0;

      for (const op of parsed.operations.slice(0, 5)) {
        try {
          if (!op || typeof op !== 'object' || op.action !== 'add') continue;
          if (typeof op.text !== 'string' || !op.text.trim()) continue;
          const memoryText = op.text.trim();

          if (this.Sage) {
            // Translate the legacy prompt enum before crossing the SAGE
            // memory boundary; reference is represented as file_note there.
            await this.Sage.rememberSage({
              text: memoryText,
              scope: 'project',
              kind: toSageKind(op.type),
              tags: op.tags,
              importance: importanceFromPriority(op.priority),
              confidence: normalizeConfidence(op.confidence),
              persistence: 'long_lived',
              anchors: normalizeConsolidatorAnchors(op.anchors),
              sources: [{ type: 'session', sessionId: _sessionId }],
            });
          } else {
            // Legacy path: write to the markdown-based MemoryStore.
            await this.memoryStore.remember(memoryText, undefined, {
              type: op.type as MemoryEntry['type'],
              tags: op.tags,
              priority: op.priority as MemoryEntry['priority'],
            });
          }
          added++;
        } catch {
          // One malformed or backend-rejected item must not discard later
          // valid additions from the same consolidation batch.
        }
      }

      if (added > 0) {
        // Log to stderr so it surfaces in the terminal
        process.stderr.write(`[memory] Session consolidation: ${added} added\n`);
      }

      // Session digest: short-lived outcome summary for resume / continuity.
      // Separate from project facts so digests expire without polluting long_lived corpus.
      if (this.Sage?.rememberSage) {
        try {
          const digestBody = buildSessionDigestText(_finalText, _iterations, added);
          if (digestBody) {
            const expires = new Date(Date.now() + 14 * 24 * 60 * 60_000).toISOString();
            await this.Sage.rememberSage({
              text: digestBody,
              scope: 'session',
              kind: 'session_digest',
              importance: 0.4,
              confidence: 0.65,
              persistence: 'short_lived',
              tags: ['session_digest', 'auto'],
              anchors: [],
              sources: [{ type: 'session', sessionId: _sessionId }],
              ownerSessionId: _sessionId,
              expiresAt: expires,
            });
          }
        } catch {
          // Digest is best-effort; never fail the consolidator.
        }
      }
    } catch {
      // Best-effort: extension failures never fail an otherwise successful run.
    }
  };
}

function buildSessionDigestText(
  finalText: string,
  iterations: number,
  factsAdded: number,
): string | undefined {
  const cleaned = finalText.replace(/\s+/g, ' ').trim();
  if (cleaned.length < 40) return undefined;
  const summary = cleaned.slice(0, 400);
  return (
    `Session digest (${iterations} iter${factsAdded > 0 ? `, ${factsAdded} facts added` : ''}): ` +
    summary +
    (cleaned.length > 400 ? '…' : '')
  );
}
