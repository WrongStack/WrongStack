/**
 * State, trust-file persistence and call classification of the default
 * permission policy. {@link DefaultPermissionPolicy} (permission-policy.ts)
 * adds the decision procedure (`evaluate`) and its explain / list views.
 */

import * as fs from 'node:fs/promises';
import type { AgentContext } from '@wrongstack/contracts/types/context';
import type { InputReader } from '@wrongstack/contracts/types/input-reader';
import type {
  PermissionDecision,
  PermissionPolicy,
  TrustPolicy,
} from '@wrongstack/contracts/types/permission';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import { matchGlob } from '../utils/glob-match.js';
import { LruCache } from '../utils/lru-cache.js';
import { safeParse } from '../utils/safe-json.js';
import { hasCapability, ToolCapabilities } from './capabilities.js';
import {
  classifyShellSurfaceInput,
  gitToolCommandLine,
  isSensitiveReadCall,
  writesAgentState,
} from './permission-helpers.js';
import { type TrustPolicyDiagnostic, validateTrustPolicy } from './permission-policy-schema.js';
import { isYoloLockedOff } from './process-lockdown.js';
import {
  ALL_DESTRUCTIVE_KINDS,
  attachesWellKnownCredential,
  type DestructiveKind,
  LOCKED_DESTRUCTIVE_KINDS,
  normalizeYoloConfirmKinds,
  sameKindSet,
} from './yolo-risk.js';

export interface PermissionPolicyOptions {
  trustFile: string;
  yolo?: boolean | undefined;
  /** YOLO+ — see {@link PermissionPolicy.setYoloPlus}. */
  yoloPlus?: boolean | undefined;
  yoloDestructive?: boolean | undefined;
  /**
   * Destructive kinds that still require approval while YOLO is on. Defaults to
   * every kind. The two in `LOCKED_DESTRUCTIVE_KINDS` are always re-added, so a
   * caller cannot un-gate the writes that switch approval itself off.
   */
  yoloConfirmKinds?: Iterable<DestructiveKind> | undefined;
  /**
   * `--allowed-tools`: tools pre-approved for this process, as if the user had
   * answered "always allow this tool" — held in memory, never written to the
   * trust file. It rides the same `tool` approval scope, so deny rules still
   * win, destructive calls still confirm and sensitive reads still prompt.
   * A trailing `*` matches a prefix (`mcp__github__*`).
   */
  launchAllowedTools?: readonly string[] | undefined;
  promptDelegate?: (
    tool: Tool,
    input: unknown,
    suggestedPattern: string,
  ) => Promise<
    'yes' | 'no' | 'always' | 'always-exact' | 'always-command' | 'always-tool' | 'deny'
  >;
  inputReader?: InputReader | undefined;
}

/** Tools whose calls the destructive-command classifier can judge. */
export function isShellSurface(tool: Tool): boolean {
  return (
    tool.name === 'bash' ||
    tool.name === 'exec' ||
    (tool.capabilities ?? []).includes('shell.arbitrary')
  );
}

export abstract class PermissionPolicyState {
  protected policy: TrustPolicy = {};
  protected loaded = false;
  protected policyChanges: Promise<void> = Promise.resolve();
  protected readonly trustFile: string;
  protected yolo: boolean;
  protected yoloPlus: boolean;
  protected sessionDenied = new Map<string, boolean>();
  protected sessionAllowed = new Map<string, boolean>();
  protected promptDelegate?: PermissionPolicyOptions['promptDelegate'] | undefined;
  protected wildcardEntries: { pattern: string; value: TrustPolicy[string] }[] = [];
  protected _evalCache = new LruCache<string, PermissionDecision>(500);
  protected policyDiagnostics: TrustPolicyDiagnostic[] = [];
  protected policyInvalid = false;
  protected yoloConfirmKinds: ReadonlySet<DestructiveKind>;
  protected readonly launchAllowedTools: readonly string[];

