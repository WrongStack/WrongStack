# Zero Review Report — WrongStack

## Executive Summary

WrongStack is a TypeScript/Node.js monorepo for an autonomous terminal AI coding agent. Its architecture is already unusually mature for this category of project: the codebase has a clear kernel, dependency-injection boundaries, provider abstraction, tool execution model, permission policy, plugin surfaces, optional UI layers, and documentation for many architectural decisions.

The strongest design characteristic is the separation between the core agent kernel and the surrounding product layers. `packages/core` owns the foundational abstractions: dependency injection, middleware pipelines, typed events, run control, context state, session flow, tool execution, compaction, prompt loading, and core agent lifecycle. The surrounding packages then build upward: providers implement model adapters, tools expose local capabilities, runtime wires defaults together, CLI/TUI/WebUI/Desktop provide product surfaces, and plugins/MCP/ACP extend integration points.

The main recommendation is not to perform a broad rewrite. WrongStack already has the right architectural direction. The best next step is to harden what exists: make architectural boundaries enforceable, add focused regression tests for high-risk flows, stabilize observability and session replay, and reduce long-file complexity in the CLI/TUI/WebUI seams.

This report consolidates the prior end-to-end codebase review and the follow-up recommendations into a more detailed English document.

---

## Repository and Product Overview

### Product Shape

WrongStack is a terminal-first AI coding agent platform. It can read code, reason through problems, edit files, run tools and commands, interact with providers, and operate under a permission model intended to balance autonomy with safety.

The project currently supports or anticipates several user-facing surfaces:

- Terminal CLI / REPL as the primary interface.
- Optional TUI based on React/Ink.
- Optional WebUI based on Vite/React.
- Desktop/Electron integration.
- ACP integration for editors such as Zed, JetBrains, and VSCode-compatible environments.
- MCP support for external tool/server integrations.
- Plugin and skill systems for customization.
- Benchmarking infrastructure for model-independent evaluation.

### Monorepo Structure

The repository is organized as a pnpm workspace with multiple packages and apps. The relevant conceptual layering is:

```text
apps/wrongstack/      CLI binary entry point
apps/desktop/         Electron/desktop shell

packages/core/        Agent kernel and framework primitives
packages/runtime/     Default runtime wiring and container setup
packages/cli/         REPL, slash commands, config, user-facing CLI behavior
packages/tools/       Built-in local tools
packages/providers/   Model/provider adapters
packages/mcp/         MCP client, registry, and transports
packages/plug-lsp/    LSP bridge and related slash commands
packages/acp/         Agent Client Protocol integration
packages/tui/         Terminal UI
packages/webui/       Web UI server/client package
packages/plugins/     Built-in plugin host and plugins
packages/telegram/    Telegram bridge
packages/bench/       Benchmark harness
packages/skills/      Stub package; bundled skills live under core skills
```

The project documentation also defines an important dependency rule:

```text
core -> no WrongStack-internal dependencies
providers/tools/mcp/plug-lsp/acp/runtime/telegram/plugins/skills/bench -> core
cli/tui -> higher-level composition over lower layers
```

This rule should be treated as one of the central architectural invariants of the project.

---

## Key Architectural Findings

## 1. The Core Kernel Is the Right Center of Gravity

`packages/core` contains the most important long-term asset in the project: a relatively small but powerful kernel.

The kernel is built around six major primitives:

1. `Container` — typed dependency injection.
2. `Pipeline<T>` — middleware chains for agent lifecycle stages.
3. `EventBus` — typed pub/sub for observability and integration.
4. `RunController` — abort handling and scoped lifecycle cleanup.
5. `Context` / `ConversationState` — live run state and observable message state.
6. Agent lifecycle orchestration — request construction, provider execution, tool calls, and compaction.

This is a strong design because it gives the rest of the codebase a shared runtime substrate while keeping provider, tool, UI, and plugin concerns outside the kernel.

### Why this matters

