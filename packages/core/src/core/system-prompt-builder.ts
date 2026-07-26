import * as os from 'node:os';
import * as path from 'node:path';
import type { MailboxAgentStatus } from '../coordination/mailbox-types.js';
import type { TextBlock } from '../types/blocks.js';
import type { ConcreteTokenSavingTier, TokenSavingTier } from '../types/config.js';
import { resolveTokenSavingTier } from '../types/config.js';
import type { MemoryStore } from '../types/memory.js';
import type { ModeStore } from '../types/mode.js';
import type { SkillLoader } from '../types/skill.js';
import type {
  BuildContext,
  ModelCapabilities,
  SystemPromptBuilder,
  SystemPromptRegions,
} from '../types/system-prompt.js';
import { flattenSystemPromptRegions } from '../types/system-prompt.js';
import type { SystemPromptContributor } from '../types/system-prompt-contributor.js';
import type { Tool } from '../types/tool.js';
import {
  type InstructionBundle,
  type InstructionBundlePaths,
  loadInstructionBundle,
  mergeInstructionBundle,
} from './instruction-bundle.js';
import { PROMPT as DEFAULT_PROMPT, LEADER_AFTER_TASK_PROMPT } from './modes/default.js';
import { detectLanguages, dirExists, gitStatus } from './system-prompt-environment-probes.js';
import { compactTrigger } from './system-prompt-skill-text.js';
import {
  buildCompactSkillBodiesText,
  buildFullSkillBodiesText,
  buildProgressiveSkillManifestText,
} from './system-prompt-skill-bodies.js';
import {
  effectiveShell,
  SHELL_DISPLAY,
  shellGuidanceBlock,
} from './system-prompt-shell.js';
import { type ActivePlanCache, readActivePlanBlock } from './system-prompt-plan.js';
export { effectiveShell, shellGuidanceBlock, type EffectiveShell } from './system-prompt-shell.js';

export const LAYER_1_IDENTITY = DEFAULT_PROMPT;

/**
 * The section of the system prompt a given TextBlock originated from. Used by
 * `getContextBreakdown()` to attribute real token counts per category in the
 * `/context` display.
 */
export type SystemBlockSource =
  | 'identity' // layer1 — instructions/system.md
  | 'tool-usage' // layer2 — tool prose summary
  | 'environment' // layer3 — OS/git/date/skills-in-scope
  | 'skills' // layer4 — Active Skills bodies (+ memory when injectMemory)
  | 'mode' // layer5 mode prompt + mode-skill hint
  | 'plan' // layer6 — active plan
  | 'leader-after-task' // leader-only after-task affordances
  | 'contributor' // plugin-contributed volatile blocks
  | 'ledger' // volatile completed-work ledger (request-time)
  | 'nextsteps'; // volatile next-steps gate (request-time)

/**
 * Side-table mapping each system-prompt TextBlock to the section it came from.
 * Kept as a WeakMap rather than a field on TextBlock so the label never reaches
 * the wire: the provider adapters spread blocks verbatim (Anthropic non-ttl
 * `: b`, OpenAI `stripCacheControl` rest-spread), so any extra field would leak.
 * Block identities survive `flattenSystemPromptRegions` into `ctx.systemPrompt`,
 * so a later read of `ctx.systemPrompt` resolves the same entries.
 */
export const SYSTEM_BLOCK_SOURCE = new WeakMap<TextBlock, SystemBlockSource>();

/** Tag a freshly-built block with its origin, returning the same reference. */
function tagBlock(block: TextBlock, source: SystemBlockSource): TextBlock {
  SYSTEM_BLOCK_SOURCE.set(block, source);
  return block;
}

function shortSessionId(sessionId: string): string {
  const leaf = sessionId.split('/').pop() ?? sessionId;
  return leaf.length > 12 ? `${leaf.slice(0, 12)}…` : leaf;
}

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
   * How skill bodies reach the prompt. `'eager'` (default) injects every
   * discovered skill body; `'progressive'` injects only a name+trigger manifest
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
}

