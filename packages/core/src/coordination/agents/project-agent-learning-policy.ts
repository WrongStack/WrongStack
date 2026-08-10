import { readFileSync } from 'node:fs';
import { learningPolicyPath, writeTextAtomically } from './project-agent-paths.js';

/** Persistent controls and counters for one roster role's learning loop. */
export interface ProjectAgentLearningPolicy {
  /** Retain knowledge but stop prompt injection and automatic capture when false. */
  enabled: boolean;
  lifetimeCaptureCount: number;
  lastCaptureAt?: string | undefined;
  lastCaptureSource?: 'automatic' | 'manual' | 'taught' | undefined;
  /**
   * When an optimization pass last ran to completion for this role, whatever it
   * managed to do.
   *
   * The auto-optimize cooldown used to read `consolidation.json` alone, which is
   * only written when a model produced a role document. A pass that ran without
   * a model still rewrote every skill addendum and still left no trace, so on a
   * headless box `minIntervalMs` never applied and a full pass re-ran after
   * every capture.
   */
  lastOptimizeAt?: string | undefined;
}

const DEFAULT_LEARNING_POLICY: ProjectAgentLearningPolicy = {
  enabled: true,
  lifetimeCaptureCount: 0,
};

export function loadProjectAgentLearningPolicy(
  role: string,
  projectRoot?: string,
): ProjectAgentLearningPolicy {
  try {
    const parsed = JSON.parse(
      readFileSync(learningPolicyPath(role, projectRoot), 'utf8'),
    ) as Partial<ProjectAgentLearningPolicy>;
    return {
      enabled: parsed.enabled !== false,
      lifetimeCaptureCount:
        typeof parsed.lifetimeCaptureCount === 'number' &&
        Number.isInteger(parsed.lifetimeCaptureCount) &&
        parsed.lifetimeCaptureCount >= 0
          ? parsed.lifetimeCaptureCount
          : 0,
      ...(typeof parsed.lastCaptureAt === 'string' ? { lastCaptureAt: parsed.lastCaptureAt } : {}),
      ...(parsed.lastCaptureSource === 'automatic' ||
      parsed.lastCaptureSource === 'manual' ||
      parsed.lastCaptureSource === 'taught'
        ? { lastCaptureSource: parsed.lastCaptureSource }
        : {}),
      ...(typeof parsed.lastOptimizeAt === 'string'
        ? { lastOptimizeAt: parsed.lastOptimizeAt }
        : {}),
    };
  } catch {
    return { ...DEFAULT_LEARNING_POLICY };
  }
}

/**
 * Merge a patch into the persisted policy.
 *
 * Always re-reads immediately before writing. Capture and the optimization pass
 * both own fields in this file and run on independent schedules, so writing a
 * whole object built from a value read earlier in the call silently reverts
 * whatever the other one recorded in between.
 */
export function updateProjectAgentLearningPolicy(
  role: string,
  patch: Partial<ProjectAgentLearningPolicy>,
  projectRoot?: string,
): ProjectAgentLearningPolicy {
  // An explicitly-undefined field means "leave alone", not "clear": callers
  // build these patches with conditional spreads that can yield undefined.
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<ProjectAgentLearningPolicy>;
  const updated: ProjectAgentLearningPolicy = {
    ...loadProjectAgentLearningPolicy(role, projectRoot),
    ...defined,
  };
  writeTextAtomically(
    learningPolicyPath(role, projectRoot),
    `${JSON.stringify(updated, null, 2)}\n`,
  );
  return updated;
}

/** Stamp the completion of an optimization pass so the cooldown can see it. */
export function recordProjectAgentOptimizePass(
  role: string,
  projectRoot?: string,
  at: string = new Date().toISOString(),
): void {
  try {
    updateProjectAgentLearningPolicy(role, { lastOptimizeAt: at }, projectRoot);
  } catch {
    // The cooldown is an efficiency guard, never a correctness one.
  }
}