  constructor(opts: PermissionPolicyOptions) {
    this.trustFile = opts.trustFile;
    this.launchAllowedTools = [...(opts.launchAllowedTools ?? [])];
    this.yolo = opts.yolo ?? false;
    this.yoloPlus = opts.yoloPlus ?? false;
    this.yoloConfirmKinds = normalizeYoloConfirmKinds(
      opts.yoloConfirmKinds ?? (opts.yoloDestructive === true ? [] : undefined),
    );
    this.promptDelegate = opts.promptDelegate;
  }

  protected isLaunchAllowed(name: string): boolean {
    return this.launchAllowedTools.some((pattern) =>
      pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : pattern === name,
    );
  }

  setYoloConfirmKinds(kinds: Iterable<DestructiveKind> | undefined): void {
    const next = normalizeYoloConfirmKinds(kinds);
    if (!sameKindSet(this.yoloConfirmKinds, next)) this._evalCache.clear();
    this.yoloConfirmKinds = next;
  }

  getYoloConfirmKinds(): ReadonlySet<DestructiveKind> {
    return this.yoloConfirmKinds;
  }

  /**
   * Legacy all-or-nothing view. `true` means "nothing but the locked kinds is
   * gated" — kept because the CLI flag and the config key both still speak it.
   */
  setYoloDestructive(enabled: boolean): void {
    this.setYoloConfirmKinds(enabled ? [] : ALL_DESTRUCTIVE_KINDS);
  }

  getYoloDestructive(): boolean {
    return [...this.yoloConfirmKinds].every((kind) => LOCKED_DESTRUCTIVE_KINDS.has(kind));
  }

  protected hasAgentStateWriteTarget(tool: Tool, input: unknown, ctx: AgentContext): boolean {
    // B1 (AC-008 / RCE-007): the original `FS_WRITE` gate let
    // `CONFIG_MUTATE` tools — chiefly `mcp_control({action:'enable'})` —
    // escape the carve-out and run an unprompted
    // `npx -y <preset>` + persisted `mcpServers.<name>.enabled = true`
    // in the fully-trusted profile. `CONFIG_MUTATE` writes config keys
    // the in-project config strip-list explicitly forbids, so a
    // successful enable is just as state-rooting as a `fs.write` of
    // `trust.json` — and must be checked the same way. `riskTier` is
    // also widened so a future tool declaring a destructive tier
    // (without the legacy capability constants) still classifies
    // correctly.
    const isFsWrite = hasCapability(tool, ToolCapabilities.FS_WRITE);
    const isConfigMutate = hasCapability(tool, ToolCapabilities.CONFIG_MUTATE);
    const isDestructiveTier = tool.riskTier === 'destructive';
    if (!isFsWrite && !isConfigMutate && !isDestructiveTier) return false;
    return writesAgentState(tool, input, ctx.workingDir ?? ctx.cwd);
  }

  /**
   * Does a broad approval ("this command", "this tool", `--allowed-tools`)
   * stop short of this call?
   *
   * A shell is judged per command: its `destructive` tier only says a shell
   * CAN do damage, and the command classifier below says whether THIS call
   * does. Judging by the tier made "[t] tool, any input" unusable for bash and
   * pwsh: the approval was stored and then refused for `echo hi`, while the
   * prompt promised that only destructive calls still ask. Tools with no
   * per-call classifier keep their tier.
   */
  protected broadApprovalStopsShort(tool: Tool, input: unknown, ctx: AgentContext): boolean {
    if (this.destructiveKindOf(tool, input, ctx) !== undefined) return true;
    return tool.riskTier === 'destructive' && !isShellSurface(tool);
  }

