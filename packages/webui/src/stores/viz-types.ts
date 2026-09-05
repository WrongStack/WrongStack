// ── Event types ───────────────────────────────────────────────────────

/** Categories the cinematic renderer understands. */
export type VizEventKind =
  | 'provider:call' // LLM provider call started
  | 'provider:delta' // Streaming text delta
  | 'provider:response' // Provider response received
  | 'agent:spawned' // Agent (leader or subagent) spawned
  | 'agent:tool' // Agent executed a tool
  | 'agent:status' // Agent status change (running → completed/failed)
  | 'agent:ctx' // Agent context pressure update
  | 'agent:text' // Agent streaming/partial text
  | 'tool:started' // Tool execution started
  | 'tool:executed' // Tool execution completed
  | 'tool:progress' // Tool progress update
  | 'mailbox:send' // Mailbox message sent
  | 'mailbox:deliver' // Mailbox message delivered/read
  | 'collab:event' // Collaboration observer/control event
  | 'memory:event' // SAGE retrieval/verification/hygiene event
  | 'brain:council_vote' // One Brain council seat cast its vote
  | 'session:start' // Session started/resumed
  | 'session:end' // Session ended
  | 'iteration:start' // Iteration started
  | 'iteration:end' // Iteration completed
  | 'eternal:iteration' // Eternal-autonomy journal tick
  | 'error' // Error occurred
  | 'context:compacted' // Context compaction
  | 'context:repaired' // Context repair
  | 'budget:warning' // Agent budget warning
  | 'budget:extended' // Agent budget extended
  | 'cost:update' // Cost/token update
  | 'fleet:snapshot'; // Cross-process fleet snapshot (sessions + agents)

export interface VizEvent {
  id: string;
  kind: VizEventKind;
  timestamp: number;
  /** Source node id (e.g. provider id, agent id, tool name) */
  source: string;
  /** Target node id (optional — e.g. provider for tool calls) */
  target?: string | undefined;
  /** Display label */
  label: string;
  /** Numeric magnitude (tokens, cost, duration) for size/color mapping */
  magnitude?: number | undefined;
  /** Extra structured payload for the renderer */
  data?: Record<string, unknown> | undefined;
  /** The raw WS payload for drill-down in detail panels */
  raw?: unknown;
  /** Grouping key for the flow (e.g. 'iteration:3', 'agent:leader') */
  flowGroup?: string | undefined;
  /** Color hint for the renderer */
  color?: string | undefined;
}

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
