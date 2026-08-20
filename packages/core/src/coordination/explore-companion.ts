/**
 * ExploreCompanion — state-triggered background codebase explorer.
 *
 * Runs behind a leader agent executing the main task. It watches the live
 * EventBus for signals of the leader's IN-PROGRESS state and converts them
 * into narrow, read-only exploration probes assigned to a resident
 * `explore-companion` subagent (see docs/architecture/explore-companion-
 * subagent.md). The companion never blocks the leader: probes are
 * fire-and-forget (`onProbe` → spawn/assign), and findings travel back via
 * mailbox `result`/`btw` messages that the mailbox loop folds into the
 * leader's context before its next step.
 *
 * Watched signals (each independently toggleable):
 *   - edit on an unread file — the leader edits a path it never read;
 *   - zero-hit search — a search/grep returned no results;
 *   - unfamiliar read — the leader reads a path not yet probed;
 *   - todo flip — a leader todo transitions to in_progress
 *     (requires `leaderAgentId`);
 *   - error symbol — an `error` event names a file/symbol token;
 *   - mailbox ask — an `ask`/`assign` message from the leader addressed
 *     to the companion.
 *
 * Design lineage: BrainMonitor (watch bus → cooldown → engage, session
 * filter, single engagement in flight, host-intent start/stop/reconfigure)
 * generalized from "steer the leader" to "assign exploration probes".
 *
 * Non-interference guarantees (also pinned by tests):
 *   - never blocks the leader — onProbe is called without awaiting the
 *     resident's task completion;
 *   - one probe in flight, a capped pending queue with drop-oldest;
 *   - per-subject cooldown so a busy leader cannot stack probes on the
 *     same file/symbol;
 *   - subagent events are filtered out via the leader-session check;
 *   - probe failures are swallowed — the leader's work never breaks
 *     because the companion's spawn/assign rejected a probe.
 *
 * @module explore-companion
 */

import { randomUUID } from 'node:crypto';
import type { EventBus, TrackedAgentSnapshot } from '../kernel/events.js';
import {
  type Mailbox,
  isMailboxLeader,
  mailboxIdentityBase,
  sessionRecipient,
} from './mailbox-types.js';

/** Which observed work-state signal produced a probe. */
export type ExploreProbeSource =
  | 'edit_unread_file'
  | 'search_zero_hits'
  | 'unfamiliar_read'
  | 'todo_in_progress'
  | 'error_symbol'
  | 'mailbox_ask';

/** A narrow exploration task scoped to the leader's current work. */
export interface ExploreProbe {
  id: string;
  /** Human-readable question for the companion agent. */
  probe: string;
  /** Optional file/symbol hint so the companion starts index-first. */
  hint?: { file?: string; symbol?: string } | undefined;
  /** What the leader was doing when the trigger fired. */
  context?: string | undefined;
  source: ExploreProbeSource;
  /**
   * Dedupe key (`file:<path>`, `search:<query>`, `token:<symbol>`,
   * `todo:<id>`, `mail:<id>`). Probes with a subject probed within
   * `cooldownMs` are skipped.
   */
  subject: string;
  createdAt: number;
}

/** Per-signal kill switches. Omitted = enabled. */
export interface ExploreCompanionSignalToggles {
  editUnreadFile?: boolean | undefined;
  searchZeroHits?: boolean | undefined;
  unfamiliarRead?: boolean | undefined;
  todoInProgress?: boolean | undefined;
  errorSymbol?: boolean | undefined;
  mailboxAsk?: boolean | undefined;
}