  /**
   * The destructive kind this call would perform, or `undefined` when it is
   * not destructive. Independent of whether the user has that kind gated —
   * `yoloBlockedAsDestructive` applies the preference, this only classifies.
   */
  protected destructiveKindOf(
    tool: Tool,
    input: unknown,
    ctx: AgentContext,
  ): DestructiveKind | undefined {
    if (this.hasAgentStateWriteTarget(tool, input, ctx)) return 'agent-state';

    // Binding a well-known third-party credential to a provider endpoint is an
    // exfiltration primitive, not a shell command — so the shell-surface check
    // below never saw it and YOLO auto-approved it. The `baseUrl` has no host
    // allowlist, and prompt injection can reach the tool.
    if (attachesWellKnownCredential(input)) return 'credential-bind';

    // The structured git tool performs the same git-history damage as shell
    // text (force push, `checkout -- .`) but is not a shell surface.
    if (tool.name === 'git') {
      const line = gitToolCommandLine(input);
      return line === undefined
        ? undefined
        : classifyShellSurfaceInput({ command: line }, ctx.projectRoot);
    }

    if (!isShellSurface(tool)) return undefined;
    // H-1 (security report VF-03): `getInputString(input, 'command') ?? …`
    // short-circuited on the bare program name, so the classifier never saw the
    // args — `{command:'rm', args:['-rf','/']}` classified as "rm".
    // `shellCommandLineFromInput` already joins command/cmd/script with args; it
    // is the whole reason this branch exists. Structured `{ program, args }`
    // commands (workflow plugins) are read too — WS-2026-09-26-03.
    return classifyShellSurfaceInput(input, ctx.projectRoot);
  }

  /** The kind holding this call back, or `undefined` when nothing gates it. */
  protected gatedDestructiveKind(
    tool: Tool,
    input: unknown,
    ctx: AgentContext,
  ): DestructiveKind | undefined {
    if (!this.effectiveYolo(ctx)) return undefined;
    const kind = this.destructiveKindOf(tool, input, ctx);
    return kind !== undefined && this.yoloConfirmKinds.has(kind) ? kind : undefined;
  }

  protected yoloBlockedAsDestructive(tool: Tool, input: unknown, ctx: AgentContext): boolean {
    return this.gatedDestructiveKind(tool, input, ctx) !== undefined;
  }

  setPromptDelegate(delegate: PermissionPolicyOptions['promptDelegate']): void {
    this.promptDelegate = delegate;
  }

  /**
   * YOLO as it applies to ONE conversation.
   *
   * `this.yolo` is a process-wide switch, which is right for a CLI or a TUI —
   * one process, one conversation. A WebUI holds four at once, and YOLO is a
   * per-tab preference stored on each session's own context meta, so reading
   * the process switch meant turning YOLO on in one tab auto-approved the
   * tools of the other three. The instance flag stays as the fallback for
   * hosts (and tests) that never write the meta key.
   */
  protected effectiveYolo(ctx?: Pick<AgentContext, 'meta'> | undefined): boolean {
    // `--restricted`: no path — config, /yolo, a scoped tab — turns YOLO on.
    if (isYoloLockedOff()) return false;
    const scoped = ctx?.meta?.['yolo'];
    return typeof scoped === 'boolean' ? scoped : this.yolo;
  }

  setYolo(enabled: boolean): void {
    if (this.yolo !== enabled) this._evalCache.clear();
    this.yolo = enabled;
  }

  /**
   * YOLO+ for ONE conversation — the per-tab `ctx.meta.yoloPlus` first, like
   * {@link effectiveYolo}, then the process switch. `--restricted` locks it off
   * the same way it locks YOLO off.
   */
  protected effectiveYoloPlus(ctx?: Pick<AgentContext, 'meta'> | undefined): boolean {
    // YOLO+ never outlives YOLO: "YOLO off" must always mean every call asks,
    // whatever a stale YOLO+ flag in this tab's meta still says.
    if (!this.effectiveYolo(ctx)) return false;
    const scoped = ctx?.meta?.['yoloPlus'];
    return typeof scoped === 'boolean' ? scoped : this.yoloPlus;
  }

  setYoloPlus(enabled: boolean): void {
    if (this.yoloPlus !== enabled) this._evalCache.clear();
    this.yoloPlus = enabled;
    // YOLO+ is YOLO with nothing held back; turning it on turns YOLO on.
    if (enabled) this.setYolo(true);
  }

  getYoloPlus(): boolean {
    return this.yoloPlus && this.getYolo();
  }

  yoloModeFor(ctx?: Pick<AgentContext, 'meta'> | undefined): { yolo: boolean; yoloPlus: boolean } {
    return { yolo: this.effectiveYolo(ctx), yoloPlus: this.effectiveYoloPlus(ctx) };
  }

