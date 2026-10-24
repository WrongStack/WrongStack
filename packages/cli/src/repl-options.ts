import type { AttachmentStore, TokenCounter } from '@wrongstack/contracts/types';
import type { Agent } from '@wrongstack/core/agent';
import type { SlashCommandRegistry } from '@wrongstack/core/registry';
import type { VisionAdapters } from '@wrongstack/runtime';

import type { ReadlineInputReader } from './input-reader.js';
import type { TerminalRenderer } from './renderer.js';

export interface ReplOptions {
  agent: Agent;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  slashRegistry: SlashCommandRegistry;
  attachments: AttachmentStore;
  banner?: boolean | undefined;
  tokenCounter?: TokenCounter | undefined;
  visionAdapters?: VisionAdapters | undefined;
  getAutonomy?: (() => import('./services/autonomy-mode.js').AutonomyMode) | undefined;
  onAutonomy?: ((mode: import('./services/autonomy-mode.js').AutonomyMode) => void) | undefined;
  getNextPredict?: (() => boolean) | undefined;
  onSuggestionsParsed?: ((suggestions: string[] | null) => void) | undefined;
  getSuggestions?: (() => string[]) | undefined;
  getAutoSuggestions?: (() => string[]) | undefined;
  getYolo?: (() => boolean) | undefined;
  autonomyNextPrompt?: string | undefined;
  autoProceedDelayMs?: number | undefined;
  autoProceedMaxIterations?: number | undefined;
  onValidateAutoProceed?:
    | ((suggestion: string, lastOutput: string) => Promise<boolean>)
    | undefined;
  getEternalEngine?:
    | (() => import('@wrongstack/core/execution').EternalAutonomyEngine | null)
    | undefined;
  getParallelEngine?:
    | (() => import('@wrongstack/core/coordination').ParallelEternalEngine | null)
    | undefined;
  getSddRun?: (() => import('@wrongstack/sdd').SddRunControl | null) | undefined;
  effectiveMaxContext?: number | undefined;
  getEffectiveMaxContext?: (() => number | undefined) | undefined;
  projectName?: string | undefined;
  projectRoot?: string | undefined;
  appConfig?: import('@wrongstack/contracts/types').Config | undefined;
  getSessionId?: (() => string | undefined) | undefined;
  supportsVision?: (() => boolean | Promise<boolean>) | undefined;
  skillLoader?: import('@wrongstack/contracts/types').SkillLoader | undefined;
  agentsMonitorController?:
    | {
        visible: boolean;
        setVisible: (visible: boolean) => void;
      }
    | undefined;
  fleetStreamController?:
    | {
        mode: import('@wrongstack/contracts/types').FleetChatVerbosity;
        setMode: (mode: import('@wrongstack/contracts/types').FleetChatVerbosity) => void;
      }
    | undefined;
  interruptController?:
    | {
        abortLeader: () => boolean;
      }
    | undefined;
  onInterruptFleet?: (() => number) | undefined;
  onAgentIterationComplete?: ((estimatedTokens: number) => void) | undefined;
  onCountdownTick?: ((remainingSeconds: number) => boolean | void) | undefined;
  onDestroy?: (() => void) | undefined;
}
