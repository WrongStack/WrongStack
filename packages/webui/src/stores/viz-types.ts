import type { VizEvent, VizEventKind } from '@wrongstack/project-surfaces/office/types';

// ── Event types ───────────────────────────────────────────────────────

export type {
  VizEvent,
  VizEventKind,
} from '@wrongstack/project-surfaces/office/types';

/** Active connection between two nodes in the flow graph. */
export interface VizEdge {
  id: string;
  source: string;
  target: string;
  kind: VizEventKind;
  label: string;
  /** Flow intensity 0–1 for animation speed/opacity */
  intensity: number;
  /** Color for the edge */
  color: string;
  /** When this edge was last active */
  lastActiveAt: number;
  /** Cumulative magnitude (tokens, calls, etc.) */
  totalMagnitude: number;
}

/** Node in the flow graph — represents a live entity. */
export interface VizNode {
  id: string;
  kind: 'provider' | 'agent' | 'tool' | 'mailbox' | 'session' | 'system' | 'error' | 'coordinator';
  label: string;
  sublabel?: string | undefined;
  status: 'idle' | 'active' | 'streaming' | 'completed' | 'error';
  /** 0–1 activity level for glow/pulse */
  activity: number;
  /** Color theme */
  color: string;
  /** Provider/model info */
  provider?: string | undefined;
  model?: string | undefined;
  /** For agents: stats */
  iterations?: number | undefined;
  toolCalls?: number | undefined;
  costUsd?: number | undefined;
  ctxPct?: number | undefined;
  ctxTokens?: number | undefined;
  maxContext?: number | undefined;
  /** For agents: current tool name */
  currentTool?: string | undefined;
  /** For agents: session id */
  sessionId?: string | undefined;
  /** Magnitude for sizing */
  magnitude?: number | undefined;
  /** When this node was last updated */
  lastSeenAt: number;
  /** Position hints for the layout engine */
  positionHint?:
    | { zone: 'left' | 'center' | 'right' | 'top' | 'bottom'; order: number }
    | undefined;
}

// ── Store state ───────────────────────────────────────────────────────

export interface VizState {
  /** Ring buffer of recent events — newest first. */
  events: VizEvent[];
  /**
   * Tool-only archive for slower UI surfaces such as Agent Office.
   * Keeping it separate prevents chat/provider traffic from evicting a
   * read/write action before a person has had time to see it.
   */
  toolEvents: VizEvent[];
  /** Live nodes in the flow graph. */
  nodes: Map<string, VizNode>;
  /** Active edges between nodes. */
  edges: Map<string, VizEdge>;
  /** Whether the visualization is actively running. */
  isActive: boolean;
  /** Max events to keep in the ring buffer. */
  maxEvents: number;
  /** Counters for the HUD */
  counters: {
    totalTokens: number;
    totalCost: number;
    totalToolCalls: number;
    activeAgents: number;
    completedTasks: number;
    errors: number;
    mailboxMessages: number;
  };

  // Actions
  pushEvent: (event: VizEvent) => void;
  upsertNode: (
    node: Partial<VizNode> & { id: string; kind: VizNode['kind']; label: string },
  ) => void;
  removeNode: (id: string) => void;
  upsertEdge: (
    edge: Partial<VizEdge> & {
      id: string;
      source: string;
      target: string;
      kind: VizEdge['kind'];
      label: string;
    },
  ) => void;
  removeEdge: (id: string) => void;
  clear: () => void;
  setActive: (active: boolean) => void;
  decayActivity: () => void;
  prunesStale: (olderThan: number) => void;
}

export const NODE_COLORS: Record<string, string> = {
  provider: 'hsl(var(--info))',
  agent: 'hsl(var(--primary))',
  // `VizNode['kind']` has always included 'coordinator' and `inferKind` returns
  // it for a leader/coordinator source, but this table had no entry for it — so
  // every coordinator node came out with `color: undefined`.
  coordinator: 'hsl(var(--accent-foreground))',
  tool: 'hsl(var(--warning))',
  mailbox: 'hsl(var(--success))',
  session: 'hsl(var(--primary))',
  system: 'hsl(var(--muted-foreground))',
  success: 'hsl(var(--success))',
  error: 'hsl(var(--destructive))',
};

export const EDGE_COLORS: Record<string, string> = {
  'provider:call': 'hsl(var(--info))',
  'provider:delta': 'hsl(var(--primary))',
  'agent:tool': 'hsl(var(--warning))',
  'mailbox:send': 'hsl(var(--success))',
  default: 'hsl(var(--muted-foreground))',
};
