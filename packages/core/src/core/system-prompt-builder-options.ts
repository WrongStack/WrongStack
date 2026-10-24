/** Construction options of the {@link DefaultSystemPromptBuilder} (system-prompt-builder.ts). */

import type { TokenSavingTier } from '@wrongstack/contracts/types/config';
import type { MemoryStore } from '@wrongstack/contracts/types/memory';
import type { ModeStore } from '@wrongstack/contracts/types/mode';
import type { SkillLoader } from '@wrongstack/contracts/types/skill';
import type { ModelCapabilities } from '@wrongstack/contracts/types/system-prompt';
import type { SystemPromptContributor } from '@wrongstack/contracts/types/system-prompt-contributor';
import type { InstructionBundle, InstructionBundlePaths } from './instruction-bundle.js';

export interface DefaultSystemPromptBuilderOptions {
  memoryStore?: MemoryStore | undefined;
  /**
   * Inject a static "# Relevant Memory" section into the built prompt from
   * `memoryStore`. Default: true. Set to false when a dedicated per-turn memory
   * retriever (the SAGE turn middleware) is the single injection
   * channel — this avoids double-injecting the same memories and keeps all
   * memory context flowing through one system.
   */
  injectMemory?: boolean | undefined;
  skillLoader?: SkillLoader | undefined;
  /**
   * How skill bodies reach the prompt. `'progressive'` (runtime default)
   * injects only a name+trigger manifest; `'eager'` injects discovered bodies
   * and relies on the agent calling the `skill` tool to load a body on demand
   * (the agentskills.io progressive-disclosure model).
   */
  skillMode?: 'eager' | 'progressive' | undefined;
  /**
   * In eager mode, cap the total chars of injected skill bodies (highest-priority
   * skills first); the rest become a load-on-demand manifest. Bounds prompt
   * cost when many skills are discovered. Default ~24k chars.
   */
  skillEagerMaxChars?: number | undefined;
  modeStore?: ModeStore | undefined;
  /** Pre-resolved active mode id — shown in environment block. */
  modeId?: string | undefined;
  /** Pre-resolved mode prompt — avoids redundant modeStore.getActiveMode() call. */
  modePrompt?: string | undefined;
  /** Model capabilities — object snapshot or lazy getter for live model switches. */
  modelCapabilities?: ModelCapabilities | (() => ModelCapabilities | undefined) | undefined;
  todayIso?: string | undefined;
  /**
   * Path to the session's plan JSON, or a getter that returns it. When
   * set, the builder reads the file on every `build()` call and injects
   * an "Active plan" block listing open items, so the LLM is anchored to
   * the strategic roadmap every turn — not just at resume. The block is
   * tagged `ephemeral` so a plan edit on turn N doesn't invalidate the
   * provider's prefix cache for earlier turns.
   *
   * The function form lets callers bind the builder before the session
   * id is known (e.g. DI containers that resolve the builder lazily) —
   * the getter is called at build-time, after the session has been
   * created.
   */
  planPath?: string | (() => string | undefined);
  /**
   * System prompt contributors — called on every `build()` to inject
   * additional TextBlocks. Use `ExtensionRegistry.listSystemPromptContributors()`
   * or pass a plain array. Contributors are called in order; a throwing
   * contributor is caught and logged without aborting the build.
   */
  contributors?: readonly SystemPromptContributor[] | undefined;
  /**
   * Operator-supplied text appended to the host prompt for this process
   * (`--append-system-prompt` / `--append-system-prompt-file`). Fixed for the
   * session, so it sits in the stable `session` region where it stays inside
   * the provider's cached prefix. Subagents do not receive it: they run a
   * narrow task under their own prompt.
   */
  appendedInstructions?: string | undefined;
  /**
   * The user-scope instruction file. Default `~/.wrongstack/AGENTS.md`
   * (under `WRONGSTACK_HOME` when set); `false` leaves it out.
   */
  userInstructionsFile?: string | false | undefined;
  /**
   * Token-saving mode tier. Controls how aggressively the system prompt is
   * compacted: skill bodies are omitted/trimmed, tool hints are shortened,
   * and optional guidance sections (delegation, mailbox, context management)
   * use minimal versions to reduce per-request tokens.
   *
   * - 'off'        — Full guidance (no reduction)
   * - 'minimal'    — TIER1 tools, stripped guidance
   * - 'light'     — TIER1 + memory tools, minimal patterns
   * - 'medium'    — TIER1 + TIER2 tools, some guidance
   * - 'aggressive' — Maximum reduction before tools become unusable
   *
   * Boolean values are accepted for backward compatibility:
   * - `true`  → 'medium'
   * - `false` → 'off'
   */
  tokenSavingMode?: TokenSavingTier | boolean | undefined;
  /**
   * File-backed instruction layers. Builtins are loaded first, then global
   * overrides, then project overrides, then explicit files. This lets durable
   * system instructions live outside TypeScript while keeping the builder API
   * stable for embedded runtimes.
   */
  instructionPaths?: InstructionBundlePaths | undefined;
  /**
   * Last-mile in-memory overrides, applied after instructionPaths. Useful for
   * tests, embedders, and plugin-provided prompt experiments.
   */
  instructionBundle?: InstructionBundle | undefined;
  /**
   * Project jargon dictionary source. When set, the builder appends a
   * compact `[Project Jargon Dictionary]` block to the prompt, sourced
   * from SAGE-tagged `domain-term` memories. The host CLI/TUI/WebUI is
   * responsible for handing the *same* `ProjectSageMemoryPort` it uses
   * for memory injection into this slot — see
   * `packages/core/src/core/system-prompt-glossary.ts` for the wiring
   * contract and the SAGE architectural-rule cross-reference.
   *
   * omit → no glossary block (default).
   */
  domainGlossary?: MemoryStore | undefined;
}
