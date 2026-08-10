import type { TaskResult } from '@wrongstack/core/types';
import { setBoundedLruEntry } from './host-helpers.js';
import { captureCompletedTaskLearningForHost, type LearningSubject } from './host-learning.js';
import type { MultiAgentDeps } from './host-types.js';

export class HostLearningRoleTracker {
  private readonly roles = new Map<string, LearningSubject>();
  private readonly accessOrder: string[] = [];

  constructor(private readonly maxEntries = 256) {}

  record(subagentId: string, role: string, skills: readonly string[] = []): void {
    setBoundedLruEntry(
      this.roles,
      this.accessOrder,
      subagentId,
      { role, skills: [...skills] },
      this.maxEntries,
    );
  }

  capture(
    result: TaskResult,
    deps: Pick<MultiAgentDeps, 'container' | 'projectRoot'>,
    onCaptured?: (role: string) => void,
  ): void {
    captureCompletedTaskLearningForHost(result, deps, this.roles, onCaptured);
  }
}
