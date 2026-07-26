export interface ProjectAgentConfig {
  /**
   * Static tool allowlist override. When set, replaces the catalog tools
   * entirely (not merged). Omit to keep catalog defaults.
   */
  tools?: string[] | undefined;
  /** Static skill name override. Replaces catalog skillNames entirely. */
  skillNames?: string[] | undefined;
  /**
   * Budget overrides. Each field individually overrides the catalog budget.
   */
  budget?:
    | {
        timeoutMs?: number | undefined;
        idleTimeoutMs?: number | undefined;
        maxIterations?: number | undefined;
        maxToolCalls?: number | undefined;
        maxTokens?: number | undefined;
        maxCostUsd?: number | undefined;
      }
    | undefined;
  /** Provider/model override for this role within the project. */
  provider?: string | undefined;
  model?: string | undefined;
  modelPolicy?:
    | {
        allowed: Array<{ provider: string; model: string }>;
        fallbacks?: Array<{ provider: string; model: string }> | undefined;
        strict?: boolean | undefined;
      }
    | undefined;
  fallbackProfile?: string | undefined;
  /** Project-relative directory, resolved inside the assigned checkout/worktree. */
  cwd?: string | undefined;
  worktree?: boolean | 'auto' | 'required' | 'off' | undefined;
  availability?:
    | {
        timezone: string;
        days: number[];
        start: string;
        end: string;
        mode?: 'advisory' | 'enforce' | undefined;
      }
    | undefined;
  /**
   * Allowed capability overrides. Replaces catalog capabilities entirely.
   */
  allowedCapabilities?: readonly string[] | undefined;
}

/** Durable definition for a project-created roster role. */
export interface ProjectAgentProfile {
  role: string;
  name: string;
  baseRole: string;
  purpose: string;
  taskTypes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectAgentInput {
  role?: string | undefined;
  name: string;
  purpose: string;
  taskTypes: string[];
  baseRole?: string | undefined;
}

export interface LearnedCaptureResult {
  role: string;
  captured: number;
  skipped: number;
  status: 'captured' | 'disabled' | 'empty_output' | 'no_blocks' | 'guarded' | 'quality_rejected';
  reason?: string | undefined;
}

/**
 * Current-knowledge manifest for a role: what live facts the agent should
 * fetch on every spawn to avoid hallucinating stale versions.
 */
export interface RoleKnowledgeManifest {
  role: string;
  /** Registry endpoints to query at spawn time, keyed by topic. */
  liveQueries: Record<string, { registry: string; key: string; description: string }>;
  /**
   * Human-readable checklist: "before answering questions about X, verify Y
   * from the live registry". Injected verbatim into the subagent prompt.
   */
  checklist: string[];
  /**
   * Minimum confidence threshold before the role should re-verify a live
   * source rather than relying on its own training data (0.0-1.0). Default 0.5.
   */
  verifyThreshold: number;
}
