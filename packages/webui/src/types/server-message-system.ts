import type { BrainConfigWire } from './brain.js';
import type { SessionScopedPayload } from './protocol-core.js';

export type WSSystemMiscServerMessage =
  | { type: 'tasks.updated'; payload: { tasks: unknown[]; error?: string | undefined } }
  | { type: 'plan.updated'; payload: { plan: unknown | null; error?: string | undefined } }
  | { type: 'specs.list'; payload: { specs: unknown[] } }
  | { type: 'specs.detail'; payload: Record<string, unknown> }
  | { type: 'sdd.board.snapshot'; payload: Record<string, unknown> | null }
  | { type: 'sdd.board.list'; payload: { boards: unknown[] } }
  | {
      type: 'sdd.board.lifecycle_result';
      payload: {
        op: 'cleanup_worktrees' | 'rollback' | 'destroy';
        ok: boolean;
        removed?: number;
        reverted?: number;
        deleted?: string[];
        reason?: string;
      };
    }
  | { type: 'sdd.spec.snapshot'; payload: Record<string, unknown> }
  | { type: 'sdd.spec.agent_text'; payload: { text: string } }
  | { type: 'sdd.spec.error'; payload: { message: string } }
  | {
      type: 'sdd.run.started';
      payload: { runId: string; graphId?: string; specId?: string };
    }
  | {
      type: 'session.checkpoints';
      payload: {
        checkpoints: Array<{
          index: number;
          iteration: number;
          timestamp: string;
          label: string;
          messageCount: number;
          tokens: number;
        }>;
      };
    }
  | { type: 'goal-state.updated'; payload: Record<string, unknown> | null }
  | { type: 'prefs.updated'; payload: Record<string, unknown> }
  | { type: 'system_prompt.info'; payload: WSSystemPromptInfo }
  | { type: 'techstack.job.started'; payload: { jobId: string; kind: 'inventory' | 'analyze' } }
  | {
      type: 'techstack.job.progress';
      payload: { jobId: string; phase: string; completed: number; total: number };
    }
  | {
      type: 'techstack.workspace.completed';
      payload: { jobId: string; workspaceId: string; ecosystem: string; dependencyCount: number };
    }
  | {
      type: 'techstack.snapshot.updated';
      payload: {
        snapshot: import('@/stores/techstack-store').TechStackSnapshot;
        stale?: boolean | undefined;
      };
    }
  | { type: 'techstack.report.ready'; payload: { reportId: string; summary?: string | undefined } }
  | { type: 'techstack.report.delivered'; payload: { deliveryId: string; sessionId: string } }
  | { type: 'techstack.job.failed'; payload: { jobId: string; error: string } }
  | { type: 'techstack.job.cancelled'; payload: { jobId: string } }
  | { type: 'client.status_update'; payload: Record<string, unknown> }
  | { type: 'sessions.status_update'; payload: { sessions: unknown[] } }
  | { type: 'mailbox.event'; payload: Record<string, unknown> & { event: string } }
  | { type: 'mailbox.received'; payload: Record<string, unknown> }
  | { type: 'mailbox.agent_registered'; payload: Record<string, unknown> }
  | { type: 'mailbox.agent_deregistered'; payload: Record<string, unknown> }
  | {
      type: 'mailbox.messages';
      payload: { messages: Array<Record<string, unknown>>; error?: string | undefined };
    }
  | {
      type: 'mailbox.agents';
      payload: { agents: Array<Record<string, unknown>>; error?: string | undefined };
    }
  | {
      type: 'mailbox.sent';
      payload: {
        requestId: string;
        success: boolean;
        messageId?: string | undefined;
        to?: string | undefined;
        audience?: 'all' | 'leaders' | undefined;
        error?: string | undefined;
      };
    }
  | {
      type: 'mailbox.action_result';
      payload: {
        requestId: string;
        success: boolean;
        action?: 'mark-read' | 'acknowledge' | 'reopen' | 'soft-delete' | undefined;
        mailId?: string | undefined;
        error?: string | undefined;
      };
    }
  | { type: 'pong'; payload?: Record<string, unknown> | undefined }
  | {
      type: 'process.list';
      payload: {
        sessionId?: string | undefined;
        processes: Array<{
          pid: number;
          command: string;
          tool: string;
          startedAt: number;
          status: 'running' | 'exited' | 'killed';
          protected?: boolean | undefined;
          background?: boolean | undefined;
          sessionId?: string | undefined;
        }>;
      };
    }
  | {
      type: 'brain.status';
      payload: {
        maxAutoRisk: string;
        log: Array<{ at: number; kind: string; question: string; outcome: string }>;
        mode?: 'headless' | 'interactive' | undefined;
        poolLabels?: string[] | undefined;
        councilLabels?: string[] | undefined;
        judgeLabel?: string | undefined;
        judgeIsVoter?: boolean | undefined;
        ledgerPath?: string | undefined;
      };
    }
  | {
      type: 'brain.config';
      payload: {
        config: BrainConfigWire;
        persisted: boolean;
        error?: string | undefined;
      };
    }
  | {
      type: 'brain.answer';
      payload: SessionScopedPayload & {
        question: string;
        decision: {
          type: string;
          optionId?: string | undefined;
          text?: string | undefined;
          rationale?: string | undefined;
          reason?: string | undefined;
          prompt?: string | undefined;
        };
      };
    }
  | {
      type: 'brain.event';
      payload: SessionScopedPayload & Record<string, unknown> & { event: string };
    }
  | {
      type: 'memory.event';
      payload: SessionScopedPayload & Record<string, unknown> & { event: string };
    }
  | { type: 'session.damaged'; payload: { sessionId: string; detail: string } }
  | {
      type: 'session.rewound';
      payload: SessionScopedPayload & {
        toPromptIndex: number;
        revertedFiles: string[];
        removedEvents: number;
      };
    }
  | {
      type: 'checkpoint.written';
      payload: SessionScopedPayload & {
        promptIndex: number;
        promptPreview: string;
        ts: string;
        fileCount: number;
      };
    }
  | { type: 'in_flight.started'; payload: SessionScopedPayload & { context: string; ts: string } }
  | {
      type: 'in_flight.ended';
      payload: SessionScopedPayload & { reason: 'clean' | 'aborted' | 'recovered'; ts: string };
    }
  | {
      type: 'model.refine_result';
      payload: {
        refined: string;
        english: string;
        error?: string | undefined;
        errorKind?: 'timeout' | 'empty' | 'provider_error' | undefined;
        retryTimeoutMs?: number | undefined;
        fallbackRef?: string | undefined;
        refinedWith?: { provider: string; model: string } | undefined;
      };
    }
  | { type: 'mailbox.cleared'; payload: { error?: string | undefined } }
  | { type: 'mailbox.purged'; payload: Record<string, unknown> & { error?: string | undefined } }
  | {
      type: 'cron.snapshot';
      payload: {
        count: number;
        maxConcurrent: number;
        jobs: Array<{
          name: string;
          intervalMs: number;
          action: string;
          enabled: boolean;
          lastRun: string | null;
          nextRun: string;
          runCount: number;
          overdue: boolean;
        }>;
      };
    }
  | {
      type: 'cron.job_fired';
      payload: { name: string; action: string; runCount: number; ts: string };
    }
  | { type: 'terminal.output'; payload: { id: string; data: string } }
  | {
      type: 'terminal.exit';
      payload: { id: string; exitCode: number; signal?: number | undefined };
    }
  | { type: 'prompts.journal'; payload: WSPromptsJournalPayload };

/** One entry from the hierarchical prompt journal (mirrors core `PromptJournalEntry`). */
export interface WSPromptJournalEntry {
  id: string;
  timestamp: string;
  sessionId: string;
  projectRoot: string;
  role: 'user' | 'system' | 'assistant' | 'tool';
  category: string;
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

export interface WSPromptsJournalPayload {
  enabled: boolean;
  entries: WSPromptJournalEntry[];
  error?: string | undefined;
}

/** One selectable identity-prompt size, with its upper-bound token estimate. */
export interface WSSystemPromptVariantInfo {
  variant: 'lite' | 'default' | 'pro';
  label: string;
  hint: string;
  tokens: number;
}

/**
 * Payload of `system_prompt.info`.
 *
 * `chosen` is false until the user has explicitly picked a variant at least
 * once — the config loader materializes a default variant for every config, so
 * this flag is the only way the browser can tell a fresh install from a
 * deliberate "Standard" and decide whether to open the picker unprompted.
 */
export interface WSSystemPromptInfo {
  current: 'lite' | 'default' | 'pro';
  chosen: boolean;
  variants: WSSystemPromptVariantInfo[];
  error?: string | undefined;
}
