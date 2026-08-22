import { createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { SessionEvent, SessionMetadata, SessionSummary } from '../types/session.js';
import { sessionContentPreview, userInputTitle } from './session-helpers.js';

export interface SessionSummaryTrackerOptions {
  id: string;
  startedAt: string;
  meta: Omit<SessionMetadata, 'startedAt'>;
  resumed?: boolean | undefined;
  initialSummary?: SessionSummary | undefined;
  resolveName?: (() => Promise<Pick<SessionSummary, 'name'> | null>) | undefined;
}

export class SessionSummaryTracker {
  private readonly id: string;
  private readonly startedAt: string;
  private readonly meta: Omit<SessionMetadata, 'startedAt'>;
  private readonly resumed: boolean;
  private readonly resolveNameCb?: (() => Promise<Pick<SessionSummary, 'name'> | null>) | undefined;

  private summary: SessionSummary;
  private tokenIn = 0;
  private tokenOut = 0;
  private baseTokenTotal = 0;

  private iterationCount = 0;
  private toolCallCount = 0;
  private toolErrorCount = 0;
  private toolBreakdown: Record<string, number> = {};
  private fileChangeCount = 0;
  private compactionCount = 0;
  private messageCount = 0;
  private lastUserMessage: string | undefined;
  private lastActivityAt: string;
  private outcome: SessionSummary['outcome'] = undefined;
  private openToolUses = new Set<string>();

  constructor(opts: SessionSummaryTrackerOptions) {
    this.id = opts.id;
    this.startedAt = opts.startedAt;
    this.meta = opts.meta;
    this.resumed = opts.resumed ?? false;
    this.resolveNameCb = opts.resolveName;

    this.summary = opts.initialSummary
      ? { ...opts.initialSummary, id: opts.id }
      : {
          id: opts.id,
          title: '(empty session)',
          startedAt: opts.startedAt,
          model: opts.meta.model ?? 'unknown',
          provider: opts.meta.provider ?? 'unknown',
          tokenTotal: 0,
        };

    this.baseTokenTotal = this.summary.tokenTotal;
    this.iterationCount = this.summary.iterationCount ?? 0;
    this.toolCallCount = this.summary.toolCallCount ?? 0;
    this.toolErrorCount = this.summary.toolErrorCount ?? 0;
    this.toolBreakdown = { ...(this.summary.toolBreakdown ?? {}) };
    this.fileChangeCount = this.summary.fileChangeCount ?? 0;
    this.compactionCount = this.summary.compactionCount ?? 0;
    this.messageCount = this.summary.messageCount ?? 0;
    this.lastUserMessage = this.summary.lastUserMessage;
    this.lastActivityAt = this.summary.lastActivityAt ?? this.summary.endedAt ?? opts.startedAt;
    this.outcome = this.resumed ? undefined : this.summary.outcome;
  }

  get currentSummary(): Readonly<SessionSummary> {
    return this.summary;
  }

  /**
   * Non-destructive materialization of every live counter into a summary
   * snapshot. Unlike finalize(), it stamps no endedAt, applies no final
   * outcome, and resolves no name — mid-session metadata checkpoints use it
   * so a killed process leaves accurate listing metadata behind without
   * pretending the session ended cleanly.
   */
  snapshot(): SessionSummary {
    const { lastUserMessage: _lastUserMessage, ...rest } = this.summary;
    return {
      ...rest,
      messageCount: this.messageCount,
      ...(this.lastUserMessage !== undefined ? { lastUserMessage: this.lastUserMessage } : {}),
      iterationCount: this.iterationCount,
      toolCallCount: this.toolCallCount,
      toolErrorCount: this.toolErrorCount,
      fileChangeCount: this.fileChangeCount,
      compactionCount: this.compactionCount > 0 ? this.compactionCount : undefined,
      toolBreakdown: { ...this.toolBreakdown },
      lastActivityAt: this.lastActivityAt,
      ...(this.outcome !== undefined ? { outcome: this.outcome } : {}),
    };
  }

  get pendingToolUses(): string[] {
    return Array.from(this.openToolUses);
  }

  observe(event: SessionEvent): void {
    const eventActivityMs = Date.parse(event.ts);
    const lastActivityMs = Date.parse(this.lastActivityAt);
    if (
      Number.isFinite(eventActivityMs) &&
      (!Number.isFinite(lastActivityMs) || eventActivityMs > lastActivityMs)
    ) {
      this.lastActivityAt = event.ts;
    }

    if (event.type === 'llm_response') {
      for (const block of event.content) {
        if (block.type === 'tool_use') this.openToolUses.add(block.id);
      }
    }
    if (event.type === 'tool_use') {
      this.openToolUses.add(event.id);
    } else if (event.type === 'tool_call_start') {
      this.toolCallCount++;
      this.toolBreakdown[event.name] = (this.toolBreakdown[event.name] ?? 0) + 1;
    } else if (event.type === 'tool_result') {
      this.openToolUses.delete(event.id);
      if (event.isError) {
        this.toolErrorCount++;
        this.outcome = 'error';
      }
    } else if (event.type === 'file_snapshot') {
      this.fileChangeCount += event.files.length;
    } else if (event.type === 'compaction') {
      this.compactionCount++;
    }

    if (event.type === 'error' || event.type === 'provider_error') {
      this.outcome = 'error';
    }
    if (event.type === 'user_input') {
      if (this.summary.title === '(empty session)') {
        this.summary = { ...this.summary, title: userInputTitle(event.content) };
      }
      this.lastUserMessage = sessionContentPreview(event.content);
      this.messageCount++;
    } else if (event.type === 'llm_response') {
      this.messageCount++;
      this.tokenIn += event.usage.input;
      this.tokenOut += event.usage.output;
      this.summary = {
        ...this.summary,
        tokenTotal: this.baseTokenTotal + this.tokenIn + this.tokenOut,
      };
    } else if (event.type === 'session_end') {
      const total = event.usage.input + event.usage.output;
      if (total > 0) {
        this.summary = {
          ...this.summary,
          tokenTotal: Math.max(this.summary.tokenTotal, total),
        };
      }
    } else if (event.type === 'in_flight_start') {
      this.iterationCount++;
    }
  }

  async recomputeFromDisk(filePath: string): Promise<void> {
    if (!filePath) return;
    const accessible = await fsp
      .access(filePath)
      .then(() => true)
      .catch(() => false);
    if (!accessible) return;

    this.iterationCount = 0;
    this.toolCallCount = 0;
    this.toolErrorCount = 0;
    this.toolBreakdown = {};
    this.fileChangeCount = 0;
    this.compactionCount = 0;
    this.messageCount = 0;
    this.lastUserMessage = undefined;
    this.lastActivityAt = this.startedAt;
    this.outcome = undefined;
    this.openToolUses = new Set<string>();
    this.tokenIn = 0;
    this.tokenOut = 0;
    this.baseTokenTotal = 0;
    const { lastUserMessage: _lastUserMessage, ...summaryWithoutPreview } = this.summary;
    this.summary = {
      ...summaryWithoutPreview,
      title: '(empty session)',
      tokenTotal: 0,
      messageCount: 0,
      lastActivityAt: this.startedAt,
    };

    const input = createReadStream(filePath, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    try {
      for await (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          this.observe(JSON.parse(trimmed) as SessionEvent);
        } catch {
          // Skip malformed line
        }
      }
    } finally {
      lines.close();
      input.destroy();
    }
  }

  async finalize(): Promise<SessionSummary> {
    const endedAt = new Date().toISOString();
    const observedActivityMs = Date.parse(this.lastActivityAt);
    const endedAtMs = Date.parse(endedAt);
    const finalActivityAt =
      Number.isFinite(observedActivityMs) && observedActivityMs > endedAtMs
        ? this.lastActivityAt
        : endedAt;
    const previousName = this.summary.name;
    const {
      lastUserMessage: _lastUserMessage,
      name: _name,
      ...summaryWithoutDisplay
    } = this.summary;

    this.summary = {
      ...summaryWithoutDisplay,
      ...(previousName !== undefined ? { name: previousName } : {}),
      endedAt,
      lastActivityAt: finalActivityAt,
      messageCount: this.messageCount,
      ...(this.lastUserMessage !== undefined ? { lastUserMessage: this.lastUserMessage } : {}),
      iterationCount: this.iterationCount,
      toolCallCount: this.toolCallCount,
      toolErrorCount: this.toolErrorCount,
      fileChangeCount: this.fileChangeCount,
      compactionCount: this.compactionCount > 0 ? this.compactionCount : undefined,
      toolBreakdown: { ...this.toolBreakdown },
      outcome: this.outcome ?? 'completed',
    };

    const resolvedName = this.resolveNameCb ? await this.resolveNameCb().catch(() => null) : null;
    if (resolvedName !== null) {
      const { name: _drop, ...summaryWithoutName } = this.summary;
      this.summary = {
        ...summaryWithoutName,
        ...(resolvedName.name !== undefined ? { name: resolvedName.name } : {}),
      };
    }

    return this.summary;
  }

  reset(resetAt: string): void {
    const explicitName = this.summary.name;
    this.baseTokenTotal = 0;
    this.tokenIn = 0;
    this.tokenOut = 0;
    this.iterationCount = 0;
    this.toolCallCount = 0;
    this.toolErrorCount = 0;
    this.toolBreakdown = {};
    this.fileChangeCount = 0;
    this.compactionCount = 0;
    this.messageCount = 0;
    this.lastUserMessage = undefined;
    this.lastActivityAt = resetAt;
    this.outcome = undefined;
    this.openToolUses = new Set<string>();
    this.summary = {
      id: this.id,
      title: '(empty session)',
      ...(explicitName !== undefined ? { name: explicitName } : {}),
      startedAt: resetAt,
      model: this.meta.model ?? 'unknown',
      provider: this.meta.provider ?? 'unknown',
      tokenTotal: 0,
      lastActivityAt: resetAt,
      messageCount: 0,
    };
  }
}