For an AI coding agent, the hardest problems are usually not individual tools or UI components. The hardest problems are:

- Maintaining coherent run state across long conversations.
- Handling tool execution safely and consistently.
- Preserving observability for debugging.
- Supporting provider-specific behavior without coupling the whole system to one API.
- Keeping plugin and extension behavior powerful but bounded.
- Recovering from provider/tool/session failures.

WrongStack’s kernel is already shaped around those problems.

### Recommendation

Do not split or rewrite the kernel prematurely. Instead, protect it with automated architecture tests, more regression coverage, and clearer public/internal API boundaries.

---

## 2. Dependency Injection Is a Major Strength

The `Container` and `TOKENS` model gives WrongStack a flexible runtime composition system. It enables plugins and runtime setup code to replace or decorate services before the agent runs.

Important tokens include services such as:

- Logger
- TokenCounter
- SessionStore
- MemoryStore
- PermissionPolicy
- Compactor
- PathResolver
- ConfigLoader
- ConfigStore
- Renderer
- InputReader
- ErrorHandler
- RetryPolicy
- SkillLoader
- PromptLoader
- SystemPromptBuilder
- SecretScrubber
- ModelsRegistry
- ModeStore
- ProviderRunner
- WorktreeManager
- BrainArbiter
- HookRegistry

This gives the project a real extensibility model without relying on global state or ad-hoc imports.

### Risks

The main risk is not the DI system itself. The risk is silent architectural drift:

- Higher-level packages may start importing concrete implementations from places they should not know about.
- Runtime wiring may accumulate too much behavior.
- Plugins may gain access to unstable internals.
- Token contracts may change without tests catching downstream breakage.

### Recommendations

1. Add automated import-boundary checks.
2. Add tests for critical token registration and decoration behavior.
3. Document which tokens are stable extension points and which are internal.
4. Consider a small `core/testing` helper package or module for constructing test containers safely.

---

## 3. Pipelines and Events Provide a Good Extension Model

WrongStack uses middleware pipelines for lifecycle stages and a typed event bus for observability.

The six main pipelines are:

| Pipeline | Purpose |
|---|---|
| `userInput` | Runs on every user turn before agent processing. |
| `request` | Runs before each provider request. |
| `response` | Runs after provider response. |
| `assistantOutput` | Runs for assistant text blocks. |
| `toolCall` | Runs after tool execution. |
| `contextWindow` | Runs when context may need size management. |

The event system covers session, agent, iteration, provider, tool, context, compaction, MCP, subagent, worktree, audit, fleet, brain, and error categories.

This design is valuable because it separates two concerns:

- Pipelines can steer or transform behavior.
- Events can observe and report behavior.

That distinction is important. Observability should not secretly mutate execution, and steering hooks should be explicit.

### Recommendations

1. Keep the pipeline/event distinction strict.
2. Add tests that verify event emission order for key agent flows.
3. Generate documentation from the `EventMap` type or validate docs against the type.
4. Add a small event trace fixture for a successful run, a tool failure, a permission denial, and a compaction event.

---

## 4. Tool Execution Is Central and Should Be Heavily Tested

The built-in tool contract is strong:

```ts
interface Tool<I, O> {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  permission: 'auto' | 'confirm' | 'deny';
  mutating: boolean;
  execute(input, ctx, opts): Promise<O>;
  executeStream?(input, ctx, opts): AsyncIterable<ToolStreamEvent<O>>;
  cleanup?(input, ctx): Promise<void>;
}
```

The `executeStream` design is especially useful because it allows long-running tools to report progress, partial output, metrics, changed files, and warnings before returning a final result.

### High-risk areas

Tool execution is where autonomy meets the user’s machine. Bugs here can become serious quickly. Important risk areas include:

- Incorrect permission classification.
- Mutating tools running without confirmation.
- Cleanup not running after abort/failure.
- Parallel execution creating race conditions.
- Tool output being appended incorrectly to conversation state.
- Sensitive data leaking into logs or provider messages.
- Hooks rewriting inputs in unsafe ways.

