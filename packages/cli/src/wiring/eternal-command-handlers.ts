/** Eternal/autonomy slash-command adapters. */
import type { Agent } from '@wrongstack/core/agent';
import type { AutonomyStage, Compactor, Config } from '@wrongstack/core/types';
import type { BrainArbiter } from '@wrongstack/core/coordination';
import { EternalAutonomyEngine, ParallelEternalEngine } from '@wrongstack/core/execution';
import type { EventBus } from '@wrongstack/core/kernel';
import type { JournalEntry } from '@wrongstack/core/goal';
import type { MultiAgentHost } from '../multi-agent.js';
import type { AutonomyMode } from '../services/autonomy-mode.js';
import type { BuiltinSlashCommandDeps } from './slash-commands.js';

type SlashCommandDeps = BuiltinSlashCommandDeps;

export function createEternalCommandHandlers(input: {
  agent: Agent;
  projectRoot: string;
  compactor: Compactor;
  effectiveMaxContext: { current: number };
  onIteration: (entry: JournalEntry) => void;
  onStage: (stage: AutonomyStage) => void;
  multiAgentHost: MultiAgentHost;
  getConfig: () => Config;
  events: EventBus;
  logger: ConstructorParameters<typeof EternalAutonomyEngine>[0]['logger'];
  brain: BrainArbiter | undefined;
  getAutonomyMode: () => AutonomyMode;
  setAutonomyMode: (mode: AutonomyMode) => void;
  autonomyModeRef: { current: AutonomyMode };
  getEternalEngine: () => EternalAutonomyEngine | null;
  setEternalEngine: (engine: EternalAutonomyEngine) => void;
  getParallelEngine: () => ParallelEternalEngine | null;
  setParallelEngine: (engine: ParallelEternalEngine) => void;
}): Pick<SlashCommandDeps, 'onAutonomy' | 'onEternalStart' | 'onEternalStop'> {
  return {
    onAutonomy: (mode) => {
      if (mode !== undefined) {
        input.setAutonomyMode(mode);
        input.autonomyModeRef.current = mode;
        return mode;
      }
      return input.getAutonomyMode();
    },
    onEternalStart: (mode) => {
      const effectiveMode = mode ?? 'eternal';
      if (effectiveMode === 'eternal-parallel') {
        let engine = input.getParallelEngine();
        if (!engine) {
          engine = new ParallelEternalEngine({
            agent: input.agent,
            projectRoot: input.projectRoot,
            compactor: input.compactor,
            maxContextTokens:
              input.effectiveMaxContext.current > 0
                ? input.effectiveMaxContext.current
                : undefined,
            onIteration: input.onIteration,
            onStage: input.onStage,
            subagentFactory: input.multiAgentHost.makeSubagentFactory(input.getConfig()),
            events: input.events,
            logger: input.logger,
          });
          input.setParallelEngine(engine);
        }
        void engine.prime?.();
        return;
      }
      let engine = input.getEternalEngine();
      if (!engine) {
        engine = new EternalAutonomyEngine({
          agent: input.agent,
          projectRoot: input.projectRoot,
          compactor: input.compactor,
          maxContextTokens:
            input.effectiveMaxContext.current > 0 ? input.effectiveMaxContext.current : undefined,
          onIteration: input.onIteration,
          onStage: input.onStage,
          brain: input.brain,
          events: input.events,
          logger: input.logger,
        });
        input.setEternalEngine(engine);
      }
      void engine.prime();
    },
    onEternalStop: () => {
      input.getEternalEngine()?.stop();
      input.getParallelEngine()?.stop();
    },
  };
}
