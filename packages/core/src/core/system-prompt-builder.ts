import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildChildEnv } from '../utils/child-env.js';
import { PROMPT as DEFAULT_PROMPT, LEADER_AFTER_TASK_PROMPT } from './modes/default.js';
import {
  loadInstructionBundle,
  mergeInstructionBundle,
  type InstructionBundle,
  type InstructionBundlePaths,
} from './instruction-bundle.js';
import type { TextBlock } from '../types/blocks.js';
import type { MemoryStore } from '../types/memory.js';
import type { ModeStore } from '../types/mode.js';
import type { SkillLoader } from '../types/skill.js';
import type { SystemPromptContributor } from '../types/system-prompt-contributor.js';
import type {
  BuildContext,
  ModelCapabilities,
  SystemPromptBuilder,
} from '../types/system-prompt.js';
import type { MailboxAgentStatus } from '../coordination/mailbox-types.js';
import type { TokenSavingTier } from '../types/config.js';
import { normalizeTokenSavingTier } from '../types/config.js';
import type { Tool } from '../types/tool.js';

export const LAYER_1_IDENTITY = DEFAULT_PROMPT;

function shortSessionId(sessionId: string): string {
  const leaf = sessionId.split('/').pop() ?? sessionId;
  return leaf.length > 12 ? `${leaf.slice(0, 12)}…` : leaf;
}

/** Canonical shell the `bash` tool targets — drives the Environment Shell line
 *  and the syntax-guidance sub-block. */
export type EffectiveShell = 'pwsh' | 'powershell' | 'cmd' | 'posix';

/**
 * Derive the shell the `bash` tool will use from `os.platform()` + the pinned
 * `WRONGSTACK_SHELL` value (set at boot by `ensureSessionShell` in
 * @wrongstack/tools). On POSIX this is always `'posix'` and the caller shows the
 * raw `$SHELL`. On Windows with no pinned value (boot didn't run — tests /
 * embeddings) we report `'cmd'`, matching `bash.ts`'s default for
 * non-PowerShell-looking commands.
 */
export function effectiveShell(
  platform: NodeJS.Platform,
  wrongstackShell: string | undefined,
): EffectiveShell {
  if (platform !== 'win32') return 'posix';
  const v = wrongstackShell?.trim().toLowerCase();
  if (v === 'powershell' || v === 'powershell.exe') return 'powershell';
  if (v === 'pwsh' || v === 'pwsh.exe') return 'pwsh';
  if (v === 'cmd' || v === 'cmd.exe') return 'cmd';
  return 'cmd';
}

const SHELL_DISPLAY: Record<Exclude<EffectiveShell, 'posix'>, string> = {
  pwsh: 'pwsh (PowerShell 7+) — write PowerShell syntax, not bash',
  powershell: 'powershell (Windows PowerShell 5.1) — write PowerShell syntax, not bash',
  cmd: 'cmd.exe (Command Prompt) — write cmd syntax, not bash',
};

/**
 * Shell-specific syntax guidance for the Environment block. Returns `''` for
 * POSIX (the model writes bash natively, so no nudge is needed). `detail:
 * 'short'` is the light-tier one-liner; `'full'` is the complete cheat-sheet.
 * The `&&`/`||` note branches on the PowerShell edition (only pwsh 7 supports
 * them).
 */
