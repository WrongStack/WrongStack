import { readFileSync } from 'node:fs';
import {
  learningPolicyPath,
  writeTextAtomically,
} from './project-agent-paths.js';

/** Persistent controls and counters for one roster role's learning loop. */
export interface ProjectAgentLearningPolicy {
  /** Retain knowledge but stop prompt injection and automatic capture when false. */
  enabled: boolean;
  lifetimeCaptureCount: number;
  lastCaptureAt?: string | undefined;
  lastCaptureSource?: 'automatic' | 'manual' | 'taught' | undefined;
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
    };
  } catch {
    return { ...DEFAULT_LEARNING_POLICY };
  }
}

export function updateProjectAgentLearningPolicy(
  role: string,
  patch: Partial<Pick<ProjectAgentLearningPolicy, 'enabled'>>,
  projectRoot?: string,
): ProjectAgentLearningPolicy {
  const current = loadProjectAgentLearningPolicy(role, projectRoot);
  const updated = {
    ...current,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
  };
  writeTextAtomically(
    learningPolicyPath(role, projectRoot),
    `${JSON.stringify(updated, null, 2)}\n`,
  );
  return updated;
}