export interface ExploreCompanionOptions {
  /** Live bus the leader's tool/error/todo events fire on. */
  events: EventBus;
  /** Project mailbox the companion polls for explicit asks and acks them. */
  mailbox: Mailbox;
  /**
   * Leader session id used to filter events down to this leader only. The
   * companion subscribes to global events (tool.executed, error,
   * session.agents_updated) which fire for BOTH the leader and subagents.
   * Strict, fail-closed: an event passes only when its `sessionId` equals
   * this value — unstamped events are dropped (production emitters always
   * stamp; an unstamped event is assumed to be a subagent's), and a
   * transiently unresolved getter drops everything rather than probing on
   * unattributed activity. Pass a lazy getter when the session id may
   * change at runtime.
   */
  leaderSessionId: string | (() => string | undefined);
  /**
   * Leader agent id whose todo list is diffed for the todo-in-progress
   * signal. Optional: when absent, the todo signal engages nothing (the
   * `session.agents_updated` snapshot lists leader + subagents and only the
   * leader's own todo flips should trigger probes).
   */
  leaderAgentId?: string | (() => string | undefined) | undefined;
  /**
   * Assign (or spawn) a probe on the resident companion. Called without
   * awaiting the resident's task completion — the leader is never blocked.
   */
  onProbe: (probe: ExploreProbe) => Promise<{ subagentId: string; taskId: string }>;
  /** Mailbox identity of the companion; used to poll + ack asks. Default 'explore-companion'. */
  companionAgentId?: string | undefined;
  /** Minimum gap between probes on the same subject (ms). Default 120_000. */
  cooldownMs?: number | undefined;
  /** Cap on the pending probe queue; oldest dropped when full. Default 8. */
  maxPending?: number | undefined;
  /** Mailbox poll interval for explicit asks (ms). Default 5_000. */
  pollIntervalMs?: number | undefined;
  /** Master kill switch. Default true; false makes `start()` a no-op. */
  enabled?: boolean | undefined;
  /** Per-signal kill switches. Omitted signals stay enabled. */
  signals?: ExploreCompanionSignalToggles | undefined;
  /**
   * Tool names whose successful execution counts as a file edit for the
   * edit-unread-file signal. Replaces the built-in set; matched
   * case-insensitively. Same contract as BrainMonitor.fileEditTools.
   */
  fileEditTools?: readonly string[] | undefined;
  /**
   * Tool names whose successful zero-result run fires the zero-hit signal.
   * Replaces the built-in set; matched case-insensitively.
   */
  searchTools?: readonly string[] | undefined;
  /** Injectable clock for tests. Default Date.now. */
  now?: (() => number) | undefined;
}

/** The subset re-applicable to a running companion via `reconfigure()`. */
export type ExploreCompanionTunables = Partial<
  Pick<
    ExploreCompanionOptions,
    | 'cooldownMs'
    | 'maxPending'
    | 'pollIntervalMs'
    | 'enabled'
    | 'signals'
    | 'fileEditTools'
    | 'searchTools'
    | 'companionAgentId'
  >
>;

/** Mailbox identity the companion polls/acks under by default. */
export const DEFAULT_EXPLORE_COMPANION_AGENT_ID = 'explore-companion';
/** Default per-subject probe cooldown (120s, same as BrainMonitor). */
export const DEFAULT_PROBE_COOLDOWN_MS = 120_000;
/** Default pending probe queue cap. */
export const DEFAULT_MAX_PENDING_PROBES = 8;
/** Default mailbox poll interval for explicit asks. */
export const DEFAULT_MAILBOX_POLL_INTERVAL_MS = 5_000;

/** Tools whose successful execution mutates a file we can treat as an edit. */
export const DEFAULT_EXPLORE_EDIT_TOOLS: readonly string[] = [
  'edit',
  'write',
  'patch',
  'multi_edit',
  'multiedit',
  'str_replace',
];

/** Tools whose successful zero-result run is a "search came up empty" signal. */
export const DEFAULT_EXPLORE_SEARCH_TOOLS: readonly string[] = [
  'search',
  'grep',
  'codebase-search',
];

interface ResolvedExploreCompanionConfig {
  enabled: boolean;
  cooldownMs: number;
  maxPending: number;
  pollIntervalMs: number;
  companionAgentId: string;
  signals: Required<ExploreCompanionSignalToggles>;
  fileEditTools: ReadonlySet<string>;
  searchTools: ReadonlySet<string>;
}

/**
 * Render a probe into the JSON task contract the `explore-companion` prompt
 * accepts: `{ "probe", "hint", "context" }`. Hosts use this to build the
 * subagent task text from a structured probe.
 */
export function buildProbeTaskText(probe: ExploreProbe): string {
  const payload: Record<string, unknown> = { probe: probe.probe };
  if (probe.hint) payload.hint = probe.hint;
  if (probe.context) payload.context = probe.context;
  return JSON.stringify(payload, null, 2);
}

/** Best-effort path extraction from a file tool's input (`path` or `file`). */
function extractedPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const rec = input as Record<string, unknown>;
  const candidate =
    typeof rec['path'] === 'string' ? rec['path'] : typeof rec['file'] === 'string' ? rec['file'] : undefined;
  return candidate && candidate.length > 0 ? candidate : undefined;
}

/**
 * A tool result counts as "empty" when it has no lines or its output text
 * says so explicitly. Heuristic by design — a false positive costs one
 * cheap probe, never a wrong code change.
 */
function looksEmpty(e: { output?: string | undefined; outputLines?: number | undefined }): boolean {
  if (typeof e.outputLines === 'number' && e.outputLines === 0) return true;
  const out = e.output ?? '';
  return /(?:^|\n)(?:no |0 )(?:matches|results|files? found|occurrences)/i.test(out) ||
    /total\s*:\s*0\b/i.test(out);
}

