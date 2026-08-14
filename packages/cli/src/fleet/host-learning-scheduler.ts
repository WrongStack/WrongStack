/**
 * Learning optimization scheduler and dispatch classifier for MultiAgentHost.
 *
 * @module fleet/host-learning-scheduler
 */

import {
  LearningOptimizationScheduler,
  type LearningOptimizerLlm,
  listProjectAgentRoles,
  resolveAutoOptimizePolicy,
} from '@wrongstack/core/agent-catalog';
import { resolveSubagentModelTarget } from '@wrongstack/core/coordination';
import type { Config } from '@wrongstack/core/types';
import { makeProviderClassifier } from '../services/dispatch-classifier.js';
import { buildHostSubagentProvider } from './host-provider.js';
import type { MultiAgentDeps } from './host-types.js';

export class HostLearningScheduler {
  private learningOptimizer: LearningOptimizationScheduler | null = null;
  private learningSwept = false;

  constructor(private readonly deps: MultiAgentDeps) {}

  getOptimizer(): LearningOptimizationScheduler | null {
    const settings = this.deps.configStore.get().fleet?.learning?.autoOptimize;
    if (settings?.enabled === false) return null;
    if (!this.learningOptimizer) {
      this.learningOptimizer = new LearningOptimizationScheduler({
        projectRoot: this.deps.projectRoot,
        getPolicy: () =>
          resolveAutoOptimizePolicy(this.deps.configStore.get().fleet?.learning?.autoOptimize),
        getLlm: () => this.resolveOptimizerLlm(),
        onEvent: (event) => {
          this.deps.events.emit('agent.learning.optimized', {
            sessionId: this.deps.session.id,
            role: event.role,
            trigger: event.trigger,
            status: event.result?.status ?? 'failed',
            skills: event.result?.skills ?? [],
            ...(event.error ? { error: event.error } : {}),
          });
        },
      });
    }
    return this.learningOptimizer;
  }

  notifyCaptured(role: string): void {
    this.getOptimizer()?.notifyCaptured(role);
  }

  sweep(): void {
    if (this.learningSwept) return;
    this.learningSwept = true;
    if (this.deps.configStore.get().fleet?.learning?.autoOptimize?.sweepOnStart === false) return;
    try {
      this.getOptimizer()?.sweep(listProjectAgentRoles(this.deps.projectRoot));
    } catch {
      // A sweep is an optimization, never a startup dependency.
    }
  }

  async classifyDispatch(
    task: string,
    candidates: { role: string; name: string; summary: string }[],
  ): Promise<{ role: string; reason?: string | undefined } | null> {
    try {
      const config = this.deps.configStore.get() as Config;
      const target = resolveSubagentModelTarget(config, 'dispatcher');
      const providerId = target?.provider ?? config.provider;
      const model = target?.model ?? config.model;
      if (!providerId || !model) return null;
      const provider = await buildHostSubagentProvider(this.deps, config, providerId, model);
      return await makeProviderClassifier(provider as never, model)(task, candidates);
    } catch {
      return null;
    }
  }

  async resolveOptimizerLlm(): Promise<LearningOptimizerLlm | undefined> {
    try {
      const config = this.deps.configStore.get() as Config;
      const target = resolveSubagentModelTarget(config, 'memory-curator');
      const providerId = target?.provider ?? config.provider;
      const model = target?.model ?? config.model;
      if (!providerId || !model) return undefined;
      const provider = await buildHostSubagentProvider(this.deps, config, providerId, model);
      return { provider, model };
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    this.learningOptimizer?.dispose();
    this.learningOptimizer = null;
  }
}