export class DefaultSystemPromptBuilder implements SystemPromptBuilder {
  /**
   * Cached environment block, keyed by projectRoot. A single builder
   * instance is normally reused across turns of the same agent run, but
   * tests and library consumers may reuse it across runs with different
   * roots; keying the cache prevents leaking the first call's project
   * state into a later call against an unrelated project.
   */
  private envCacheByRoot = new Map<string, string>();
  private skillCache?: string | undefined;
  /** Cached full skill bodies (after frontmatter), built once per session. */
  private skillBodyCache?: string | undefined;
  /** Tools from last build — used for memory relevance scoring. */
  private _lastBuildTools?: Tool[] | undefined;
  /** Cached rendered online agents string, keyed by content fingerprint. */
  private _lastOnlineAgents?: { hash: string; text: string } | undefined;
  /** Cached full buildToolUsage output — keyed by tools array ref + agents fingerprint + tier. */
  private _toolsUsageCache?:
    | { toolsRef: readonly Tool[]; agentsHash: string; tier: string; text: string }
    | undefined;
  private _instructionBundle?: Promise<InstructionBundle> | undefined;
  constructor(private readonly opts: DefaultSystemPromptBuilderOptions = {}) {}

  /**
   * Normalizes `tokenSavingMode` to a boolean for backward-compatible boolean checks.
   * - `undefined` / `false` / `'off'` → false
   * - `true` / any tier string other than `'off'` → true
   *
   * Note: invalid tier strings (e.g. "MINIMAL") are coerced to 'off'
   * by `normalizeTokenSavingTier` via the `tier` getter, so isCompact
   * correctly returns false for them — preventing isCompact/tier
   * disagreement on bad input.
   */
  private get isCompact(): boolean {
    return this.tier !== 'off';
  }

  /** Exposes the effective (concrete) `TokenSavingTier` for tier-aware guidance
   *  decisions. Invalid strings coerce to 'off'; the `'auto'` sentinel expands
   *  from the model's context window (cache-safe — the window is stable per
   *  session, so the resolved tier and therefore the prompt prefix stay stable).
   *  See packages/core/src/types/config.ts. */
  private get tier(): ConcreteTokenSavingTier {
    return resolveTokenSavingTier(
      this.opts.tokenSavingMode,
      this.modelCapabilities()?.maxContextTokens,
    );
  }

  /**
   * Returns the max tool description length for the current tier.
   * Per the design doc: off=80, minimal=40, light=50, medium=60, aggressive=70.
   */
  private toolDescLimit(): number {
    switch (this.tier) {
      case 'minimal':
        return 30;
      case 'light':
        return 40;
      case 'medium':
        return 50;
      case 'aggressive':
        return 60;
      default:
        return 70;
    }
  }

  async build(ctx: BuildContext): Promise<TextBlock[]> {
    return flattenSystemPromptRegions(await this.buildRegions(ctx));
  }