interface SubjectToken {
  kind: 'file' | 'symbol';
  value: string;
}

/** File-like and CamelCase symbol tokens from an error/todo text. */
function extractSubjectTokens(text: string): SubjectToken[] {
  const out: SubjectToken[] = [];
  const fileRe = /([\w@./-]+\.(?:[cm]?[jt]sx?|json|md|py|go|rs|ya?ml))\b/g;
  for (const m of text.matchAll(fileRe)) {
    const value = m[1];
    if (value) out.push({ kind: 'file', value });
  }
  const symRe = /\b[A-Z][A-Za-z0-9_]{2,}\b/g;
  for (const m of text.matchAll(symRe)) {
    out.push({ kind: 'symbol', value: m[0] });
  }
  return out;
}

export class ExploreCompanion {
  private readonly unsubscribers: Array<() => void> = [];
  /** Paths the leader has read (readSet) — feeds edit-unread + unfamiliar-read. */
  private readonly readSet = new Set<string>();
  /** subject → last probe time; cooldown gate. Survives detach/reconfigure. */
  private readonly probedAt = new Map<string, number>();
  /** todo id → last observed status, per leader agent. */
  private readonly todoSeen = new Map<string, string>();
  private readonly pending: ExploreProbe[] = [];
  private inFlight = false;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private hostStarted = false;
  private cfg: ResolvedExploreCompanionConfig;

  constructor(private readonly opts: ExploreCompanionOptions) {
    this.cfg = this.resolveConfig(opts);
  }

  private resolveConfig(opts: ExploreCompanionOptions): ResolvedExploreCompanionConfig {
    const signals = opts.signals ?? {};
    return {
      enabled: opts.enabled ?? true,
      cooldownMs: opts.cooldownMs ?? DEFAULT_PROBE_COOLDOWN_MS,
      maxPending: opts.maxPending ?? DEFAULT_MAX_PENDING_PROBES,
      pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_MAILBOX_POLL_INTERVAL_MS,
      companionAgentId: opts.companionAgentId ?? DEFAULT_EXPLORE_COMPANION_AGENT_ID,
      signals: {
        editUnreadFile: signals.editUnreadFile ?? true,
        searchZeroHits: signals.searchZeroHits ?? true,
        unfamiliarRead: signals.unfamiliarRead ?? true,
        todoInProgress: signals.todoInProgress ?? true,
        errorSymbol: signals.errorSymbol ?? true,
        mailboxAsk: signals.mailboxAsk ?? true,
      },
      fileEditTools: new Set(
        (opts.fileEditTools ?? DEFAULT_EXPLORE_EDIT_TOOLS).map((t) => t.toLowerCase()),
      ),
      searchTools: new Set(
        (opts.searchTools ?? DEFAULT_EXPLORE_SEARCH_TOOLS).map((t) => t.toLowerCase()),
      ),
    };
  }

  /** Resolve the leader's own session id for event filtering. */
  private resolveLeaderSessionId(): string | undefined {
    const sid = this.opts.leaderSessionId;
    return typeof sid === 'function' ? sid() : sid;
  }

  /** Resolve the leader's agent id for todo diffing (optional signal). */
  private resolveLeaderAgentId(): string | undefined {
    const aid = this.opts.leaderAgentId;
    if (!aid) return undefined;
    return typeof aid === 'function' ? aid() : aid;
  }

  /** Re-apply tunables to a (possibly running) companion. */
  reconfigure(next: ExploreCompanionTunables): boolean {
    const merged: ExploreCompanionOptions = { ...this.opts, ...next };
    const nextCfg = this.resolveConfig(merged);
    const changed =
      nextCfg.enabled !== this.cfg.enabled ||
      nextCfg.cooldownMs !== this.cfg.cooldownMs ||
      nextCfg.maxPending !== this.cfg.maxPending ||
      nextCfg.pollIntervalMs !== this.cfg.pollIntervalMs ||
      nextCfg.companionAgentId !== this.cfg.companionAgentId ||
      Object.keys(nextCfg.signals).some(
        (k) => nextCfg.signals[k as keyof ExploreCompanionSignalToggles] !== this.cfg.signals[k as keyof ExploreCompanionSignalToggles],
      );
    this.cfg = nextCfg;
    if (!changed) return false;
    // A real change re-attaches: signal toggles decide which listeners and
    // timers exist at all. Cooldowns (probedAt) survive, so re-tuning cannot
    // be used to bypass the per-subject rate limit.
    if (this.hostStarted) {
      this.detach();
      this.attach();
    }
    return true;
  }

