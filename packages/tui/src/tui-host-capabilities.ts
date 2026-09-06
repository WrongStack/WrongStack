import type { Agent } from '@wrongstack/core/agent';
import type { SlashCommandRegistry } from '@wrongstack/core/registry';
import type { MemoryPort, Provider, ReasoningRequest, TokenCounter } from '@wrongstack/core/types';
import type { VisionAdapters } from '@wrongstack/runtime/vision';
import type { Action, Settings } from './app-reducer.js';

interface PickableProviderCapability {
  id: string;
  family?: string | undefined;
  models: string[];
}

export interface PromptRefinementCapabilities {
  agent: Agent;
  memoryStore?: MemoryPort | undefined;
  getEnhancerReasoning?:
    | ((
        providerId?: string,
        modelId?: string,
      ) => ReasoningRequest | undefined | Promise<ReasoningRequest | undefined>)
    | undefined;
  buildEnhancerProvider?:
    | ((providerId: string, modelId: string) => Promise<Provider | undefined>)
    | undefined;
  getEnhanceFallbackRef?: (() => string | undefined) | undefined;
  getConfiguredRefinerRef?: (() => string | undefined) | undefined;
  getPickableProviders?: (() => Promise<PickableProviderCapability[]>) | undefined;
}

export interface RunBlocksCapabilities {
  agent: Agent;
  tokenCounter?: TokenCounter | undefined;
  supportsVision?: (() => boolean | Promise<boolean>) | undefined;
  // Optional to match consumption: the only use site feeds it to
  // routeImagesForModel's `adapters?: VisionAdapters | undefined`, which
  // resolves absent adapters to an empty list (runtime/vision resolveAdapters).
  visionAdapters?: VisionAdapters | undefined;
  onSDDOutput?: ((output: string) => Promise<string[]>) | undefined;
  onSuggestionsParsed?: ((finalText: string) => void) | undefined;
  /** Suppresses next-step extraction and prediction for a self-managed loop. */
  shouldSuppressNextSteps?: (() => boolean) | undefined;
  predictNext?:
    | ((input: { userRequest: string; assistantSummary: string }) => Promise<string[]>)
    | undefined;
  /** Observes a completed foreground run after its result has been rendered. */
  onRunFinished?: ((status: 'done' | 'aborted' | 'failed' | 'max_iterations') => void) | undefined;
}

type ClearAction = Extract<
  Action,
  | { type: 'clearHistory' }
  | { type: 'resetContextChip' }
  | { type: 'streamReset' }
  | { type: 'toolStreamClear' }
>;

export interface SubmitCapabilities extends PromptRefinementCapabilities {
  slashRegistry: SlashCommandRegistry;
  tokenCounter?: TokenCounter | undefined;
  getSettings?: (() => Settings) | undefined;
  saveSettings?: ((settings: Settings) => string | null | Promise<string | null>) | undefined;
  getYolo?: (() => boolean) | undefined;
  getAutonomy?: (() => 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') | undefined;
  getEternalEngine?: (() => unknown) | undefined;
  getParallelEngine?: (() => unknown) | undefined;
  getModeLabel?: (() => string) | undefined;
  getToolsItems?: (() => Array<{ enabled: boolean }>) | undefined;
  onExit(code: number): void;
  clearTerminal?: (() => void) | undefined;
  onClearHistory?: ((dispatch: (action: ClearAction) => void) => void) | undefined;
  getSuggestions?: (() => string[]) | undefined;
  getSDDContext?: (() => Promise<string | null>) | undefined;
  switchAutonomy?:
    | ((mode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') => string | null)
    | undefined;
}

export interface SettingsCapabilities {
  getSettings?: (() => Settings) | undefined;
  saveSettings?: ((settings: Settings) => string | null | Promise<string | null>) | undefined;
}