export function shellGuidanceBlock(shell: EffectiveShell, detail: 'full' | 'short'): string {
  if (shell === 'posix') return '';
  if (shell === 'cmd') {
    if (detail === 'short') {
      return '- Shell syntax: cmd.exe — use `%VAR%`, `2>nul`, `dir`/`type`/`del`/`where` (NOT bash `$VAR`, `/dev/null`, `ls`/`cat`/`rm`).';
    }
    return [
      '## Shell — cmd.exe',
      'The `bash` tool runs **cmd.exe** on this machine. Write cmd syntax, not bash/POSIX:',
      '- Env vars: `%NAME%` (NOT `$NAME`); set with `set NAME=value`.',
      '- Discard output: `2>nul` / `>nul` (NOT `2>/dev/null`).',
      '- No `ls`/`cat`/`rm`/`which`/`head` — use `dir`/`type`/`del`/`where` and `more`.',
      '- Chain with `&&` / `||` / `&`. Prefer the dedicated read/grep/glob tools over shell file ops.',
    ].join('\n');
  }
  // pwsh or powershell
  if (detail === 'short') {
    return '- Shell syntax: PowerShell — use `$env:VAR`, `2>$null`, `Get-Content`/`Select-Object` (NOT bash `$VAR`, `/dev/null`, `cat`/`head`).';
  }
  const chain =
    shell === 'pwsh'
      ? '- Chain with `&&` / `||` (supported in PowerShell 7).'
      : '- `&&` / `||` are NOT available in Windows PowerShell 5.1 — separate commands with `;` (and check `$LASTEXITCODE`).';
  return [
    `## Shell — PowerShell${shell === 'pwsh' ? ' 7+ (pwsh)' : ' 5.1 (powershell)'}`,
    'The `bash` tool runs **PowerShell** on this machine. Write PowerShell syntax, not bash/POSIX:',
    "- Env vars: read `$env:NAME`, set `$env:NAME = 'value'` (NOT `$NAME`, `%NAME%`, or `export`).",
    '- Discard output: `... 2>$null` or `$null = ...` (NOT `2>/dev/null`).',
    '- No bash builtins — use cmdlets: `head -n N`→`Select-Object -First N`, `tail`→`-Last N`, `cat`→`Get-Content`, `which x`→`Get-Command x`, `rm -rf p`→`Remove-Item -Recurse -Force p`, `touch f`→`New-Item -ItemType File f`. Prefer the grep/glob tools over `Select-String`.',
    '- Read a line window of a file: `Get-Content path | Select-Object -Skip N -First M` (the `sed -n` / `head|tail` equivalent).',
    '- Pipes work normally; `rg`/`git`/`node` and other native exes run as-is — only the *shell builtins* differ. (`rg --files src | rg pattern` is fine.)',
    '- Call exes whose path has spaces via the call operator: `& "C:\\Program Files\\app.exe" args`.',
    "- Multi-line literals: single-quoted here-string `@'…'@` with the closing `'@` at column 0.",
    '- Non-interactive only: no `Read-Host`/`Get-Credential`/`pause`; add `-Confirm:$false` to destructive cmdlets.',
    chain,
  ].join('\n');
}

export interface DefaultSystemPromptBuilderOptions {
  memoryStore?: MemoryStore | undefined;
  skillLoader?: SkillLoader | undefined;
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
  private _toolsUsageCache?: { toolsRef: readonly Tool[]; agentsHash: string; tier: string; text: string } | undefined;
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

  /** Exposes the normalized `TokenSavingTier` for tier-aware guidance decisions. */
  private get tier(): TokenSavingTier {
    // Delegate to the canonical normalizer so invalid strings
    // (e.g. "MINIMAL" from a user typo in .wrongstack/config.json)
    // are coerced to 'off' instead of flowing through verbatim.
    // See packages/core/src/types/config.ts:112-125.
    return normalizeTokenSavingTier(this.opts.tokenSavingMode);
  }

  /**
   * Returns the max tool description length for the current tier.
   * Per the design doc: off=80, minimal=40, light=50, medium=60, aggressive=70.
   */
  private toolDescLimit(): number {
    switch (this.tier) {
      case 'minimal':    return 40;
      case 'light':      return 50;
      case 'medium':     return 60;
      case 'aggressive': return 70;
      default:            return 80;
    }
  }

  async build(ctx: BuildContext): Promise<TextBlock[]> {
    this._lastBuildTools = ctx.tools;
    // Pre-load skill entries so we can include them in the environment block
    // (which is cached). Skills are static per-session, so this is safe.
    if (this.opts.skillLoader && !this.skillCache) {
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
        }
      } catch {
        // skip
      }
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

    const blocks: TextBlock[] = [
      { type: 'text', text: layer1 },
      { type: 'text', text: layer2 },
      { type: 'text', text: layer3WithDir },
    ];

    if (layer4.trim()) {
      blocks.push({
        type: 'text',
        text: layer4,
        cache_control: { type: 'ephemeral' },
      });
    }