  /** Begin watching. Idempotent; a disabled companion records intent only. */
  start(): void {
    this.hostStarted = true;
    this.attach();
  }

  /** Stop watching and drop the host's intent to watch. */
  stop(): void {
    this.hostStarted = false;
    this.detach();
  }

  /** True while the watchers are attached. */
  isRunning(): boolean {
    return this.running;
  }

  /** Number of probes queued but not yet dispatched (for status surfaces). */
  pendingCount(): number {
    return this.pending.length;
  }

  private attach(): void {
    if (!this.cfg.enabled || this.running) return;
    this.running = true;

    this.unsubscribers.push(
      this.opts.events.on('tool.executed', (e) => {
        if (e.sessionId !== this.resolveLeaderSessionId()) return;
        this.trackToolExecuted(e);
      }),
    );

    if (this.cfg.signals.todoInProgress && this.resolveLeaderAgentId()) {
      this.unsubscribers.push(
        this.opts.events.on('session.agents_updated', (e) => {
          if (e.sessionId !== this.resolveLeaderSessionId()) return;
          this.trackAgentTodos(e.agents);
        }),
      );
    }

    if (this.cfg.signals.errorSymbol) {
      this.unsubscribers.push(
        this.opts.events.on('error', (e) => {
          if (e.sessionId !== this.resolveLeaderSessionId()) return;
          this.trackError(e.err);
        }),
      );
    }

    if (this.cfg.signals.mailboxAsk) {
      this.pollTimer = setInterval(() => {
        void this.pollMailbox();
      }, this.cfg.pollIntervalMs);
      this.pollTimer.unref?.();
    }
  }

  /** Tear down watchers without touching host intent. Cooldowns survive. */
  private detach(): void {
    for (const unsub of this.unsubscribers.splice(0)) unsub();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.running = false;
  }

  // ── signal handlers ──────────────────────────────────────────────────────

  private trackToolExecuted(e: {
    name: string;
    ok: boolean;
    input?: unknown | undefined;
    output?: string | undefined;
    outputLines?: number | undefined;
  }): void {
    const tool = e.name.toLowerCase();
    const path = extractedPath(e.input);

    if (e.ok && this.cfg.signals.editUnreadFile && this.cfg.fileEditTools.has(tool) && path) {
      if (!this.readSet.has(path)) {
        this.engage({
          id: randomUUID(),
          probe: `Map file ${path}: role, exports, dependencies, and callers — the leader is about to edit it.`,
          hint: { file: path },
          context: `Leader edited ${path} without reading it first.`,
          source: 'edit_unread_file',
          subject: `file:${path}`,
          createdAt: this.now(),
        });
      }
      return;
    }

    if (e.ok && this.cfg.signals.unfamiliarRead && tool === 'read' && path) {
      if (!this.readSet.has(path)) {
        this.readSet.add(path);
        this.engage({
          id: randomUUID(),
          probe: `Skeleton + callers + dependents of ${path}: what it exports, who imports it, and how it fits the feature flow.`,
          hint: { file: path },
          context: `Leader read unfamiliar file ${path}.`,
          source: 'unfamiliar_read',
          subject: `file:${path}`,
          createdAt: this.now(),
        });
      }
      return;
    }

    if (e.ok && this.cfg.signals.searchZeroHits && this.cfg.searchTools.has(tool) && looksEmpty(e)) {
      const input = (e.input ?? {}) as Record<string, unknown>;
      const query =
        typeof input['query'] === 'string'
          ? input['query']
          : typeof input['pattern'] === 'string'
            ? input['pattern']
            : '';
      this.engage({
        id: randomUUID(),
        probe: query
          ? `Locate "${query}" — the leader's ${e.name} returned no hits. Try synonyms, a refreshed index, and lexical fallbacks.`
          : `The leader's ${e.name} returned no results. Find where the concept actually lives.`,
        hint: query ? { symbol: query } : undefined,
        context: `${e.name} for "${query}" returned zero results.`,
        source: 'search_zero_hits',
        subject: `search:${query}`,
        createdAt: this.now(),
      });
    }
  }

