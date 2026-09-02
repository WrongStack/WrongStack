/** Render-neutral conversation entry contracts retained by TUI state. */

import { DEFAULT_MIN_IMPORTANCE, DEFAULT_MIN_SCORE, MIN_RELATION_STRENGTH } from '@wrongstack/sage';

// ── Brain council trace — how a multi-LLM panel reached a verdict ─────────

/** One seat's observable vote. No hidden chain-of-thought is retained. */
interface BrainCouncilSeatTrace {
  seatId: string;
  persona: string;
  status: 'valid' | 'invalid' | 'failed' | 'cancelled';
  /** The option the seat voted for, when the question was option-bearing. */
  optionId?: string | undefined;
  model?: string | undefined;
  veto?: boolean | undefined;
  durationMs?: number | undefined;
  error?: string | undefined;
}

/**
 * Panel summary attached to a council-tier Brain entry.
 *
 * The council is by far the most expensive tier — N provider calls per
 * decision — and used to be entirely invisible: the votes were emitted onto
 * the bus but no surface consumed them, so a slow, costly decision looked
 * identical to a free policy one.
 */
interface BrainCouncilTrace {
  resolution: string;
  configuredSeatCount: number;
  validVoteCount: number;
  /** Distinct provider/model targets that served the valid votes. */
  distinctTargetCount: number;
  judgeUsed: boolean;
  totalTokens?: number | undefined;
  durationMs?: number | undefined;
  /** Structural warnings — most importantly a CORRELATED (non-diverse) panel. */
  warnings?: string[] | undefined;
  seats: BrainCouncilSeatTrace[];
}

// ── Autonomy agent status — used by the banner ────────────────────────────

export interface AutonomyAgentStatus {
  /** Short display name (e.g. "Brain", "Shadow", "Kanban", "Mailbox", "Memory"). */
  name: string;
  /** Whether this agent is currently alive and reporting. */
  online: boolean;
  /** Optional detail line (risk level, interval, model, etc.). */
  detail?: string | undefined;
}

interface MemoryScoreTerm {
  label: string;
  value: number;
}

export interface MemoryActivationItem {
  id: string;
  kind: string;
  text: string;
  score: number;
  relationStrength: number;
  anchors: string[];
  tags: string[];
  activationReasons: string[];
  importance: number;
  confidence: number;
  freshness: number;
  persistence: string;
  /** Metadata floor before weighting: (importance*3 + confidence*2 + freshness) / 6. */
  metadataScore: number;
  /** Signed score contributions; they sum to the pre-clamp `score`. */
  scoreTerms: MemoryScoreTerm[];
}

/**
 * Shipped memory-gate thresholds. Used as a fallback for legacy emitters and
 * for session replays whose `memory.injector_run` payloads predate the
 * thresholds field. Must agree with `@wrongstack/core/kernel/events`
 * default gating — drift here produces a card that mis-states what the
 * gates actually were at injection time.
 */
export const MEMORY_GATE_DEFAULTS: {
  minScore: number;
  minImportance: number;
  relationFloor: number;
} = {
  minScore: DEFAULT_MIN_SCORE,
  minImportance: DEFAULT_MIN_IMPORTANCE,
  relationFloor: MIN_RELATION_STRENGTH,
};