### Recommendations

Add a focused regression test suite for `ToolExecutor` covering:

1. Auto-approved read-only tools.
2. Confirm-required mutating tools.
3. Denied tools.
4. Hook-blocked tool calls.
5. Hook-rewritten tool input.
6. Streaming tool progress events.
7. Cleanup after abort.
8. Parallel vs sequential execution behavior.
9. Tool failure propagation.
10. Secret scrubbing in tool output and logs.

This should be one of the highest-priority test investments.

---

## 5. Permission Policy Is a Product Differentiator

WrongStack’s permission model is not just an implementation detail. It is part of the product promise: the agent should be autonomous enough to be useful, but bounded enough to avoid unsafe side effects.

The existing policy conceptually distinguishes:

- Trusted project-local actions.
- Mutating operations.
- Destructive operations.
- Network operations.
- External side effects.
- Credential and secret handling.
- Commands that escape the workspace or affect host/global state.

This is the right framing.

### Recommendations

1. Treat permission behavior as a formal compatibility surface.
2. Create a matrix of command/tool examples and expected permission outcomes.
3. Add regression tests for this matrix.
4. Log permission decisions with enough structured metadata for debugging.
5. Ensure UI surfaces explain permission prompts in plain language.
6. Make it easy to run in stricter modes for team/enterprise settings.

A particularly useful artifact would be `docs/permission-policy.md` containing examples like:

| Action | Expected behavior |
|---|---|
| Read a project file | Auto-allow |
| Create a new project file | Auto-allow or policy-dependent allow |
| Delete a file | Confirm |
| Run tests | Auto-allow |
| Install a dependency | Confirm |
| Push to git remote | Confirm unless explicitly requested |
| Force push | Confirm or deny depending on policy |
| Write credentials to `.env` | Confirm |
| Run downloaded script | Confirm/deny |

---

## 6. Provider Abstraction Appears Healthy

WrongStack supports multiple provider families, including Anthropic, OpenAI, Google, and OpenAI-compatible adapters.

The provider abstraction is important because model APIs differ in:

- Message format.
- Tool call format.
- Streaming event shape.
- Retry semantics.
- Thinking/reasoning blocks.
- Token counting.
- Error models.
- Rate-limit behavior.
- Compatibility quirks.

The architecture correctly places provider-specific logic outside `core` while preserving a common runner interface.

### Recommendations

1. Add provider contract tests with fake provider fixtures.
2. Add snapshot-style tests for request/response normalization.
3. Test streaming behavior separately from non-streaming behavior.
4. Maintain provider capability metadata, such as:
   - supports tools
   - supports streaming
   - supports reasoning/thinking
   - supports JSON mode
   - max context
   - known quirks
5. Avoid provider-specific assumptions leaking into core agent logic.

---

## 7. CLI Is Strategically Important but Likely to Accumulate Complexity

The CLI is the primary product surface. It owns user-facing behavior such as:

- Session startup.
- REPL handling.
- Slash commands.
- Config loading.
- Runtime selection.
- Prompt rendering.
- Tool and permission UX.
- Possibly model/provider selection.

This layer is naturally at risk of becoming a “god layer” because it connects many systems.

### Recommendations

1. Keep CLI command parsing separate from command execution.
2. Keep rendering separate from business logic.
3. Move reusable command implementations into small modules.
4. Add integration tests for important slash commands.
5. Add golden output tests for help text and command summaries where practical.
6. Avoid direct imports from deeply internal modules when a package-level API would work.

The CLI should compose the system, not become the system.

---

## 8. TUI, WebUI, and Desktop Should Share Backend Contracts

WrongStack has multiple UI surfaces. This is valuable, but it creates risk if each UI invents its own backend protocol or reimplements agent state handling.

The right direction is to have UI surfaces consume stable contracts:

- Session state events.
- Tool progress events.
- Provider streaming events.
- Permission prompt requests.
- User input submission.
- Slash command invocation.
- Run cancellation.
- Checkpoint/session history access.

