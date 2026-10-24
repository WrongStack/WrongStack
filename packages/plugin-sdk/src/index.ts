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

export type { EventName, Listener } from '@wrongstack/contracts/kernel';
// ── The plugin contract ───────────────────────────────────────────────────
// ── Lifecycle hooks (Claude-compatible hook points) ───────────────────────
// ── Tools, events, config ─────────────────────────────────────────────────
export type {
  AnyHookOutcome,
  Config,
  ConfigStore,
  HookEvent,
  HookInput,
  HookInvocationContext,
  HookMatcher,
  HookOutcome,
  HookRegistrationOptions,
  InProcessHook,
  JSONSchema,
  Logger,
  Plugin,
  PluginAPI,
  PluginCapabilities,
  PluginConfig,
  PluginConfigFieldLifecycle,
  PluginConfigFieldMetadata,
  PluginDependency,
  PluginPipelines,
  PluginRuntime,
  PreToolUseOutcome,
  SystemPromptContributor,
  Tool,
  ToolCallContext,
} from '@wrongstack/contracts/types';
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
export { definePlugin, KERNEL_API_VERSION } from '@wrongstack/core/plugin';
