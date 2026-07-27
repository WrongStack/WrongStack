import { create } from 'zustand';

export type SddWizardPhase =
  | 'idle'
  | 'questioning'
  | 'spec_review'
  | 'implementation'
  | 'task_review'
  | 'executing'
  | 'done';

export interface SddWizardSnapshot {
  sessionId: string;
  phase: SddWizardPhase;
  title: string;
  /** Operator's original goal prompt (verbatim); `title` is a short heading. */
  goal?: string;
  questionCount: number;
  minQuestions: number;
  maxQuestions: number;
  answers: Array<{ question: string; answer: string }>;
  /** Last agent utterance — rehydrated on resume so the open question reappears. */
  lastAgentText?: string;
  /** Most recent run id started from this interview (deep-link to live board). */
  lastRunId?: string;
  /** True when the server rehydrated this interview from disk. */
  resumed?: boolean;
  /** Server sent a discard ack (phase idle + discarded). */
  discarded?: boolean;
  spec?: {
    id: string;
    title: string;
    overview: string;
    requirements: Array<{ priority: string; description: string }>;
  };
  graphId?: string;
  taskCount: number;
  /** Decomposed task graph (topological tasks + columns) — drives the DAG reveal. */
  board?: {
    tasks: Array<{
      id: string;
      shortId: string;
      title: string;
      displayStatus:
        | 'pending'
        | 'queued'
        | 'in_progress'
        | 'blocked'
        | 'review'
        | 'failed'
        | 'completed';
      priority: 'critical' | 'high' | 'medium' | 'low';
      deps: string[];
      agentName?: string;
      worktreeBranch?: string;
      retries?: number;
    }>;
    columns: Array<{ label: string; taskIds: string[] }>;
  };
  prompt: string;
  busy: boolean;
}

interface SddWizardState {
  /** Latest interview snapshot, or null before a session starts. */
  snapshot: SddWizardSnapshot | null;
  /** The agent's most recent message (question / spec narration). */
  agentText: string;
  /** Last error surfaced by the server. */
  error: string | null;
  /** runId once a run has been kicked off from the wizard. */
  startedRunId: string | null;
  setSnapshot: (s: SddWizardSnapshot) => void;
  setAgentText: (t: string) => void;
  setError: (e: string | null) => void;
  setStartedRunId: (id: string | null) => void;
  reset: () => void;
}

export const useSddWizardStore = create<SddWizardState>()((set) => ({
  snapshot: null,
  agentText: '',
  error: null,
  startedRunId: null,
  setSnapshot: (snapshot) => {
    // A discard ack clears local state so the goal form returns.
    if (snapshot.discarded || (snapshot.phase === 'idle' && !snapshot.sessionId)) {
      set({ snapshot: null, agentText: '', error: null });
      return;
    }
    set({
      snapshot,
      error: null,
      // Prefer live agent_text events; fall back to persisted lastAgentText on resume.
      ...(snapshot.lastAgentText ? { agentText: snapshot.lastAgentText } : {}),
    });
  },
  setAgentText: (agentText) => set({ agentText }),
  setError: (error) => set({ error }),
  setStartedRunId: (startedRunId) => set({ startedRunId }),
  reset: () => set({ snapshot: null, agentText: '', error: null, startedRunId: null }),
}));