### Recommendations

1. Define a shared UI-facing event/state contract.
2. Keep WebUI/Desktop/TUI as renderers and interaction shells, not separate agent implementations.
3. Add tests that simulate backend events and verify UI state reducers.
4. Ensure permission prompts are consistent across CLI, TUI, WebUI, and Desktop.
5. Avoid duplicating command semantics across UI packages.

---

## 9. MCP and Plugin Systems Are Powerful but Need Guardrails

MCP and plugins are high-leverage extension mechanisms. They allow WrongStack to integrate with external tools, servers, automations, and custom workflows.

They also increase risk:

- External tools may be unreliable or malicious.
- Plugin hooks can alter agent behavior in surprising ways.
- MCP tools may expose network or filesystem side effects.
- Version compatibility can become difficult.
- Debugging becomes harder when behavior is distributed across extensions.

### Recommendations

1. Introduce clear plugin capability declarations.
2. Require plugins/MCP tools to participate in the same permission model as built-in tools.
3. Emit structured events for plugin hook execution.
4. Document plugin lifecycle and failure behavior.
5. Add tests for plugin isolation and error containment.
6. Provide a “safe mode” that disables third-party plugins and MCP servers for debugging.

---

## 10. Session Logging and Replay Could Become a Major Advantage

The architecture already includes session events, checkpointing concepts, in-flight auditing, and rich event categories. This can become a powerful debugging and trust feature.

A good session replay system would help answer:

- What did the user ask?
- What context was sent to the model?
- Which model/provider responded?
- Which tools were called?
- What permissions were requested and why?
- What changed on disk?
- What failed?
- How did the agent recover?

### Recommendations

1. Standardize the session event log schema.
2. Add a replay or inspection command for session logs.
3. Scrub secrets before persistence.
4. Make tool file changes explicit in the log.
5. Add tests for damaged session recovery.
6. Consider a human-readable run summary generated from events.

This would improve developer trust and make bug reports much easier to diagnose.

---

## 11. Documentation Is Strong but Should Be Made Executable Where Possible

WrongStack has substantial documentation: architecture docs, provider author guide, plugin guide, hooks docs, release process, security notes, help docs, and many issue/design documents.

The risk with rich documentation is drift. The more detailed the docs become, the more likely they are to fall out of sync unless some parts are generated or validated.

### Recommendations

1. Generate event documentation from `EventMap` or validate it in tests.
2. Add architecture-boundary tests matching `docs/architecture-rules.md`.
3. Keep package maps in one canonical place and reference them elsewhere.
4. Add “how to add a provider/tool/plugin” checklists.
5. Add minimal examples that are tested in CI where practical.

---

## Prioritized Recommendations

## Priority 1 — Enforce Architectural Boundaries Automatically

### Problem

WrongStack’s architecture depends on package layering. This is documented, but documentation alone will not prevent drift.

### Recommendation

Add automated import boundary checks so CI fails when package dependencies violate the intended direction.

Examples of desired constraints:

- `packages/core` must not import other WrongStack packages.
- Provider/tool/MCP/plugin packages may import `core`, but `core` may not import them.
- UI layers should not import deep internals from unrelated packages.
- Runtime may wire implementations but should avoid becoming a dumping ground for product behavior.

### Possible implementation options

- Use dependency-cruiser.
- Use ESLint import rules.
- Write a small custom script that parses TypeScript imports and validates workspace package relationships.

### Why it matters

This is high leverage because it prevents slow architectural erosion. The current design is good; the main goal should be to keep it good.

---

## Priority 2 — Build Regression Tests Around Agent Lifecycle

### Problem

The agent lifecycle is the core behavior of the product. Bugs here are often subtle and may not be caught by isolated unit tests.

### Recommendation

Create focused tests for complete agent-loop scenarios using fake providers and fake tools.

Important flows:

