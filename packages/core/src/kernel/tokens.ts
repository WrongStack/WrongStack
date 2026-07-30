import type { BrainArbiter } from '../coordination/brain.js';
import type { FallbackProfileManager } from '../core/fallback-profile-manager.js';
import type { ProviderModelStatusTracker } from '../coordination/provider-status-tracker.js';
import type { HookRegistry } from '../hooks/registry.js';
import type { Compactor } from '../types/compactor.js';
import type { ConfigLoader, ConfigStore } from '../types/config.js';
import type { ErrorHandler } from '../types/error-handler.js';
import type { InputReader } from '../types/input-reader.js';
import type { Logger } from '../types/logger.js';
import type { MemoryPort } from '../types/memory.js';
import type { ModeStore } from '../types/mode.js';
import type { ModelsRegistry } from '../types/models-registry.js';
import type { PathResolver } from '../types/path-resolver.js';
import type { PermissionPolicy } from '../types/permission.js';
import type { PromptLoader } from '../types/prompt.js';
import type { ProviderRunner } from '../types/provider-runner.js';
import type { Renderer } from '../types/renderer.js';
import type { RetryPolicy } from '../types/retry-policy.js';
import type { SecretScrubber } from '../types/secret-scrubber.js';
import type { SessionStore } from '../types/session.js';
import type { SkillLoader } from '../types/skill.js';
import type { SystemPromptBuilder } from '../types/system-prompt.js';
import type { TokenCounter } from '../types/token-counter.js';
import type { WorktreeManager } from '../worktree/worktree-manager.js';
import type { Token } from './container.js';

// Tokens use the GLOBAL symbol registry (`Symbol.for`) rather than unique
// per-call `Symbol()`s. If `@wrongstack/core` is ever evaluated twice in one
// process — e.g. Node loads it under two path casings on a case-insensitive
// filesystem (`D:\Codebox\…` vs `D:\codebox\…`), or a bundler inlines a second
// copy — `Symbol()` would mint distinct tokens per instance, so a binding made
// via one copy's `TOKENS.ConfigStore` could never be resolved via the other's,
// surfacing as `Container: token "ConfigStore" not bound`. `Symbol.for(key)`
// returns the same symbol for the same key across every module instance in the
// process, making DI resilient to accidental duplication. The key is namespaced
// to avoid colliding with unrelated global symbols; `.description` (used in
// container error messages) stays human-readable.
const t = <T>(name: string): Token<T> => Symbol.for(`@wrongstack/core/kernel#${name}`) as Token<T>;

export const TOKENS = {
  Logger: t<Logger>('Logger'),
  TokenCounter: t<TokenCounter>('TokenCounter'),
  SessionStore: t<SessionStore>('SessionStore'),
  /**
   * @deprecated Token name retained for compatibility.
   * The resolved value IS a `MemoryPort`, NOT the legacy `MemoryStore` interface.
   * Callers that cast or destructure as `MemoryStore` will lose `getCapability`,
   * `health`, `dispose`, and the narrowed `withTraceId(): MemoryPort` return type.
   * Port implementations are opaque — query optional features via `getCapability`.
   * Use `TOKENS.MemoryPort` instead.
   */
  MemoryStore: t<MemoryPort>('MemoryStore'),
  /** Production memory backend. Use instead of the deprecated `MemoryStore` token. */
  MemoryPort: t<MemoryPort>('MemoryPort'),
  PermissionPolicy: t<PermissionPolicy>('PermissionPolicy'),
  Compactor: t<Compactor>('Compactor'),
  PathResolver: t<PathResolver>('PathResolver'),
  ConfigLoader: t<ConfigLoader>('ConfigLoader'),
  ConfigStore: t<ConfigStore>('ConfigStore'),
  FallbackProfileManager: t<FallbackProfileManager>('FallbackProfileManager'),
  /** Shared (provider, model) health tracker; fallback extensions read/write it. */
  ProviderModelStatusTracker: t<ProviderModelStatusTracker>('ProviderModelStatusTracker'),
  Renderer: t<Renderer>('Renderer'),
  InputReader: t<InputReader>('InputReader'),
  ErrorHandler: t<ErrorHandler>('ErrorHandler'),
  RetryPolicy: t<RetryPolicy>('RetryPolicy'),
  SkillLoader: t<SkillLoader>('SkillLoader'),
  PromptLoader: t<PromptLoader>('PromptLoader'),
  SystemPromptBuilder: t<SystemPromptBuilder>('SystemPromptBuilder'),
  SecretScrubber: t<SecretScrubber>('SecretScrubber'),
  ModelsRegistry: t<ModelsRegistry>('ModelsRegistry'),
  ModeStore: t<ModeStore>('ModeStore'),
  /** Replaces the entire provider call layer — retry, streaming, tracing. */
  ProviderRunner: t<ProviderRunner>('ProviderRunner'),
  /** Optional git-worktree lifecycle manager (per-phase isolation in Goal). */
  WorktreeManager: t<WorktreeManager>('WorktreeManager'),
  /** Optional global Brain arbiter for policy/decision escalation. */
  BrainArbiter: t<BrainArbiter>('BrainArbiter'),
  /** Lifecycle hook registry (shell + in-process hooks). */
  HookRegistry: t<HookRegistry>('HookRegistry'),
} as const;
