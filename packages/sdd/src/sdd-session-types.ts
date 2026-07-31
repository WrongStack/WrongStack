import type { Specification } from '@wrongstack/core/types';

export type AISpecPhase =
  | 'questioning'
  | 'spec_review'
  | 'implementation'
  | 'task_review'
  | 'executing'
  | 'done';

export interface CollectedAnswer {
  question: string;
  answer: string;
  timestamp: number;
}

export interface AISpecSession {
  id: string;
  phase: AISpecPhase;
  title: string;
  userIntent: string;
  projectContext: string;
  answers: CollectedAnswer[];
  questionCount: number;
  spec?: Specification | undefined;
  implementation?: string | undefined;
  taskGraphId?: string | undefined;
  /** Last agent message shown to the operator for reconnect continuity. */
  lastAgentText?: string | undefined;
  /** Most recent SDD run id started from this interview. */
  lastRunId?: string | undefined;
  approved: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Durable session adapter. Production uses project-scoped Kanban IPC. */
export interface AISpecSessionPersistence {
  load(): Promise<AISpecSession | null>;
  save(session: AISpecSession): Promise<void>;
  delete(): Promise<void>;
}

export function isAISpecSession(value: unknown): value is AISpecSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<AISpecSession>;
  return (
    typeof session.id === 'string' &&
    typeof session.phase === 'string' &&
    typeof session.title === 'string' &&
    typeof session.userIntent === 'string' &&
    Array.isArray(session.answers) &&
    typeof session.updatedAt === 'number'
  );
}