1. User input is normalized and appended to conversation state.
2. Request pipeline runs before provider call.
3. Provider returns plain text and the run completes.
4. Provider returns tool use and tool execution happens.
5. Tool results are appended to state correctly.
6. Provider is called again after tool result.
7. Tool failure is represented correctly.
8. Permission denial is represented correctly.
9. Context compaction is triggered when needed.
10. Abort/cancellation cleans up in-flight work.

### Why it matters

These tests protect the product’s most important path: user request → model reasoning → tool execution → final answer.

---

## Priority 3 — Harden Tool Permission and Shell Command Safety

### Problem

The agent can run tools and shell commands. This is powerful but dangerous if classification is inconsistent.

### Recommendation

Create a permission decision test matrix for shell commands and built-in tools. Use table-driven tests.

Examples:

- `git status` should be allowed.
- `npm test` should be allowed.
- Reading a file should be allowed.
- Creating a new file in the workspace may be allowed depending on policy.
- Deleting files should require confirmation.
- Installing packages should require confirmation.
- `git reset --hard` should require confirmation.
- External network calls should be gated unless pre-approved.
- Writing secrets should require confirmation.

### Why it matters

WrongStack’s trust model depends on predictable permission behavior. Users will tolerate prompts if they are clear and consistent; they will not tolerate surprising side effects.

---

## Priority 4 — Improve Event Traceability and Debugging

### Problem

The system emits many typed events, but the practical debugging experience depends on whether these events can be inspected coherently.

### Recommendation

Create an event trace/debug mode that can show a structured timeline of a run.

Example timeline:

```text
session.started
agent.run.started
iteration.started
provider.response
provider.tool_use_start
tool.started
tool.progress
tool.executed
iteration.completed
agent.run.completed
session.ended
```

### Why it matters

This would make WrongStack much easier to debug, support, and trust. It also helps plugin authors understand behavior.

---

## Priority 5 — Stabilize Public Extension APIs

### Problem

WrongStack has plugins, skills, hooks, MCP integrations, and provider/tool authoring surfaces. Without clear stability boundaries, extension authors may depend on internals.

### Recommendation

Define explicit public APIs for:

- Tool authors.
- Provider authors.
- Plugin authors.
- Skill authors.
- MCP integration behavior.
- UI event consumers.

Each public API should have:

- Minimal exported types.
- A short guide.
- A compatibility promise.
- Tests or example fixtures.

### Why it matters

The easier it is to extend WrongStack safely, the more useful the platform becomes.

---

## Priority 6 — Reduce Long-File and High-Coupling Hotspots

### Problem

Some packages are naturally likely to accumulate complexity, especially CLI, TUI, WebUI, and runtime wiring.

### Recommendation

Identify files with high line count, high import count, or many responsibilities. Refactor only when there is a clear seam.

Good refactor targets are modules that mix:

- Parsing and execution.
- Rendering and business logic.
- Provider-specific and provider-agnostic behavior.
- State mutation and display formatting.
- IO and pure transformation.

### Why it matters

This keeps development velocity high without destabilizing the core.

---

## Priority 7 — Strengthen Provider Compatibility Testing

### Problem

Multiple provider APIs will continue to diverge. Without contract tests, provider behavior can regress quietly.

### Recommendation

Build fake response fixtures for each provider family and test normalization into the common internal representation.

Cover:

- Text-only response.
- Tool-call response.
- Streaming text.
- Streaming tool call.
- Error response.
- Rate limit/retry behavior.
- Reasoning/thinking blocks where supported.

### Why it matters

Provider abstraction is valuable only if behavior is consistent enough for the rest of the agent to rely on it.

---

## Priority 8 — Make Session Recovery a First-Class Tested Feature

### Problem

AI coding agents often run for long sessions and may be interrupted. Session corruption or incomplete writes can undermine user trust.

### Recommendation

Add tests for:

- Interrupted session writes.
- Damaged session detection.
- Rewind behavior.
- In-flight operation markers.
- Checkpoint creation.
- Restoring conversation state.

