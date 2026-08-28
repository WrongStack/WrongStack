/** Runtime lifecycle callbacks shared by CLI execution surfaces. */

import type { Context } from '@wrongstack/core/agent';
import type { EternalAutonomyEngine, ParallelEternalEngine } from '@wrongstack/core/execution';
import type { JournalEntry } from '@wrongstack/core/goal';
import type { EventBus } from '@wrongstack/core/kernel';
import type { AutonomyStage, Config } from '@wrongstack/core/types';
import type { SddRunRegistry } from '@wrongstack/sdd';
import type { LifecycleDeps } from '../execute-deps.js';
import { getSuggestions, setSuggestions } from '../services/suggestion-store.js';
import type { SessionStats } from '../session-stats.js';

interface RuntimeLifecycleDepsInput {
  getConfig: () => Config;
  context: Context;
  getCurrentSuggestions: () => string[];
  setCurrentSuggestions: (suggestions: string[]) => void;
  getEternalEngine: () => EternalAutonomyEngine | null;
  getParallelEngine: () => ParallelEternalEngine | null;
  sddRunRegistry: SddRunRegistry;
  projectRoot: string;
  paths: {
    projectSpecs: string;
    projectTaskGraphs: string;
    projectSddSession: string;
    projectSddBoards: string;
  };
  eternalListeners: Set<(entry: JournalEntry) => void>;
  stageListeners: Set<(stage: AutonomyStage) => void>;
  runSageSessionHygiene: () => Promise<void>;
  pluginHost?: { dispose(): Promise<void> } | undefined;
  teardownHandlers: Array<() => void>;
  stats: SessionStats;
  events: EventBus;
  logger: { warn(message: string, fields?: Record<string, unknown>): void };
}

export function createRuntimeLifecycleDeps(input: RuntimeLifecycleDepsInput): LifecycleDeps {
  const autonomy = input.getConfig().autonomy as Record<string, unknown> | undefined;
  return {
    onSuggestionsParsed: (suggestions) => {
      const next = suggestions ?? [];
      input.setCurrentSuggestions(next);
      setSuggestions(next);
    },
    getSuggestions: () => {
      const shared = getSuggestions();
      return shared.length > 0 ? shared : input.getCurrentSuggestions();
    },
    autoProceedDelayMs: (autonomy?.autoProceedDelayMs as number) ?? 45_000,
    autoProceedMaxIterations: (autonomy?.autoProceedMaxIterations as number) ?? 50,
    onValidateAutoProceed: (suggestion, lastOutput) =>
      validateAutoProceed(input.context, suggestion, lastOutput),
    getEternalEngine: input.getEternalEngine,
    getParallelEngine: input.getParallelEngine,
    getSddRun: () => input.sddRunRegistry.getActive(),
    onSddLifecycle: async (op, options) => {
      const active = input.sddRunRegistry.getActive();
      if (op === 'destroy') active?.stop();
      else if (active?.isRunning()) {
        return { op, ok: false, reason: 'Stop the run first (Ctrl+C), then retry.' };
      }
      const { applySddLifecycle } = await import('@wrongstack/sdd');
      return applySddLifecycle(op, {
        projectRoot: input.projectRoot,
        stateTransport: 'kanban',
        revertMerged: options?.revertMerged === true,
        paths: input.paths,
      });
    },
    subscribeEternalIteration: (listener) => {
      input.eternalListeners.add(listener);
      return () => input.eternalListeners.delete(listener);
    },
    subscribeEternalStage: (listener) => {
      input.stageListeners.add(listener);
      return () => input.stageListeners.delete(listener);
    },
    onDestroy: () => {
      void input.runSageSessionHygiene().catch((error) => {
        input.logger.warn('sage session hygiene failed', { error: String(error) });
      });
      void input.pluginHost?.dispose().catch((error) => {
        input.logger.warn('plugin host disposal failed', { error: String(error) });
      });
      input.teardownHandlers.forEach((handler) => {
        handler();
      });
      input.stats.destroy(input.events);
    },
  };
}

async function validateAutoProceed(
  context: Context,
  suggestion: string,
  lastOutput: string,
): Promise<boolean> {
  try {
    const response = await context.provider.complete(
      {
        model: context.model,
        system: [
          {
            type: 'text',
            text: 'You are a safety validator for an autonomous coding agent. Your ONLY job is to decide whether the agent should auto-proceed with a suggested next step, or whether a human should review first. Reply with exactly one word: YES or NO.',
          },
        ],
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `The autonomous agent just completed a turn and generated this top-ranked next-step suggestion:\n\n"${suggestion}"\n\n${lastOutput ? `Recent agent output:\n${lastOutput.slice(0, 500)}\n\n` : ''}Should the agent auto-proceed with this suggestion, or should a human review first?\n\nReply YES to auto-proceed, NO to wait for human input.`,
              },
            ],
          },
        ],
        maxTokens: 5,
        temperature: 0,
      },
      { signal: AbortSignal.timeout(10_000) },
    );
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => ('text' in block ? block.text : ''))
      .join('')
      .trim()
      .toUpperCase();
    return text.startsWith('YES');
  } catch {
    return false;
  }
}
