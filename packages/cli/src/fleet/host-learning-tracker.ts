import type { TaskResult } from '@wrongstack/core/types';
import { setBoundedLruEntry } from './host-helpers.js';
import { captureCompletedTaskLearningForHost } from './host-learning.js';
import type { MultiAgentDeps } from './host-types.js';

export class HostLearningRoleTracker {
  private readonly roles = new Map<string, string>();
  private readonly accessOrder: string[] = [];

  constructor(private readonly maxEntries = 256) {}

  record(subagentId: string, role: string): void {
    setBoundedLruEntry(this.roles, this.accessOrder, subagentId, role, this.maxEntries);
  }

  capture(result: TaskResult, deps: Pick<MultiAgentDeps, 'container' | 'projectRoot'>): void {
    captureCompletedTaskLearningForHost(result, deps, this.roles);
  }
}