### Why it matters

Reliable session recovery makes the agent feel dependable in real-world usage.

---

## Suggested Roadmap

## Phase 1 — Guardrails and Tests

1. Add architecture boundary checks.
2. Add ToolExecutor regression tests.
3. Add permission policy matrix tests.
4. Add basic agent lifecycle integration tests with fake providers/tools.
5. Add event emission order tests for the most important flows.

## Phase 2 — Observability and Debuggability

1. Create structured event trace output.
2. Improve session log inspection.
3. Add run summaries based on event logs.
4. Improve permission prompt metadata and display.
5. Add safe mode for disabling plugins/MCP during debugging.

## Phase 3 — API Stabilization

1. Mark public extension APIs.
2. Document stable provider/tool/plugin contracts.
3. Add compatibility tests for extension points.
4. Reduce deep imports from UI and CLI packages.
5. Create shared UI event/state contracts.

## Phase 4 — Product Polish

1. Make CLI/TUI/WebUI permission prompts consistent.
2. Improve help and onboarding flows.
3. Add more tested examples.
4. Improve benchmark reporting.
5. Prepare release-quality documentation and migration notes.

---

## Concrete Test Ideas

### Agent Lifecycle Tests

- A fake provider returns text; agent completes without tools.
- A fake provider returns a tool call; fake tool executes; provider receives tool result; final answer is produced.
- Provider throws once; retry policy handles it.
- Provider keeps requesting tools until iteration limit is reached.
- Context compactor runs when token threshold is exceeded.
- User abort cancels provider and tool execution.

### Tool Tests

- Tool with `permission: 'auto'` executes directly.
- Tool with `permission: 'confirm'` emits confirmation request.
- Tool with `permission: 'deny'` never executes.
- Streaming tool emits progress events and final output.
- Tool cleanup runs after cancellation.
- Tool errors are converted into safe tool result messages.

### Permission Tests

- Read-only commands are allowed.
- Mutating workspace commands are classified correctly.
- Destructive commands require confirmation.
- Network commands are gated.
- Credential-writing commands require confirmation.
- Commands outside workspace are gated or denied depending on policy.

### Provider Tests

- Anthropic-style tool call normalization.
- OpenAI-style tool call normalization.
- Google-style response normalization.
- OpenAI-compatible provider quirks.
- Streaming delta assembly.
- Retryable vs non-retryable errors.

### UI Contract Tests

- Permission prompt event renders consistently.
- Tool progress events update UI state.
- Provider streaming text is displayed incrementally.
- Run cancellation updates state.
- Session restored state renders correctly.

---

## Areas to Avoid Over-Optimizing Right Now

### Avoid a full rewrite

The current architecture is already coherent. A rewrite would likely consume time without addressing the highest risks.

### Avoid premature package splitting

The core package is meaningful as a cohesive kernel. Splitting it too early may add complexity without improving maintainability.

### Avoid UI divergence

Do not let CLI, TUI, WebUI, and Desktop each define separate semantics for permissions, sessions, tools, or slash commands.

### Avoid provider-specific leakage

Do not let one model provider’s concepts become implicit assumptions in the core agent lifecycle.

### Avoid plugin power without observability

Plugins and hooks should remain powerful, but their effects must be visible in traces and logs.

---

## Overall Assessment

WrongStack appears to be in a strong architectural position. The project has the right foundational abstractions for an autonomous coding agent:

- A small kernel with DI, pipelines, events, run control, and context state.
- Clear package layering.
- Provider abstraction.
- Tool abstraction with streaming progress.
- Permission-aware execution.
- Multiple UI/product surfaces.
- Plugin and MCP extensibility.
- Significant architectural documentation.

The next stage should focus on reliability and enforceability rather than reinvention. The highest-value improvements are automated architecture checks, lifecycle regression tests, permission matrix tests, event traceability, and stable extension contracts.

In short: WrongStack does not need a new architecture. It needs stronger guardrails around the architecture it already has.