  async buildRegions(ctx: BuildContext): Promise<SystemPromptRegions> {
    this._lastBuildTools = ctx.tools;
    // Re-read skill entries on every build so newly created/edited skills
    // (which call SkillLoader.invalidateCache()) are picked up without a
    // process restart. The SkillLoader itself caches disk I/O, so this is
    // cheap — only string formatting, no filesystem reads for cached data.
    if (this.opts.skillLoader) {
      try {
        const entries = await this.opts.skillLoader.listEntries();
        if (entries.length > 0) {
          const lines: string[] = [];
          for (const e of entries) {
            // Compact format: name + shortened trigger (full body in Active Skills)
            const shortTrigger = compactTrigger(e.trigger);
            lines.push(`- **${e.name}**  (${shortTrigger})`);
          }
          this.skillCache = lines.join('\n');
        } else {
          this.skillCache = '';
        }
      } catch {
        this.skillCache = '';
      }
    } else {
      this.skillCache = '';
    }

    const instructions = await this.instructions();
    const layer1 = instructions.system?.identity ?? LAYER_1_IDENTITY;
    const layer2 = await this.buildToolUsage(ctx.tools, ctx);
    const layer3 = await this.buildEnvironment(ctx);
    const layer3WithDir = `${layer3}\n- Project root: ${ctx.projectRoot}`;
    const layer4 = await this.buildMemoryAndSkills();
    const layer5 = await this.buildMode();
    // Plans anchor the HOST agent across turns. Subagents run one
    // narrow task and shouldn't carry the host's strategic context —
    // it just bloats their prompt and risks them mutating a plan
    // they weren't supposed to touch.
    const layer6 = ctx.subagent ? '' : await this.buildActivePlan();

    const core: TextBlock[] = [
      tagBlock(
        { type: 'text', text: layer1, cache_control: { type: 'ephemeral' } },
        'identity',
      ),
      tagBlock(
        { type: 'text', text: layer2, cache_control: { type: 'ephemeral' } },
        'tool-usage',
      ),
    ];
    const session: TextBlock[] = [
      tagBlock(
        { type: 'text', text: layer3WithDir, cache_control: { type: 'ephemeral' } },
        'environment',
      ),
    ];
    const volatile: TextBlock[] = [];

    if (layer4.trim()) {
      session.push(
        tagBlock(
          { type: 'text', text: layer4, cache_control: { type: 'ephemeral' } },
          'skills',
        ),
      );
    }

    if (layer5.trim()) {
      session.push(
        tagBlock(
          { type: 'text', text: layer5, cache_control: { type: 'ephemeral' } },
          'mode',
        ),
      );
    }

    // Suggested skills for the active mode — helps the model know which
    // domain instructions to prioritize when multiple skills are loaded.
    if (this.opts.modeStore && this.opts.skillLoader) {
      try {
        const activeMode = await this.opts.modeStore.getActiveMode();
        if (activeMode?.suggestedSkills && activeMode.suggestedSkills.length > 0) {
          const skills = await this.opts.skillLoader.list();
          const loadedNames = new Set(skills.map((s) => s.name));
          const available = activeMode.suggestedSkills.filter((n) => loadedNames.has(n));
          if (available.length > 0) {
            session.push(
              tagBlock(
                {
                  type: 'text',
                  text: `Mode "${activeMode.id}" works best with these skills: ${available.join(', ')}. Their full instructions are in the Active Skills block above.`,
                  cache_control: { type: 'ephemeral' },
                },
                'mode',
              ),
            );
          }
        }
      } catch {
        // skip — non-critical hint
      }
    }

    if (layer6.trim()) {
      volatile.push(
        tagBlock(
          { type: 'text', text: layer6, cache_control: { type: 'ephemeral' } },
          'plan',
        ),
      );
    }

    // System prompt contributors — plugins inject ephemeral context here.
    if (this.opts.contributors && this.opts.contributors.length > 0) {
      for (const c of this.opts.contributors) {
        try {
          const contributed = await c(ctx);
          for (const b of contributed) tagBlock(b, 'contributor');
          volatile.push(...contributed);
        } catch {
          // Contributor errors are swallowed — a bad plugin shouldn't
          // break the system prompt assembly.
        }
      }
    }

    // Leader-only after-task affordances (the `<nextsteps>` block + post-task
    // mailbox update). Host-only and appended last: subagents are headless
    // workers whose output is parsed (SDD spec/plan/task JSON) or rolled up by
    // the parent, so a `<nextsteps>` tag there is just noise that leaks into
    // specs/plans. Lives outside layer1 so the host keeps it in EVERY mode while
    // no subagent ever receives it.
    if (!ctx.subagent) {
      session.push(
        tagBlock(
          {
            type: 'text',
            text: instructions.system?.leaderAfterTask ?? LEADER_AFTER_TASK_PROMPT,
          },
          'leader-after-task',
        ),
      );
    }

    return { core, session, volatile };
  }

  private async instructions(): Promise<InstructionBundle> {
    if (!this._instructionBundle) {
      this._instructionBundle = loadInstructionBundle(this.opts.instructionPaths).then((bundle) =>
        this.opts.instructionBundle
          ? mergeInstructionBundle(bundle, this.opts.instructionBundle)
          : bundle,
      );
    }
    return this._instructionBundle;
  }