  getYolo(): boolean {
    return this.yolo && !isYoloLockedOff();
  }

  getPolicyDiagnostics(): readonly TrustPolicyDiagnostic[] {
    return this.policyDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  protected serializePolicyChange(change: () => Promise<void>): Promise<void> {
    const pending = this.policyChanges.then(change);
    // A failed disk write must not poison later policy edits.
    this.policyChanges = pending.catch(() => undefined);
    return pending;
  }

  reload(): Promise<void> {
    return this.serializePolicyChange(() => this.loadPolicy());
  }

  protected refreshPolicyIndex(): void {
    this.wildcardEntries = Object.entries(this.policy)
      .filter(([key]) => key.includes('*'))
      .map(([pattern, value]) => ({ pattern, value }));
    this._evalCache.clear();
  }

  protected async loadPolicy(): Promise<void> {
    await this.readPolicyFile();
    this.sessionDenied.clear();
    this.sessionAllowed.clear();
    this._evalCache.clear();
    this.loaded = true;
  }

  /** Replace the persisted rules with what trust.json holds right now. */
  protected async readPolicyFile(): Promise<void> {
    this.policyDiagnostics = [];
    this.policyInvalid = false;
    try {
      const raw = await fs.readFile(this.trustFile, 'utf8');
      // A hand-edited trust.json may carry a UTF-8 BOM; it is valid JSON.
      const parsed = safeParse<unknown>(raw.replace(/^﻿/, ''));
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
    this.refreshPolicyIndex();
  }

  protected _logDeny(tool: string, subject: string | undefined, reason: string): void {
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

  // Delegates to the shared helper so the subagent policy applies the exact
  // same rule — see `isSensitiveReadCall` in ./permission-helpers.ts.
  protected isSensitiveReadCall(tool: Tool, input: unknown): boolean {
    return isSensitiveReadCall(tool, input);
  }

  trust(rule: { tool: string; pattern: string; ttlMs?: number }): Promise<void> {
    return this.persistRule('allow', rule);
  }

  deny(rule: { tool: string; pattern: string }): Promise<void> {
    return this.persistRule('deny', rule);
  }

  protected persistRule(
    kind: 'allow' | 'deny',
    rule: { tool: string; pattern: string; ttlMs?: number },
  ): Promise<void> {
    return this.serializePolicyChange(async () => {
      if (!this.loaded) await this.loadPolicy();
      // trust.json is shared by every session of the project: build the new
      // file from what is on disk now, under the file lock, not from the
      // snapshot this instance loaded at boot — that erased rules (a deny
      // included) another session had persisted since.
      await withFileLock(this.trustFile, async () => {
        await this.readPolicyFile();
        if (this.policyInvalid) {
          throw new Error(
            `Cannot update ${kind === 'allow' ? 'trust' : 'deny'} rules while trust.json is invalid; repair it first.`,
          );
        }
        const previous = this.policy[rule.tool] ?? {};
        const entry = {
          ...previous,
          [kind]: [...new Set([...(previous[kind] ?? []), rule.pattern])],
        };
        if (kind === 'allow' && rule.ttlMs !== undefined)
          entry.allowUntil = Date.now() + rule.ttlMs;
        const next = { ...this.policy, [rule.tool]: entry };
        // Publish only after persistence succeeds. Failed/redundant writes leave
        // the old deny, expiry, wildcard index, and cached decisions intact.
        await atomicWrite(this.trustFile, JSON.stringify(next, null, 2));
        this.policy = next;
        this.refreshPolicyIndex();
      });
    });
  }

  denyOnce(rule: { tool: string; pattern: string }): void {
    this.sessionDenied.set(`${rule.tool}::${rule.pattern}`, true);
    this._evalCache.clear();
  }

  allowOnce(rule: { tool: string; pattern: string }): void {
    this.sessionAllowed.set(`${rule.tool}::${rule.pattern}`, true);
    this._evalCache.clear();
  }

  protected findNamespaceEntry(toolName: string): TrustPolicy[string] | undefined {
    for (const { pattern, value } of this.wildcardEntries) {
      if (matchGlob(pattern, toolName)) return value;
    }
    return undefined;
  }
}