    if (layer5.trim()) {
      blocks.push({
        type: 'text',
        text: layer5,
        cache_control: { type: 'ephemeral' },
      });
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
            blocks.push({
              type: 'text',
              text: `Mode "${activeMode.id}" works best with these skills: ${available.join(', ')}. Their full instructions are in the Active Skills block above.`,
              cache_control: { type: 'ephemeral' },
            });
          }
        }
      } catch {
        // skip — non-critical hint
      }
    }

    if (layer6.trim()) {
      blocks.push({
        type: 'text',
        text: layer6,
        cache_control: { type: 'ephemeral' },
      });
    }

    // System prompt contributors — plugins inject ephemeral context here.
    if (this.opts.contributors && this.opts.contributors.length > 0) {
      for (const c of this.opts.contributors) {
        try {
          const contributed = await c(ctx);
          blocks.push(...contributed);
        } catch {
          // Contributor errors are swallowed — a bad plugin shouldn't
          // break the system prompt assembly.
        }
      }
    }

    // Leader-only after-task affordances (the `<next_steps>` block + post-task
    // mailbox update). Host-only and appended last: subagents are headless
    // workers whose output is parsed (SDD spec/plan/task JSON) or rolled up by
    // the parent, so a `<next_steps>` tag there is just noise that leaks into
    // specs/plans. Lives outside layer1 so the host keeps it in EVERY mode while
    // no subagent ever receives it.
    if (!ctx.subagent) {
      blocks.push({
        type: 'text',
        text: instructions.system?.leaderAfterTask ?? LEADER_AFTER_TASK_PROMPT,
      });
    }

    return blocks;
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
  private _planCache?: { path: string; mtimeMs: number; text: string } | undefined;

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
    if (!planPath) return '';

    let raw: string;
    try {
      // Check mtime before reading — plans change at human pace (a few times
      // per session), not on every iteration. Stat is O(1) metadata; readFile
      // + JSON.parse is O(n) for the file content.
      const stat = await fs.stat(planPath);
      if (
        this._planCache &&
        this._planCache.path === planPath &&
        this._planCache.mtimeMs === stat.mtimeMs
      ) {
        return this._planCache.text;
      }
      raw = await fs.readFile(planPath, 'utf8');
      const text = this._formatPlan(raw);
      this._planCache = { path: planPath, mtimeMs: stat.mtimeMs, text };
      return text;
    } catch {
      // File missing, unreadable, or corrupt — clear cache and return empty.
      this._planCache = undefined;
      return '';
    }
  }

  private _formatPlan(raw: string): string {
    let parsed: { items?: Array<{ status?: string | undefined; title?: string | undefined }>; title?: string | undefined };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return '';
    }
    if (!Array.isArray(parsed.items) || parsed.items.length === 0) return '';
    const open = parsed.items.filter((i) => i?.status !== 'done');
    if (open.length === 0) return '';
    const lines = ['## Active plan'];
    if (parsed.title) lines.push(`*${parsed.title}*`, '');
    parsed.items.forEach((it, idx) => {
      const mark = it?.status === 'done' ? '[x]' : it?.status === 'in_progress' ? '[~]' : '[ ]';
      lines.push(`${idx + 1}. ${mark} ${it?.title ?? '(untitled)'}`);
    });
    lines.push(
      '',
      'Use `/plan` (user) or the `plan` tool to update status as you progress. The roadmap survives session resume.',
    );
    return lines.join('\n');
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
      }
    }

    // Uncategorized tools
    if (uncategorized.length > 0) {
      if (byCat.size > 0) lines.push('');
      for (const t of uncategorized) {
        const hint = t.usageHint ?? t.description;
        lines.push(`\n### ${t.name}\n${hint.trim()}`);
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
    // - 'light' / 'medium' / 'aggressive' → minimal one-liner
    // - 'minimal' → skipped
    //
    // Note: 'aggressive' was previously listed with 'off' for the
    // full block, but per the parallel-session decision (Option H,
    // `leader@1b68eb14`): at aggressive, the 400-token mailbox essay
    // is the largest single guidance section and users under context
    // pressure don't need it. The compact one-liner is enough.
    const hasMailbox = tools.some(
      (t) => t.name === 'mailbox' || t.name === 'mail_send' || t.name === 'mail_inbox',
    );
    if (hasMailbox && this.tier !== 'minimal') {
      // Build online agents info — cached by array reference since the
      // agents list changes at join/leave pace (seconds to minutes) while
      // the prompt builds happen every iteration (hundreds of ms).
      const onlineAgentsInfo = this.renderOnlineAgents(ctx.onlineAgents);
      if (this.tier === 'light' || this.tier === 'medium' || this.tier === 'aggressive') {
        // Minimal: keep just the header and agent count.
        // `aggressive` joins `light`/`medium` — the 400-token mailbox essay
        // is the largest single guidance section; users under context pressure
        // don't need it.
        const mailbox = this.instructionSection(instructions, 'tool.mailbox.compact', {
          onlineAgentsInfo,
        });
        if (mailbox) lines.push(mailbox);
      } else {
        const mailbox = this.instructionSection(instructions, 'tool.mailbox.full', {
          onlineAgentsInfo,
        });
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
        // Small context (<=32k) → trigger earlier; large context (>=128k) → more relaxed.
        const maxCtx = this.modelCapabilities()?.maxContextTokens ?? 128000;
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

  /**
   * Cheap content fingerprint of the online agents array. The mailbox
   * rebuilds the array as a fresh object on every status check, so caching
   * by reference always misses — this lets the renderOnlineAgents and
   * buildToolUsage caches detect membership changes instead.
   *
   * O(n) over agent names with no per-element string concatenation. Uses
   * FNV-1a over character codes so two different agent sets collide only
   * if they produce the identical sequence of name characters — astronomically
   * unlikely. A collision would produce a stale agent list in the prompt,
   * a cosmetic issue, not a correctness bug.
   */
  private agentsFingerprint(agents: readonly MailboxAgentStatus[] | undefined): string {
    if (!agents || agents.length === 0) return '0';
    let h = 0x811c9dc5;
    for (const a of agents) {
      for (let i = 0; i < a.name.length; i++) {
        h ^= a.name.charCodeAt(i);
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
  private renderOnlineAgents(
    agents: readonly MailboxAgentStatus[] | undefined,
  ): string {
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

    const agentList = agents
      .map(
        (a) =>
          `- **${a.name}** (${a.source ?? 'unknown'}${a.sessionId ? `, session: ${shortSessionId(a.sessionId)}` : ''})`,
      )
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
    const isGit = await this.dirExists(path.join(ctx.projectRoot, '.git'));
    // Fan out the per-root probes so the prompt build doesn't serialize
    // ~12 fs.access calls plus the git status spawn back-to-back. On a
    // cold cache (CI / first turn) this trims hundreds of ms.
    const [git, langs] = await Promise.all([
      isGit ? this.gitStatus(ctx.projectRoot) : Promise.resolve('not a git repo'),
      this.detectLanguages(ctx.projectRoot),
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
        this.isCompact
          ? 'Compact skill instructions are injected in the Active Skills block below (Overview + Rules only).'
          : 'Full skill instructions are injected in the Active Skills block below.',
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
    // Memory injection count per tier: off=8, minimal=3, light=5, medium=8, aggressive=8
    const memoryCount = this.tier === 'minimal' ? 3 : this.tier === 'light' ? 5 : 8;
    const compactMemory = this.tier === 'minimal'; // compact = text only, no badges/tags
    if (this.opts.memoryStore) {
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
                const priorityMark = e.priority === 'critical' ? '⚡' : e.priority === 'high' ? '▲' : '';
                lines.push(`- ${priorityMark}${badge}${e.text}${e.tags ? ` \`#${e.tags.join(' #')}\`` : ''}`);
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
    // Skill bodies — load once and cache for the session lifetime.
    // Skills are listed by name+trigger in buildEnvironment (envCache);
    // here we inject the full body content so the model has the actual
    // domain instructions, not just a trigger hint.
    // In token-saving mode, skill bodies are compacted to save tokens:
    // only the Overview and Rules sections (~400 chars max per skill).
    if (this.opts.skillLoader) {
      if (this.isCompact) {
        // Compact mode — build once, cache
        if (this.skillBodyCache === undefined) {
          await this.buildCompactSkillBodies();
        }
      } else {
        // Full mode — build once, cache
        if (this.skillBodyCache === undefined) {
          await this.buildFullSkillBodies();
        }
      }
    }
    if (this.skillBodyCache) {
      parts.push(`# Active Skills\n\n${this.skillBodyCache}`);
    }
    return parts.join('\n\n');
  }

  /** Build full skill bodies (token-saving OFF). */
  private async buildFullSkillBodies(): Promise<void> {
    try {
      const skills = await this.opts.skillLoader!.list();
      if (skills.length > 0) {
        const bodies: string[] = [];
        for (const s of skills) {
          try {
            const raw = await this.opts.skillLoader!.readBody(s.name);
            const body = stripFrontmatter(raw);
            const trimmed = body.trim();
            if (trimmed) {
              // I5 audit (Sprint 3): cap each skill body at
              // MAX_SKILL_BODY_CHARS so a misconfigured multi-MB
              // skill file can't bloat the prompt. Real-world
              // SKILL.md files are <5 KB; 16 KB is generous.
              bodies.push(
                `## Skill: ${s.name}\n\n${capSkillBody(trimmed)}`,
              );
            }
          } catch {
            // skip unreadable skill
          }
        }
        this.skillBodyCache = bodies.length > 0 ? bodies.join('\n\n---\n\n') : '';
      } else {
        this.skillBodyCache = '';
      }
    } catch {
      this.skillBodyCache = '';
    }
  }

  /**
   * Build compact skill bodies for token-saving mode.
   * Uses `readSaveBody` from the skill loader which tries `SKILL.save.md`
   * first, then falls back to auto-compaction.
   */
  private async buildCompactSkillBodies(): Promise<void> {
    if (!this.opts.skillLoader) { this.skillBodyCache = ''; return; }
    try {
      const skills = await this.opts.skillLoader.list();
      if (skills.length > 0) {
        const bodies: string[] = [];
        for (const s of skills) {
          try {
            const saveBody = await this.opts.skillLoader.readSaveBody(s.name);
            const clean = stripFrontmatter(saveBody);
            if (clean.trim()) {
              bodies.push(`## Skill: ${s.name}\n\n${clean.trim()}`);
            }
          } catch {
            // skip unreadable skill
          }
        }
        this.skillBodyCache = bodies.length > 0 ? bodies.join('\n\n---\n\n') : '';
      } else {
        this.skillBodyCache = '';
      }
    } catch {
      this.skillBodyCache = '';
    }
  }

  private async buildMode(): Promise<string> {
    // Use pre-resolved modePrompt if available (avoids redundant async call).
    if (this.opts.modePrompt) return this.opts.modePrompt;
    if (!this.opts.modeStore) return '';
    const mode = await this.opts.modeStore.getActiveMode();
    if (!mode?.prompt) return '';
    return mode.prompt;
  }

  private async dirExists(p: string): Promise<boolean> {
    try {
      const stat = await fs.stat(p);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  private async gitStatus(root: string): Promise<string> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (s: string): void => {
        if (settled) return;
        settled = true;
        resolve(s);
      };
      let proc: ReturnType<typeof spawn> | undefined;
      // 2 s ceiling: a hung git status (corrupt index, .git/index.lock
      // held by another process, network FS hiccup) must not stall the
      // whole prompt build for a turn.
      const timer = setTimeout(() => {
        proc?.kill('SIGKILL');
        finish('git timeout');
      }, 2000);
      try {
        proc = spawn('git', ['status', '--porcelain=v1', '--branch'], {
          cwd: root,
          env: buildChildEnv(),
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        });
        let buf = '';
        proc.stdout?.on('data', (c) => {
          buf += c.toString();
        });
        proc.on('error', () => {
          clearTimeout(timer);
          finish('git error');
        });
        proc.on('close', () => {
          clearTimeout(timer);
          const lines = buf.split('\n').filter(Boolean);
          const branchLine = lines[0] ?? '';
          const branchMatch = branchLine.match(/## ([^\s.]+)/);
          const branch = branchMatch?.[1] ?? 'detached';
          const dirty = lines.slice(1);
          const staged = dirty.filter((l) => /^[MARCD]/.test(l)).length;
          const modified = dirty.length - staged;
          finish(`branch=${branch}, ${modified} modified, ${staged} staged`);
        });
      } catch {
        clearTimeout(timer);
        finish('git unavailable');
      }
    });
  }

  private async detectLanguages(root: string): Promise<string> {
    const checks: Array<[string, string]> = [
      ['package.json', 'JavaScript/TypeScript'],
      ['tsconfig.json', 'TypeScript'],
      ['go.mod', 'Go'],
      ['Cargo.toml', 'Rust'],
      ['pyproject.toml', 'Python'],
      ['requirements.txt', 'Python'],
      ['Gemfile', 'Ruby'],
      ['pom.xml', 'Java'],
      ['build.gradle', 'Java/Kotlin'],
      ['composer.json', 'PHP'],
      ['mix.exs', 'Elixir'],
    ];
    // Fan out the marker probes. Sequential await on 11 fs.access calls
    // adds latency on cold cache for no reason — each probe is independent.
    const hits = await Promise.all(
      checks.map(async ([marker, lang]) => {
        try {
          await fs.access(path.join(root, marker));
          return lang;
        } catch {
          return null;
        }
      }),
    );
    const langs = new Set(hits.filter((l): l is string => l !== null));
    return langs.size === 0 ? 'unknown' : Array.from(langs).join(', ');
  }
}

/** Strip YAML frontmatter from a SKILL.md file, returning only the body. */
function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return raw;
  // Skip past the closing `---` and the following newline
  let body = raw.slice(end + 4);
  if (body.startsWith('\n')) body = body.slice(1);
  return body;
}

/**
 * Maximum number of characters of a skill body to inject into the
 * prompt when building the full (token-saving OFF) Active Skills block.
 *
 * Real-world SKILL.md files are <5 KB; 16 KB is generous headroom.
 * Without a cap, a misconfigured multi-MB skill file can bloat the
 * prompt by tens of thousands of tokens. This cap matches the
 * bash `MAX_OUTPUT` (32 KB) at a smaller scale and keeps the full
 * path comparable in size to the compact path's natural output.
 *
 * I5 audit (Sprint 3). See
 * `packages/core/tests/core/system-prompt-builder-i-skills.test.ts`.
 */
const MAX_SKILL_BODY_CHARS = 16_000;

/**
 * Cap a skill body at MAX_SKILL_BODY_CHARS, truncating at a paragraph
 * boundary when possible to preserve readability. Appends an
 * ellipsis marker when truncated so the model can detect the cap.
 */
function capSkillBody(body: string): string {
  if (body.length <= MAX_SKILL_BODY_CHARS) return body;
  // Try to cut at the last paragraph break (`\n\n`) within the
  // budget so the truncated body ends cleanly. Fall back to a
  // hard cut if no paragraph break exists.
  const budget = MAX_SKILL_BODY_CHARS - 1; // reserve 1 char for ellipsis
  const cut = body.lastIndexOf('\n\n', budget);
  const truncated =
    cut > budget / 2
      ? body.slice(0, cut)
      : body.slice(0, budget);
  return truncated + '…';
}

/**
 * Compact a skill trigger description into a short label.
 * "Use this skill when scanning source code for bugs..."
 * → "scanning source code for bugs, anti-patterns, code smells"
 */
function compactTrigger(trigger: string): string {
  // Strip common prefixes
  let s = trigger
    .replace(/^Use this skill when /i, '')
    .replace(/^Use this skill for /i, '')
    .replace(/^Use when /i, '')
    .replace(/\.$/, '');
  // Truncate to ~72 chars at a word boundary
  if (s.length > 72) {
    const cut = s.lastIndexOf(' ', 68);
    s = cut > 50 ? s.slice(0, cut) + '…' : s.slice(0, 68) + '…';
  }
  return s;
}
