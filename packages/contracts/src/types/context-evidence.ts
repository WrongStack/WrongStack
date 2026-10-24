export type ToolEvidenceStatus = 'seen' | 'referenced';

export interface ToolOutputMetadata {
  toolUseId: string;
  toolName: string;
  ok: boolean;
  inputSummary?: string | undefined;
  summary: string;
  files: string[];
  symbols: string[];
  commands: string[];
  errors: string[];
  status: ToolEvidenceStatus;
  referenceCount: number;
  seenAt: number;
  referencedAt?: number | undefined;
  outputBytes?: number | undefined;
  outputTokens?: number | undefined;
  outputLines?: number | undefined;
}

export interface ContextFileEvidence {
  path: string;
  reads: number;
  writes: number;
  tools: string[];
  referenced: boolean;
  lastToolUseId?: string | undefined;
}

export interface ContextIntentEvidence {
  text: string;
  updatedAt: number;
}

export interface ContextRepeatedReadEvidence {
  file: string;
  count: number;
  lastToolUseId: string;
}

/** Where a completed-work ledger entry came from. */
export type CompletedWorkSource = 'todo' | 'plan' | 'task' | 'verification' | 'manual';

/**
 * One unit of finished work, kept in the session's completed-work ledger so
 * the model (and a resumed session) can see what is already done and build
 * on it instead of redoing it. Persisted via the completed-work checkpoint
 * (`storage/completed-work-checkpoint.ts`).
 */
export interface CompletedWorkEvidence {
  /** Stable dedupe key — completing the same unit twice updates in place (e.g. "task:<id>"). */
  key: string;
  source: CompletedWorkSource;
  summary: string;
  /** Epoch ms when the work was marked complete. */
  completedAt: number;
  /** Optional pointer to proof (test run, commit hash, file path). */
  evidence?: string | undefined;
}

export interface ContextEvidenceState {
  currentIntent?: ContextIntentEvidence | undefined;
  /** Recent real human inputs, bounded and rendered as volatile continuity evidence. */
  recentUserTurns?: ContextIntentEvidence[] | undefined;
  sessionGoals: string[];
  implicitFacts: string[];
  activeErrors: string[];
  toolCalls: ToolOutputMetadata[];
  fileGraph: Record<string, ContextFileEvidence>;
  repeatedReads: ContextRepeatedReadEvidence[];
  /** Ledger of finished work (tasks, todos, verifications) — see {@link CompletedWorkEvidence}. */
  completedWork: CompletedWorkEvidence[];
  lastReadPath?: string | undefined;
  updatedAt: number;
}
