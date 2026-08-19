/**
 * @wrongstack/plugin-sdk — the authoring surface for WrongStack plugins.
 *
 * Third-party plugins should depend on THIS package (not on
 * `@wrongstack/core` or `@wrongstack/plugins`) to compile against the
 * plugin contract. It re-exports:
 *
 *   - `definePlugin` — ergonomic authoring helper that infers option types
 *     and injects the current `apiVersion`,
 *   - `KERNEL_API_VERSION` — the host contract version to pin against,
 *   - every type a plugin's manifest, hooks, tools, and config schema need.
 *
 * Runtime helpers (bounded collections, safe process spawning, sandboxed
 * paths, optional-LLM plumbing) live in `@wrongstack/plugin-sdk/runtime`.
 *
 * Versioning: the SDK follows the host's plugin contract
 * (`KERNEL_API_VERSION`). Declare `apiVersion: '^0.1'` (or use
 * `definePlugin`, which does it for you) so your plugin keeps loading
 * across additive host releases.
 */

export { definePlugin, KERNEL_API_VERSION } from '@wrongstack/core/plugin';

// ── The plugin contract ───────────────────────────────────────────────────
export type {
  JSONSchema,
  Plugin,
  PluginAPI,
  PluginCapabilities,
  PluginConfigFieldMetadata,
  PluginConfigFieldLifecycle,
  PluginDependency,
  PluginPipelines,
  PluginRuntime,
} from '@wrongstack/core/types';

// ── Lifecycle hooks (Claude-compatible hook points) ───────────────────────
export type {
  AnyHookOutcome,
  HookEvent,
  HookInput,
  HookInvocationContext,
  HookMatcher,
  HookOutcome,
  HookRegistrationOptions,
  InProcessHook,
  PreToolUseOutcome,
} from '@wrongstack/core/types';

// ── Agent extension points (iteration/provider/tool lifecycle) ────────────
export type {
  AfterIterationHook,
  AfterRunHook,
  AfterToolExecutionHook,
  AgentExtension,
  BeforeIterationHook,
  BeforeRunHook,
  BeforeToolExecutionHook,
  OnErrorHook,
  ProviderRunnerFn,
  ProviderRunnerWrapper,
} from '@wrongstack/core/extension';
export type { SystemPromptContributor } from '@wrongstack/core/types';

// ── Tools, events, config ─────────────────────────────────────────────────
export type { Tool, ToolCallContext } from '@wrongstack/core/types';
export type { EventName, Listener } from '@wrongstack/core/kernel';
export type { Config, ConfigStore, PluginConfig } from '@wrongstack/core/types';
export type { Logger } from '@wrongstack/core/types';
