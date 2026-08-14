/** Whether the background scheduler considers a role due for distillation. */
export interface AutoOptimizeStatus {
  enabled: boolean;
  eligible: boolean;
  reason: string;
}

/** Human wording for the scheduler's decision. */
export const AUTO_REASON_LABEL: Record<string, string> = {
  size: 'buffer reached the size threshold',
  'pending-skills': 'directives are waiting to reach their skill',
  disabled: 'auto-optimization is off',
  'learning-paused': 'learning is paused for this agent',
  'too-few-entries': 'not enough directives yet',
  'below-threshold': 'below the threshold',
  'cooling-down': 'recently optimized — cooling down',
};

/** One skill a role may draw on, with what this project has done to it. */
export interface RoleSkill {
  skill: string;
  developed: boolean;
  affinity: {
    loaded: number;
    succeeded: number;
    failed: number;
    learned: number;
    pinned?: boolean;
  } | null;
  /** Project affinity score. Higher ranks earlier; ties keep the curated order. */
  score?: number;
  /** Whether this skill makes the eager cut and is actually loaded at spawn. */
  eager?: boolean;
}

/** A directive the loop retired after it kept correlating with failed tasks. */
export interface RetiredDirective {
  what: string;
  skill?: string;
}