export type HistoryEntry =
  | {
      id: number;
      kind: 'user';
      text: string;
      queued?: boolean | undefined;
      pasteContent?: string | undefined;
    }
  | {
      id: number;
      kind: 'assistant';
      text: string;
      /**
       * Whether this is the final assistant message of its turn — i.e. the
       * provider response stopped without asking for another tool. Only final
       * messages may surface a `<nextsteps>` panel or write the suggestion
       * store; mid-turn prose keeps its block stripped but silent. Every
       * construction site sets this explicitly, so an entry that arrives
       * without it renders no suggestions rather than leaking mid-turn ones.
       */
      final?: boolean | undefined;
    }
  | { id: number; kind: 'thinking'; text: string }
  | {
      id: number;
      kind: 'tool';
      name: string;
      durationMs: number;
      ok: boolean;
      input?: unknown | undefined;
      output?: string | undefined;
      /**
       * SAGE Memory Injector block for this call — `--- SAGE: … ---` header
       * plus one line per injected memory — carried beside `output` because
       * the event's ~400-char preview cap used to slice a memory line in half
       * and leak the fragment into the tool body. Rendered by
       * `SageMemoryBlock`. Absent for replayed entries, where the block is
       * still inline in `output` and `extractSageBlock` recovers it.
       */
      sageLines?: string[] | undefined;
      /**
       * Compact injector arithmetic for the block above (`+N chars`, and the
       * context pressure when it was high enough to shrink the budget).
       * Rendered on the memory panel's own header — the injector used to
       * restate the whole run as a second card beside it, which is the same
       * event twice. Absent on replay: the numbers live in the event, not in
       * the persisted tool result.
       */
      sageStats?: string | undefined;
      /** Full byte length of the result body the model actually received
       *  (post-cap, post-scrub). Carried separately because `output` is a
       *  ~400-char preview — `outputBytes` is what the model paid for. */
      outputBytes?: number | undefined;
      /** ~3.5 chars/token estimate over `outputBytes`. Cheap to render in
       *  the chip; the authoritative count lives in provider.response.usage. */
      outputTokens?: number | undefined;
      /** Real line count for tools that have a meaningful one — read counts
       *  numbered prefixes, shell/grep/logs count newlines. Undefined for
       *  tools without a line notion (json, fetch, …). */
      outputLines?: number | undefined;
      /**
       * Per-tool on-screen result render mode. `simple` hides the body
       * preview and shows only meta (line count, byte size); `extend`
       * shows the full preview. Mirrors the CLI's `setResultRenderMode`
       * state. The frontend TUI reads this off the same
       * `tools.resultRenderMode[name]` config the CLI uses.
       */
      resultRenderMode?: 'simple' | 'extend' | undefined;
    }
  | { id: number; kind: 'info'; text: string }
  | { id: number; kind: 'warn'; text: string }
  | { id: number; kind: 'error'; text: string }
  | { id: number; kind: 'turn-summary'; text: string }
  | {
      id: number;
      kind: 'model-switch';
      /** Previous provider id — omitted on the first switch when unknown. */
      fromProvider?: string | undefined;
      /** Previous model id. */
      fromModel?: string | undefined;
      /** New provider id. */
      toProvider: string;
      /** New model id. */
      toModel: string;
      /** Previous model's max context window in tokens, when known. */
      fromContext?: number | undefined;
      /** New model's max context window in tokens, when known. */
      toContext?: number | undefined;
      /** Tokens in the pending request — drives the shrink-warning line. */
      requestTokens?: number | undefined;
      /** The leader run was active when the switch was requested. */
      runActive?: boolean | undefined;
    }
  | {
      id: number;
      kind: 'memory-activation';
      trigger: string;
      outcome: 'injected' | 'empty' | 'error';
      candidates: number;
      contextPressure: number;
      injectedChars: number;
      activated: MemoryActivationItem[];
      injectedIds: string[];
      /**
       * The text actually searched — tool path plus, when `inject.taskAware`
       * is on, todo/Kanban text. This is the field that explains a match the
       * operator cannot trace to anything they typed.
       */
      queryPreview: string;
      /** Gates in force; a score without its bar is unreadable. */
      thresholds: { minScore: number; minImportance: number; relationFloor: number };
      rejected: Record<
        'duplicate' | 'belowScore' | 'alreadyVisible' | 'cooldown' | 'budget',
        number
      >;
      error?: string | undefined;
    }
  | {
      id: number;
      kind: 'memory-lifecycle';
      action:
        | 'entered'
        | 'updated'
        | 'merged'
        | 'recovered'
        | 'exited'
        | 'related'
        | 'superseded'
        | 'archived'
        | 'staled'
        | 'contradicted';
      label: string;
      detail?: string | undefined;
    }
  | {
      id: number;
      kind: 'brain';
      status: 'thinking' | 'answered' | 'ask_human' | 'denied';
      source: string;
      risk: 'low' | 'medium' | 'high' | 'critical';
      question: string;
      decision?: string | undefined;
      rationale?: string | undefined;
      outcome?: string | undefined;
      interventionKind?: string | undefined;
      /**
       * How the multi-LLM council reached this verdict, when a council decided
       * it. Present only for council-tier decisions; the single-LLM and policy
       * tiers leave it undefined.
       */
      council?: BrainCouncilTrace | undefined;
    }
  | {
      id: number;
      kind: 'banner';
      version: string;
      provider: string;
      model: string;
      cwd: string;
      family?: string | undefined;
      keyTail?: string | undefined;
      /** Current session id (e.g. "sess_01KXV6…"). Static per session lifetime,
       *  used for /resume, bug reports, and mailbox coordination. */
      sessionId?: string | undefined;
      /** Active fallback profile name (e.g. "default"), shown in the banner
       *  to make the active profile visible at a glance. */
      profile?: string | undefined;
      /** Absolute path to the active profile's config.json
       *  (e.g. "~/.wrongstack/profiles/default/config.json"). When present,
       *  the banner renders this full path with the profile name segment
       *  (the directory between "profiles/" and "/config.json") highlighted
       *  in the accent color, instead of the bare {@link profile} string. */
      profileConfigPath?: string | undefined;
      /** Background autonomy agents currently online/active (Brain, Shadow,
       *  Kanban, Mailbox, Memory, etc.). Rendered below the footer links. */
      autonomyAgents?: ReadonlyArray<AutonomyAgentStatus> | undefined;
      /** Latest version published to the npm registry, when known. Drives
       *  the "update available" indicator next to the version chip when
       *  paired with {@link updateAvailable}. */
      latestVersion?: string | undefined;
      /** True when the CLI detected a newer published version than
       *  {@link version}. The banner renders `(update available)` next to
       *  the version chip when set, so users notice without having to read
       *  the stderr notice. Source: preflight update-check (cache-aware). */
      updateAvailable?: boolean | undefined;
    }
  | { id: number; kind: 'confirm'; toolName: string; input: unknown; suggestedPattern: string }
  | {
      id: number;
      kind: 'subagent';
      agentLabel: string;
      agentColor: string;
      icon: string;
      text: string;
      detail?: string | undefined;
    };