  private instructionSection(
    bundle: InstructionBundle,
    key: string,
    vars: Record<string, string | number> = {},
  ): string {
    const template = bundle.sections?.[key];
    if (!template) return '';
    return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, name: string) => {
      const value = vars[name];
      return value === undefined ? match : String(value);
    });
  }

  /**
   * Cached plan content keyed by (planPath, mtimeMs). The plan is read
   * once per system-prompt build; most turns don't change the plan, so
   * this avoids a blocking fs.readFile + JSON.parse on every iteration.
   * Cleared when the file's mtime changes (the `/plan` tool mutated it).
   */
  private _planCache?: ActivePlanCache | undefined;

  /**
   * Reads the session-scoped plan sidecar (when configured) and produces
   * a short "Active plan" block listing open items so the model is
   * anchored to the strategic roadmap every turn. Reads on every `build()`
   * so a plan edit (via `/plan` or the `plan` tool) reflects on the next
   * turn without restarting the session.
   */
  private async buildActivePlan(): Promise<string> {
    const planPath =
      typeof this.opts.planPath === 'function' ? this.opts.planPath() : this.opts.planPath;
    const result = await readActivePlanBlock({
      planPath,
      cache: this._planCache,
    });
    this._planCache = result.cache;
    return result.text;
  }

  private async buildToolUsage(tools: Tool[], ctx: BuildContext): Promise<string> {
    if (tools.length === 0) return '## Tool usage\n\nNo tools registered.';
    const instructions = await this.instructions();

    // Cache: tools array is stable (same reference) until a registry mutation
    // thanks to B2 (ToolRegistry snapshot). Online agents are keyed by content
    // fingerprint — the mailbox rebuilds the array on every status check, so
    // reference equality would always miss. When all three keys match the
    // previous build, the full output is identical — return the cached
    // string. Including `tier` in the key ensures that mutating
    // `opts.tokenSavingMode` between builds (rare but supported via the
    // `private readonly opts` design) recomputes the prompt with the
    // new tier's truncation limits and tier-gated content.
    const agentsHash = this.agentsFingerprint(ctx.onlineAgents);
    const tier = this.tier;
    if (
      this._toolsUsageCache?.toolsRef === tools &&
      this._toolsUsageCache?.agentsHash === agentsHash &&
      this._toolsUsageCache?.tier === tier
    ) {
      return this._toolsUsageCache.text;
    }

    // Group tools by category for a cleaner listing when categories are used.
    const byCat = new Map<string, Tool[]>();
    const uncategorized: Tool[] = [];
    for (const t of tools) {
      if (t.category) {
        let group = byCat.get(t.category);
        if (!group) {
          group = [];
          byCat.set(t.category, group);
        }
        group.push(t);
      } else {
        uncategorized.push(t);
      }
    }

    const lines = ['## Tool usage'];
    const descLimit = this.toolDescLimit();

    // Categorized tools
    for (const [cat, catTools] of byCat) {
      lines.push(`\n### ${cat}`);
      for (const t of catTools) {
        const hint = t.usageHint ?? t.description;
        // Trim to the tier-specific limit, preferring sentence boundaries.
        const desc =
          hint.length > descLimit
            ? hint.slice(0, hint.indexOf('.', 20) + 1 || descLimit) +
              (hint.length > descLimit ? '…' : '')
            : hint.trim();
        lines.push(`- **${t.name}** — ${desc}`);
        const boundary = this.renderToolSelectionBoundary(t);
        if (boundary) lines.push(`  ${boundary}`);
      }
    }

    // Uncategorized tools
    if (uncategorized.length > 0) {
      if (byCat.size > 0) lines.push('');
      for (const t of uncategorized) {
        const hint = t.usageHint ?? t.description;
        lines.push(`\n### ${t.name}\n${hint.trim()}`);
        const boundary = this.renderToolSelectionBoundary(t);
        if (boundary) lines.push(boundary);
      }
    }

    // Common tool chain patterns — teaches model how to compose tools effectively.
    // Skipped in minimal and aggressive tiers — model already knows these patterns
    // and aggressive users are under context pressure.
    if (this.tier !== 'minimal' && this.tier !== 'aggressive') {
      const commonPatterns = this.instructionSection(instructions, 'tool.common.patterns');
      if (commonPatterns) lines.push(commonPatterns);
    }

    // Delegation guidance — included when the `delegate` tool is present.
    // Without this block the model doesn't know that multi-agent work is
    // even an option, and `delegate` sits unused while the host agent
    // tries to do everything in one expensive context.
    // Tier behaviour:
    // - 'off' / 'medium' / 'aggressive' → full block
    // - 'light' → minimal one-liner
    // - 'minimal' → skipped
    const hasDelegate = tools.some((t) => t.name === 'delegate');
    if (hasDelegate) {
      const delegateTool = tools.find((t) => t.name === 'delegate');
      const enumValues = (() => {
        const role = (
          delegateTool?.inputSchema as
            | { properties?: { role?: { enum?: unknown | undefined } } }
            | undefined
        )?.properties?.role?.enum;
        return Array.isArray(role) ? (role.filter((r) => typeof r === 'string') as string[]) : [];
      })();
      const roleList = enumValues.length > 0 ? enumValues.join(', ') : '(no roster configured)';
      if (this.tier === 'minimal') {
        // Skip — don't emit any delegation guidance
      } else if (this.tier === 'light' || this.tier === 'medium' || this.tier === 'aggressive') {
        // Token-saving tiers get the compact one-liner instead of the full
        // multi-paragraph guidance. `aggressive` joins the compact group —
        // a user under context pressure doesn't need a 600-token essay on
        // subagent scoping.
        const delegation = this.instructionSection(instructions, 'tool.delegation.compact', {
          roleList,
        });
        if (delegation) lines.push(delegation);
      } else {
        const delegation = this.instructionSection(instructions, 'tool.delegation.full', {
          roleList,
        });
        if (delegation) lines.push(delegation);
      }
    }

    // Mailbox guidance — included when any mailbox tool is present.
    // Tier behaviour:
    // - 'off' → full block
    // - every token-saving tier → compact project-wide contract
    //
    // Note: 'aggressive' was previously listed with 'off' for the
    // full block, but per the parallel-session decision (Option H,
    // `leader@1b68eb14`): at aggressive, the 400-token mailbox essay
    // is the largest single guidance section and users under context
    // pressure don't need it. The compact one-liner is enough.
    const hasMailbox = tools.some(
      (t) => t.name === 'mailbox' || t.name === 'mail_send' || t.name === 'mail_inbox',
    );
    if (hasMailbox) {
      // Build online-agent info — cached by a rendered-field fingerprint so
      // joins/leaves and live status/task/tool changes invalidate it.
      const onlineAgentsInfo = this.renderOnlineAgents(ctx.onlineAgents);
      const hasMailboxPowerTool = tools.some((t) => t.name === 'mailbox');
      const mailStatusCommand = tools.some((t) => t.name === 'fleet_status')
        ? '`fleet_status`'
        : hasMailboxPowerTool
          ? '`mailbox action=status` or `mailbox action=online`'
          : 'the online-agent list above';
      const mailInboxCommand = tools.some((t) => t.name === 'mail_inbox')
        ? '`mail_inbox`'
        : '`mailbox action=check`';
      const mailSendCommand = tools.some((t) => t.name === 'mail_send')
        ? '`mail_send`'
        : '`mailbox action=send`';
      const mailboxVars = {
        onlineAgentsInfo,
        mailStatusCommand,
        mailInboxCommand,
        mailSendCommand,
      };
      if (this.tier !== 'off') {
        // Minimal: keep just the header and agent count.
        // `aggressive` joins `light`/`medium` — the 400-token mailbox essay
        // is the largest single guidance section; users under context pressure
        // don't need it.
        const mailbox = this.instructionSection(
          instructions,
          'tool.mailbox.compact',
          mailboxVars,
        );
        if (mailbox) lines.push(mailbox);
      } else {
        const mailbox = this.instructionSection(instructions, 'tool.mailbox.full', mailboxVars);
        if (mailbox) lines.push(mailbox);
      }
    }

    // Commit hygiene — shown whenever the structured `git` tool is available.
    // Other agents (or a separate wrongstack process, or a human) may be
    // editing the SAME working tree at the same time; a blanket commit captures
    // their half-done work and there is no clean way to undo a shared commit.
    const hasGitTool = tools.some((t) => t.name === 'git');
    if (hasGitTool && this.tier !== 'minimal' && this.tier !== 'light') {
      const commitHygiene = this.instructionSection(instructions, 'tool.commit.hygiene');
      if (commitHygiene) lines.push(commitHygiene);
    }

    // MCP lazy-loading guidance — shown whenever mcp_control is registered.
    // Tier behaviour:
    // - 'off' / 'medium' → full guidance block
    // - 'minimal' / 'light' / 'aggressive' → minimal one-liner
    //
    // Note: 'aggressive' was previously listed with 'off' for the
    // full block, but per the parallel-session decision (Option H):
    // at aggressive, the full MCP workflow (activate → use →
    // deactivate) is documented elsewhere and the meta-tool
    // `mcp_use` is sufficient. The one-liner is enough.
    const hasMcpControl = tools.some((t) => t.name === 'mcp_control');
    const hasMcpUse = tools.some((t) => t.name === 'mcp_use');
    if (hasMcpControl) {
      if (this.tier === 'minimal' || this.tier === 'light' || this.tier === 'aggressive') {
        // Minimal one-liner — `aggressive` joins `minimal`/`light`. The full
        // MCP workflow (activate → use → deactivate) is documented elsewhere
        // and the meta-tool `mcp_use` is sufficient at any tier that has it.
        const mcp = this.instructionSection(
          instructions,
          hasMcpUse ? 'tool.mcp.compact.use' : 'tool.mcp.compact.control',
        );
        if (mcp) lines.push(mcp);
      } else {
        // Full block
        const mcp = this.instructionSection(
          instructions,
          hasMcpUse ? 'tool.mcp.full.use' : 'tool.mcp.full.control',
        );
        if (mcp) lines.push(mcp);
      }
    }

    // Context management guidance — shown when context_manager is registered.
    // Tier behaviour:
    // - 'off' / 'aggressive' → full block
    // - 'medium' → minimal one-liner
    // - 'minimal' / 'light' → skipped
    const hasContextManager = tools.some((t) => t.name === 'context_manager');
    if (hasContextManager) {
      if (this.tier === 'minimal' || this.tier === 'light') {
        // Skip
      } else if (this.tier === 'medium') {
        const contextManagement = this.instructionSection(
          instructions,
          'tool.context.management.compact',
        );
        if (contextManagement) lines.push(contextManagement);
      } else {
        // Adaptive threshold based on model context window size.
        // Small context (<=32k) → trigger earlier; large context (>32k) → more relaxed.
        // Fallback to 0 when unknown → conservative compaction (50 % threshold).
        const maxCtx = this.modelCapabilities()?.maxContextTokens ?? 0;
        const threshold = maxCtx <= 32000 ? '50' : '70';
        const contextManagement = this.instructionSection(
          instructions,
          'tool.context.management.full',
          { threshold },
        );
        if (contextManagement) lines.push(contextManagement);
      }
    }

    // Store cache — keyed by tools reference (B2 snapshot) + agents content
    // fingerprint + tier, so it auto-invalidates when tools change, agents
    // join/leave, or the token-saving tier changes.
    const text = lines.join('\n');
    this._toolsUsageCache = { toolsRef: tools, agentsHash, tier, text };
    return text;
  }

  private renderToolSelectionBoundary(tool: Tool): string {
    const selection = tool.selection;
    if (!selection?.doNotUseWhen.trim()) return '';
    const alternatives = selection.useInstead?.filter(Boolean) ?? [];
    const instead = alternatives.length > 0 ? ` Use ${alternatives.map((name) => `\`${name}\``).join(' or ')} instead.` : '';
    return `Do not use when ${selection.doNotUseWhen.trim()}${instead}`;
  }

  /**
   * Cheap content fingerprint of the online agents array. The mailbox
   * rebuilds the array as a fresh object on every status check, so caching
   * by reference always misses — this lets the renderOnlineAgents and
   * buildToolUsage caches detect rendered identity/status/task/tool changes
   * instead.
   *
   * O(n) over every field rendered in the peer snapshot. This matters because
   * status/task/tool changes should invalidate the prompt just like joins and
   * leaves do. Uses FNV-1a over character codes; a collision would only leave a
   * stale cosmetic snapshot in the prompt.
   */
  private agentsFingerprint(agents: readonly MailboxAgentStatus[] | undefined): string {
    if (!agents || agents.length === 0) return '0';
    let h = 0x811c9dc5;
    for (const a of agents) {
      const fields = [
        a.agentId,
        a.name,
        a.source,
        a.sessionId,
        a.status,
        a.currentTask,
        a.currentTool,
        a.online ? '1' : '0',
      ];
      for (const field of fields) {
        const value = field ?? '';
        for (let i = 0; i < value.length; i++) {
          h ^= value.charCodeAt(i);
          h = Math.imul(h, 0x01000193) >>> 0;
        }
        h ^= 0xff;
        h = Math.imul(h, 0x01000193) >>> 0;
      }
    }
    return `${agents.length}:${h.toString(36)}`;
  }

  /**
   * Render the online agents list, cached by content fingerprint. The agents
   * list changes at join/leave pace (seconds to minutes), not every prompt
   * build turn (hundreds of ms). The fingerprint detects membership changes
   * without holding the array reference — the mailbox rebuilds the array as
   * a fresh object on every status check, so reference equality always misses.
   *
   * Tier behaviour:
   * - 'off' / 'medium' / 'aggressive' → full list with names, sessions, sources
   * - 'minimal' / 'light' → count only (no list)
   */
  private renderOnlineAgents(agents: readonly MailboxAgentStatus[] | undefined): string {
    if (!agents || agents.length === 0) return '';

    // Content fingerprint: detects membership changes without holding the
    // array reference, which is rebuilt as a fresh object on every status check.
    const hash = this.agentsFingerprint(agents);
    if (this._lastOnlineAgents?.hash === hash) {
      return this._lastOnlineAgents.text;
    }

    const totalCount = agents.length;
    // minimal / light tiers: count only, no list
    if (this.tier === 'minimal' || this.tier === 'light') {
      const text = ` (${totalCount} agent${totalCount !== 1 ? 's' : ''} online)`;
      this._lastOnlineAgents = { hash, text };
      return text;
    }

    const inlineData = (value: string, max = 120): string =>
      value.replace(/[`\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
    const agentList = agents
      .map((a) => {
        const details = [
          `id: \`${inlineData(a.agentId ?? a.name, 96)}\``,
          `client: ${inlineData(a.source ?? 'unknown', 32)}`,
          a.status ? `status: ${inlineData(a.status, 32)}` : undefined,
          a.currentTask ? `task: \`${inlineData(a.currentTask)}\`` : undefined,
          a.currentTool ? `tool: \`${inlineData(a.currentTool, 64)}\`` : undefined,
          a.sessionId ? `session: ${shortSessionId(inlineData(a.sessionId, 96))}` : undefined,
        ].filter((part): part is string => part !== undefined);
        return `- **${inlineData(a.name, 96)}** — ${details.join('; ')}`;
      })
      .join('\n');
    const text = `\n\n**Currently online (${totalCount} agent${totalCount !== 1 ? 's' : ''}):**\n${agentList}`;
    this._lastOnlineAgents = { hash, text };
    return text;
  }

  private async buildEnvironment(ctx: BuildContext): Promise<string> {
    const modelCapabilities = this.modelCapabilities();
    const cacheKey = [
      ctx.projectRoot,
      ctx.provider ?? '',
      ctx.model ?? '',
      modelCapabilities?.maxContextTokens ?? 0,
      modelCapabilities?.supportsTools ? 1 : 0,
      modelCapabilities?.supportsVision ? 1 : 0,
      modelCapabilities?.supportsReasoning ? 1 : 0,
    ].join('\0');
    const cached = this.envCacheByRoot.get(cacheKey);
    if (cached) return cached;
    const today = this.opts.todayIso ?? new Date().toISOString().slice(0, 10);
    const platform = `${os.platform()} ${os.release()}`;
    // The bash tool's effective shell, pinned at boot via WRONGSTACK_SHELL.
    // On POSIX we keep reporting the raw $SHELL; on Windows we report the
    // resolved shell + a "write X syntax" nudge, and append a syntax guidance
    // sub-block below so the model doesn't default to bash/POSIX idioms.
    const effShell = effectiveShell(os.platform(), process.env['WRONGSTACK_SHELL']);
    const shell =
      effShell === 'posix'
        ? (process.env.SHELL ?? process.env.ComSpec ?? 'unknown')
        : SHELL_DISPLAY[effShell];
    const node = process.version;
    const isGit = await dirExists(path.join(ctx.projectRoot, '.git'));
    // Fan out the per-root probes so the prompt build doesn't serialize
    // ~12 fs.access calls plus the git status spawn back-to-back. On a
    // cold cache (CI / first turn) this trims hundreds of ms.
    const [git, langs] = await Promise.all([
      isGit ? gitStatus(ctx.projectRoot) : Promise.resolve('not a git repo'),
      detectLanguages(ctx.projectRoot),
    ]);

    // Tier-aware environment block content.
    // - 'off':        Full — all fields
    // - 'minimal':    Compact single line — git + date only
    // - 'light':      +platform
    // - 'medium':     +languages
    // - 'aggressive': +capabilities (context window, provider/model)
    const tier = this.tier;
    const lines: string[] = ['## Environment'];

    if (tier === 'minimal') {
      // Single compact line
      lines.push(`- Git: ${git} | Date: ${today}`);
    } else {
      lines.push(`- Operating system: ${platform}`);
      if (tier !== 'light') {
        lines.push(`- Shell: ${shell}`);
        lines.push(`- Node.js: ${node}`);
      }
      // Languages appear in the full ('off') block and the richer trimming
      // tiers; only 'minimal' (single line) and 'light' (platform only) omit
      // them. 'off' is the most complete tier (no token saving), per the
      // toolDescLimit ordering off=80 > aggressive=70 > … > minimal=40.
      if (tier === 'off' || tier === 'medium' || tier === 'aggressive') {
        lines.push(`- Detected languages: ${langs}`);
      }
      lines.push(`- Git status: ${git}`);
      lines.push(`- Today's date: ${today}`);
      if (tier === 'aggressive') {
        if (ctx.provider || ctx.model) {
          lines.push(
            `- Running on: ${ctx.provider ?? '<unknown provider>'}/${ctx.model ?? '<unknown model>'}`,
          );
        }
        if (modelCapabilities) {
          lines.push(
            `- Context window: ${modelCapabilities.maxContextTokens.toLocaleString()} tokens max`,
          );
        }
      }
      if (tier !== 'aggressive' && modelCapabilities) {
        lines.push(
          `- Context window: ${modelCapabilities.maxContextTokens.toLocaleString()} tokens max`,
        );
      }
      if (tier !== 'aggressive' && (ctx.provider || ctx.model)) {
        lines.push(
          `- Running on: ${ctx.provider ?? '<unknown provider>'}/${ctx.model ?? '<unknown model>'}`,
        );
      }
      if (tier !== 'aggressive' && this.opts.modeId && this.opts.modeId !== 'default') {
        lines.push(`- Mode: ${this.opts.modeId}`);
      }
    }

    // Shell syntax guidance — only meaningful on Windows, where the model must
    // not fall back to bash/POSIX idioms. Tier-gated: full for off/medium/
    // aggressive, a one-liner for light, omitted for minimal. POSIX returns ''.
    if (effShell !== 'posix' && tier !== 'minimal') {
      const guide = shellGuidanceBlock(effShell, tier === 'light' ? 'short' : 'full');
      if (guide) lines.push('', guide);
    }

    if (this.skillCache) {
      lines.push(
        '',
        '## Skills in scope for this session',
        this.skillCache,
        '',
        this.opts.skillMode === 'progressive'
          ? 'Skill names and triggers are injected below; load full instructions deterministically with the `skill` tool before relying on one.'
          : this.isCompact
            ? 'Compact skill instructions are injected in the Active Skills block below (Overview + Rules only).'
            : 'Skill bodies are injected below up to the eager budget; overflow remains listed by name and trigger for deterministic loading with the `skill` tool.',
      );
    }
    const text = lines.join('\n');
    this.envCacheByRoot.set(cacheKey, text);
    return text;
  }

  private modelCapabilities(): ModelCapabilities | undefined {
    const caps = this.opts.modelCapabilities;
    return typeof caps === 'function' ? caps() : caps;
  }

  private async buildMemoryAndSkills(): Promise<string> {
    const parts: string[] = [];
    // Memory injection count per tier: off=5, minimal=3, light=5, medium=5, aggressive=5
    const memoryCount = this.tier === 'minimal' || this.tier === 'light' ? 3 : 5;
    const compactMemory = this.tier === 'minimal'; // compact = text only, no badges/tags
    // When a per-turn memory retriever owns injection (SAGE turn
    // middleware), skip the static prompt section so memory flows through a
    // single channel — no double injection.
    if (this.opts.memoryStore && this.opts.injectMemory !== false) {
      try {
        // Use relevance scoring when available, fall back to full dump.
        if (this.opts.memoryStore.scoreRelevant) {
          const toolNames = this._lastBuildTools?.map((t) => t.name) ?? [];
          const scored = await this.opts.memoryStore.scoreRelevant(
            {
              currentTask: '',
              toolNames,
            },
            'project-memory',
            memoryCount,
          );
          if (scored.length > 0) {
            const lines: string[] = ['# Relevant Memory'];
            for (const e of scored) {
              if (compactMemory) {
                lines.push(`- ${e.text}`);
              } else {
                const badge = e.type ? `[\`${e.type.replace('_', '-')}\`] ` : '';
                const priorityMark =
                  e.priority === 'critical' ? '⚡' : e.priority === 'high' ? '▲' : '';
                lines.push(
                  `- ${priorityMark}${badge}${e.text}${e.tags ? ` \`#${e.tags.join(' #')}\`` : ''}`,
                );
              }
            }
            parts.push(lines.join('\n'));
          }
        } else {
          const mem = await this.opts.memoryStore.readAll();
          if (mem.trim()) parts.push(`# Project Memory\n\n${mem}`);
        }
      } catch {
        // skip
      }
    }
    // Skill bodies — re-read on every build so newly created/edited skills
    // are picked up. The SkillLoader caches disk I/O internally (list/body
    // caches), so re-calling its methods here is cheap: the loader returns
    // cached data unless invalidateCache() was called, which happens when
    // skills are created, edited, installed, or removed.
    // Skills are listed by name+trigger in buildEnvironment (envCache);
    // here we inject the full body content so the model has the actual
    // domain instructions, not just a trigger hint.
    // In token-saving mode, skill bodies are compacted to save tokens:
    // only the Overview and Rules sections (~400 chars max per skill).
    if (this.opts.skillLoader) {
      if (this.opts.skillMode === 'progressive') {
        this.skillBodyCache = await buildProgressiveSkillManifestText(this.opts.skillLoader);
      } else if (this.isCompact) {
        this.skillBodyCache = await buildCompactSkillBodiesText(this.opts.skillLoader);
      } else {
        this.skillBodyCache = await buildFullSkillBodiesText(
          this.opts.skillLoader,
          this.opts.skillEagerMaxChars,
        );
      }
    }
    if (this.skillBodyCache) {
      parts.push(`# Active Skills\n\n${this.skillBodyCache}`);
    }
    return parts.join('\n\n');
  }

  private async buildMode(): Promise<string> {
    // Use pre-resolved modePrompt if available (avoids redundant async call).
    if (this.opts.modePrompt) return this.opts.modePrompt;
    if (!this.opts.modeStore) return '';
    const mode = await this.opts.modeStore.getActiveMode();
    if (!mode?.prompt) return '';
    return mode.prompt;
  }

}