  private trackAgentTodos(agents: readonly TrackedAgentSnapshot[]): void {
    const leaderId = this.resolveLeaderAgentId();
    if (!leaderId) return;
    const leader = agents.find((a) => a.id === leaderId);
    if (!leader?.todos) return;
    for (const todo of leader.todos) {
      const prev = this.todoSeen.get(todo.id);
      if (prev !== 'in_progress' && todo.status === 'in_progress') {
        const mentions = extractSubjectTokens(todo.content);
        const first = mentions[0];
        this.engage({
          id: randomUUID(),
          probe: `Pre-map the files/symbols behind this in-progress todo: "${todo.content.slice(0, 160)}".`,
          hint: first
            ? { [first.kind]: first.value }
            : undefined,
          context: `Todo "${todo.content.slice(0, 120)}" flipped to in_progress.`,
          source: 'todo_in_progress',
          subject: `todo:${todo.id}`,
          createdAt: this.now(),
        });
      }
      this.todoSeen.set(todo.id, todo.status);
    }
  }

  private trackError(err: Error): void {
    const tokens = extractSubjectTokens(err.message);
    for (const token of tokens.slice(0, 2)) {
      this.engage({
        id: randomUUID(),
        probe: `What is ${token.value}, where does it live, and who uses it? The leader hit an error naming it.`,
        hint: { [token.kind]: token.value },
        context: `Error: ${err.message.slice(0, 300)}`,
        source: 'error_symbol',
        subject: `token:${token.value}`,
        createdAt: this.now(),
      });
    }
  }

  private async pollMailbox(): Promise<void> {
    if (!this.cfg.enabled || !this.cfg.signals.mailboxAsk) return;
    try {
      const messages = await this.opts.mailbox.query({
        unreadBy: this.cfg.companionAgentId,
        limit: 20,
      });
      const lsid = this.resolveLeaderSessionId();
      // Recipient gate. The store matches `to` exactly-or-`*`, so an
      // `unreadBy`-only query returns every project message unread by the
      // companion — including asks addressed to OTHER agents, which the
      // companion must neither probe on nor ack. Accept only the tagged
      // resident id, the bare base alias (family-wide by convention), this
      // session's broadcast, or a global broadcast.
      const selfRecipients = new Set<string>(
        [
          this.cfg.companionAgentId,
          mailboxIdentityBase(this.cfg.companionAgentId),
          ...(lsid != null ? [sessionRecipient(lsid)] : []),
        ].map((r) => r.toLowerCase()),
      );
      for (const msg of messages) {
        if (msg.type !== 'ask' && msg.type !== 'assign') continue;
        const to = msg.to.trim().toLowerCase();
        if (to !== '*' && !selfRecipients.has(to)) continue;
        // Only the leader may send explicit probes. The mailbox is a shared
        // bus; without this gate a peer (or an external HTTP credential)
        // could paste arbitrary text into a spawned subagent's task.
        // A stamped `senderSessionId` is authoritative and must be THIS
        // leader's session; the name check only covers unstamped legacy
        // sends, where a name like `leader@other-session` must NOT pass.
        const fromLeader =
          (msg.senderSessionId === undefined && isMailboxLeader(msg.from)) ||
          (lsid != null && msg.senderSessionId === lsid);
        if (!fromLeader) continue;
        this.engage({
          id: randomUUID(),
          probe: msg.body.trim().slice(0, 2000) || msg.subject,
          context: `Direct ask from ${msg.from}: ${msg.subject}`,
          source: 'mailbox_ask',
          subject: `mail:${msg.id}`,
          createdAt: this.now(),
        });
        await this.opts.mailbox
          .ack({
            messageId: msg.id,
            readerId: this.cfg.companionAgentId,
            read: true,
            completed: true,
          })
          .catch(() => {
            // Ack failure is not a reason to stop polling — the message
            // reappears next tick and is deduped by cooldown.
          });
      }
    } catch {
      // A mailbox hiccup must never break the leader's session.
    }
  }

  // ── engagement ───────────────────────────────────────────────────────────

  private cooldownOk(subject: string): boolean {
    const last = this.probedAt.get(subject);
    return last === undefined || this.now() - last >= this.cfg.cooldownMs;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private engage(probe: ExploreProbe): void {
    if (!this.cfg.enabled) return;
    if (!this.cooldownOk(probe.subject)) return;
    this.probedAt.set(probe.subject, this.now());
    if (this.pending.length >= this.cfg.maxPending) {
      // Drop oldest — a burst of triggers degrades gracefully.
      this.pending.shift();
    }
    this.pending.push(probe);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.inFlight) return;
    const probe = this.pending.shift();
    if (!probe) return;
    this.inFlight = true;
    try {
      await this.opts.onProbe(probe);
    } catch {
      // Probe rejection must never break the leader's work. The subject's
      // cooldown already ran, so a failed probe does not hot-loop.
    } finally {
      this.inFlight = false;
      if (this.pending.length > 0) void this.drain();
    }
  }
}
