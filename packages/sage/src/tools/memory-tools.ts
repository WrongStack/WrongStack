import type { MemoryScope, Tool } from '@wrongstack/core/types';
import type { SageServiceLike } from '../service-contract.js';
import type {
  FindMemoriesForFileResponse,
  GatherBatchResult,
  ListSagePageOptions,
  MemoryAnchor,
  MemoryAudienceSelector,
  MemoryGraphEdge,
  MemoryVerificationResult,
  PersistenceClass,
  Sage,
  SageBackfillFilter,
  SageBackfillReport,
  SageHygieneOptions,
  SageHygieneReport,
  SageKind,
  SageScope,
  UpdateSageInput,
} from '../types.js';
import { memoryCandidatesTool } from './memory-candidates-tool.js';
import {
  anchorsSchema,
  audienceSchema,
  enumSchema,
  KIND_VALUES,
  LEGACY_SCOPE_VALUES,
  numberSchema,
  objectSchema,
  SCOPE_VALUES,
  STATUS_VALUES,
  stringArraySchema,
  stringSchema,
} from './tool-schema-helpers.js';

/** Resource limit: at most this many memory IDs are individually queried for graph relations during batch gather. */
const BATCH_GRAPH_SCAN_LIMIT = 10;

/**
 * The calling session's id, read from the live `Context`.
 *
 * Session identity is ambient — the agent loop knows it, the model does not.
 * Asking the model for it (as `remember`'s `ownerSessionId` argument does) puts
 * a value nothing can verify into an ownership field: a hallucinated id creates
 * a memory owned by a session that never existed, invisible to every reader,
 * while omitting it fails the store's validation outright. Reading it here
 * makes the write/read round-trip work without the model participating.
 *
 * Returns undefined for contexts with no session — notably the synthetic
 * `Context` the SAGE MCP server builds, where "no session" is the truth and
 * the fail-closed branch of the session filter is the right outcome.
 */
function callerSessionId(ctx: unknown): string | undefined {
  const session = (ctx as { session?: { id?: unknown } } | undefined)?.session;
  const id = session?.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * Refuse to mutate a session-scoped memory owned by a different session.
 *
 * Reads are isolated on every surface — a memory owned by another session is
 * not visible to search, path, file, or bulk enumeration — yet update, delete
 * and recover took a bare id and applied it, so a session could overwrite or
 * destroy a record it could not even read. Being able to mutate the invisible
 * is the inconsistency; this closes it at the tool layer, where the ambient
 * session identity lives.
 *
 * The store keeps its unrestricted capability on purpose: hygiene
 * consolidation and the admin/recovery helpers legitimately act across every
 * session, and moving the check into the store would break them.
 */
async function assertSessionMayMutate(
  memory: SageServiceLike,
  id: string,
  ctx: unknown,
): Promise<void> {
  const target = await memory.getSage(id);
  if (target?.scope !== 'session' || !target.ownerSessionId) return;
  const caller = callerSessionId(ctx);
  if (target.ownerSessionId === caller) return;
  throw new Error(
    `SAGE "${id}" is a session-scoped memory owned by another session and cannot be modified from here.`,
  );
}

export function createSageTools(memory: SageServiceLike): Tool[] {
  return [
    memoryForFileTool(memory),
    memoryForPathTool(memory),
    memorySearchTool(memory),
    memorySearchExplainTool(memory),
    memoryGraphTool(memory),
    memoryGatherBatchTool(memory),
    memoryVerifyTool(memory),
    memoryHygieneTool(memory),
    memoryCandidatesTool(memory),
    memoryRememberTool(memory),
    memoryForgetTool(memory),
    memoryUpdateTool(memory),
    memoryDeleteTool(memory),
    memoryRecoverTool(memory),
    memoryBackfillRecoverableTool(memory),
  ];
}

interface RememberToolInput {
  text: string;
  kind?: SageKind | undefined;
  scope?: SageScope | undefined;
  tags?: string[] | undefined;
  anchors?: MemoryAnchor[] | undefined;
  audience?: MemoryAudienceSelector | undefined;
  /** When true, disables auto-scoping from agent role/mode. */
  no_auto_audience?: boolean | undefined;
  importance?: number | undefined;
  confidence?: number | undefined;
  persistence?: PersistenceClass | undefined;
  supersedes?: string[] | undefined;
  contradicts?: string[] | undefined;
  /**
   * Required when `scope` is `'session'`. The owning session ID so the
   * memory can be isolated to its session during retrieval and injection.
   */
  ownerSessionId?: string | undefined;
  /** Legacy back-compat — mapped to `kind`/`importance` by rememberSage. */
  type?:
    | 'fact'
    | 'decision'
    | 'convention'
    | 'preference'
    | 'reference'
    | 'anti_pattern'
    | undefined;
  priority?: 'critical' | 'high' | 'medium' | 'low' | undefined;
}

function memoryRememberTool(memory: SageServiceLike): Tool<RememberToolInput, Sage> {
  return {
    name: 'remember',
    category: 'Session',
    description:
      'Persist structured project knowledge into long-term SAGE. Bind it to files, symbols, or commands with `anchors` so it can be verified and auto-surfaced later.',
    usageHint:
      'Persist facts, conventions, decisions, and preferences into long-term memory.\n\n' +
      'EFFECTIVENESS RULES (follow strictly):\n' +
      '1. One durable fact per call — self-contained for a reader with zero session context.\n' +
      '2. Always prefer anchors (file/symbol/command/package). Unanchored memories rarely inject.\n' +
      '3. Use exact paths/symbols/commands in the text so path+FTS retrieval can match them.\n' +
      '4. Add 1-3 stable tags (package name, domain: auth, build, testing).\n' +
      '5. Write WHAT + WHERE + WHY/consequence in 1-4 tight sentences.\n' +
      '6. Update with `memory_update` instead of near-duplicate `remember` calls.\n\n' +
      'WHEN TO USE:\n' +
      '- Project conventions discovered during a task (build tool, lint rules, code style)\n' +
      '- Architecture decisions made (chose X over Y, decided to use pattern Z)\n' +
      '- User preferences expressed (prefers short names, always uses pnpm)\n' +
      '- Anti-patterns / warnings identified (never do X, avoid pattern Y)\n' +
      '- Bug root-causes and file/symbol notes useful across sessions\n\n' +
      'PREFER DURABLE PROJECT REFERENCES:\n' +
      '- Package ownership/boundaries and the files that implement them\n' +
      '- Symbol contracts, invariants, callers, and canonical entry points\n' +
      '- Canonical build/test/debug commands and when to use them\n' +
      '- Stable facts, decisions, conventions, workflows, and known root causes\n' +
      '- Use multiple anchors when one fact connects a package, file, symbol, or command\n\n' +
      'WHEN NOT TO USE:\n' +
      '- Temporary task state or progress → use `todo` (WIP/todo chatter is rejected)\n' +
      '- One-off debugging notes and "fixed the bug" summaries\n' +
      '- Information already obvious from the codebase\n' +
      '- `file_note` / `symbol_note` / `command_note` without anchors (hard reject)\n\n' +
      'Pick the most specific `kind`. Default persistence is `long_lived`; use `permanent`\n' +
      'only for explicit project/user invariants.\n\n' +
      'AUDIENCE SCOPING:\n' +
      '- Pass `audience: { roles: [...] }` to target a memory to specific agent types.\n' +
      '- Scoped memories are injected into matching subagent system prompts automatically.\n' +
      '- They are excluded from ordinary search/retrieval so they do not clutter general hints.\n' +
      '- Example: a reviewer agent can record `audience: { roles: ["reviewer"] }` to share\n' +
      '  review-specific guidance with future reviewer instances across sessions.',
    permission: 'confirm',
    mutating: true,
    riskTier: 'standard',
    timeoutMs: 2_000,
    capabilities: ['memory.write'],
    icon: 'settings',
    inputSchema: objectSchema(
      {
        text: {
          type: 'string',
          minLength: 1,
          description: 'The fact or note to remember. Concise and factual.',
        },
        kind: enumSchema(KIND_VALUES, 'Category — the most specific kind that fits.'),
        scope: enumSchema(
          SCOPE_VALUES,
          'project (shared, default), user (personal), session, file, or symbol.',
        ),
        ownerSessionId: {
          type: 'string',
          description:
            "Optional. For scope 'session' the current session is used automatically; pass this only to attribute the memory to a different session. Ignored for non-session scopes.",
        },
        tags: stringArraySchema('Hashtag-style tags for grouping and search (omit the #).'),
        anchors: anchorsSchema(),
        audience: audienceSchema(),
        no_auto_audience: {
          type: 'boolean',
          description:
            'Set to true to prevent auto-scoping from your agent role/mode. Creates a general project memory even when called from a subagent.',
        },
        importance: numberSchema(0, 1),
        confidence: numberSchema(0, 1),
        persistence: enumSchema(
          ['permanent', 'long_lived', 'short_lived'],
          'Retention class. Prefer long_lived; permanent is only for explicit invariants.',
        ),
        supersedes: stringArraySchema('Memory ids this replaces (they become superseded).'),
        contradicts: stringArraySchema('Memory ids this contradicts.'),
        type: {
          type: 'string',
          enum: ['fact', 'decision', 'convention', 'preference', 'reference', 'anti_pattern'],
          description: 'Legacy category (optional; prefer `kind`).',
        },
        priority: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: 'Legacy priority (optional; prefer `importance`).',
        },
      },
      ['text'],
    ),
    async execute(input, ctx, opts) {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();
      const detectedRole =
        typeof ctx?.meta?.['agentRole'] === 'string'
          ? (ctx.meta['agentRole'] as string)
          : undefined;
      const detectedMode =
        typeof ctx?.meta?.['mode'] === 'string' ? (ctx.meta['mode'] as string) : undefined;
      const autoAudience =
        !input.audience && !input.no_auto_audience && (detectedRole || detectedMode)
          ? {
              ...(detectedRole ? { roles: [detectedRole] } : {}),
              ...(detectedMode ? { modes: [detectedMode] } : {}),
            }
          : input.audience;
      return memory.rememberSage({
        text: input.text,
        kind: input.kind,
        scope: input.scope,
        // Ambient session identity wins over nothing, but an explicit
        // argument still wins over ambient: a caller replaying another
        // session's record must be able to say so.
        ownerSessionId: input.ownerSessionId ?? callerSessionId(ctx),
        tags: input.tags,
        anchors: input.anchors,
        audience: autoAudience,
        importance: input.importance,
        confidence: input.confidence,
        persistence: input.persistence,
        supersedes: input.supersedes,
        contradicts: input.contradicts,
        type: input.type,
        priority: input.priority,
      });
    },
  };
}

function memoryForgetTool(
  memory: SageServiceLike,
): Tool<{ query: string; scope?: MemoryScope }, { removed: number; scope: MemoryScope }> {
  return {
    name: 'forget',
    category: 'Session',
    description:
      'Remove memory entries whose text/tag/anchor matches the query (case-insensitive). Prefer `memory_delete` when you have a specific memory id.',
    usageHint:
      'This soft-deletes matching memories in the chosen scope.\n' +
      '- Provide a reasonably specific `query` to avoid deleting unrelated memories.\n' +
      '- Use `memory_delete` with an id for exact, single-entry removal.',
    permission: 'confirm',
    mutating: true,
    riskTier: 'standard',
    timeoutMs: 2_000,
    capabilities: ['memory.delete'],
    icon: 'settings',
    inputSchema: objectSchema(
      {
        query: { type: 'string', minLength: 1, description: 'Substring/tag/id to match.' },
        scope: enumSchema(
          LEGACY_SCOPE_VALUES,
          'Which scope to search. Defaults to project-memory.',
        ),
      },
      ['query'],
    ),
    async execute(input, ctx, opts) {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();
      const scope: MemoryScope = input.scope ?? 'project-memory';
      const removed = await memory.forget(input.query, scope);
      return { removed, scope };
    },
  };
}

function memoryUpdateTool(memory: SageServiceLike): Tool<{ id: string } & UpdateSageInput, Sage> {
  return {
    name: 'memory_update',
    category: 'Session',
    description:
      'Update a single SAGE entry by id — edit text, tags, kind, anchors, importance/confidence, status, or relationships.',
    usageHint:
      'Refine or re-scope an existing memory instead of creating a near-duplicate.\n' +
      '- Find the id via `memory_search` or `memory_for_file`.\n' +
      '- Set `status` to "stale"/"archived" to retire a memory without deleting it.',
    permission: 'confirm',
    mutating: true,
    riskTier: 'standard',
    timeoutMs: 2_000,
    capabilities: ['memory.write'],
    icon: 'settings',
    inputSchema: objectSchema(
      {
        id: { type: 'string', minLength: 1, description: 'The memory id to update.' },
        text: { type: 'string', minLength: 1, description: 'Replacement text.' },
        tags: stringArraySchema('Replacement tags (omit the #).'),
        kind: enumSchema(KIND_VALUES, 'New kind.'),
        anchors: anchorsSchema(),
        audience: audienceSchema(),
        importance: numberSchema(0, 1),
        confidence: numberSchema(0, 1),
        freshness: numberSchema(0, 1),
        status: enumSchema(STATUS_VALUES, 'New lifecycle status.'),
        supersedes: stringArraySchema('Memory ids this replaces.'),
        contradicts: stringArraySchema('Memory ids this contradicts.'),
        force: {
          type: 'boolean',
          description:
            'Required to set status to "deleted" — authorizes all deletions, not just permanent memories. The override is audit-logged.',
        },
      },
      ['id'],
    ),
    validate(input) {
      const { id, ...patch } = input;
      if (!id) return ['id is required'];
      if (Object.values(patch).every((v) => v === undefined)) {
        return ['at least one field to update is required'];
      }
      return [];
    },
    async execute(input, ctx, opts) {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();
      const { id, ...patch } = input;
      await assertSessionMayMutate(memory, id, ctx);
      return memory.updateSage(id, patch);
    },
  };
}

function memoryDeleteTool(
  memory: SageServiceLike,
): Tool<
  { id: string; reason?: string; force?: boolean; neverInject?: boolean },
  { deleted: true; id: string }
> {
  return {
    name: 'memory_delete',
    category: 'Session',
    description:
      'Delete one SAGE entry by id (soft-delete with graph/relationship cascade cleanup). Requires force: true — all deletions are audited and need explicit authorization.',
    usageHint:
      'Exact, single-entry removal by id — safer than substring `forget`.\n' +
      '- Find the id via `memory_search`. Provide a short `reason` for the audit log.\n' +
      '- **`force: true` is required for ALL deletions** — this prevents autonomous agents from removing memories without explicit authorization. The override is recorded in the audit log.\n' +
      '- Normal deletion keeps historical evidence eligible for relevant LLM context. Set `neverInject: true` only for an explicit privacy/safety ban.\n' +
      '- For non-destructive review, use `memory_candidates({ action: "propose" })` instead — the user can then resolve via `memory_candidates({ action: "resolve" })`.',
    permission: 'confirm',
    mutating: true,
    riskTier: 'standard',
    timeoutMs: 2_000,
    capabilities: ['memory.delete'],
    icon: 'settings',
    inputSchema: objectSchema(
      {
        id: { type: 'string', minLength: 1, description: 'The memory id to delete.' },
        reason: stringSchema('Reason recorded in the audit log.'),
        force: {
          type: 'boolean',
          description:
            'Required for ALL deletions — authorizes the removal and is recorded in the audit log.',
        },
        neverInject: {
          type: 'boolean',
          description:
            'Absolute privacy/safety ban: this memory must never enter LLM context. Normal deletion remains context-eligible historical evidence.',
        },
      },
      ['id', 'force'],
    ),
    validate(input) {
      if (!input.id) return ['id is required'];
      if (input.force !== true) {
        return [
          'force: true is required to delete any memory. This prevents accidental or autonomous deletions. Pass force: true to authorize; the override is audit-logged. For non-destructive review, use memory_candidates({ action: "propose" }) instead.',
        ];
      }
      return [];
    },
    async execute(input, ctx, opts) {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();
      await assertSessionMayMutate(memory, input.id, ctx);
      await memory.deleteSage(input.id, input.reason, {
        force: true,
        ...(input.neverInject === true ? { neverInject: true } : {}),
      });
      return { deleted: true, id: input.id };
    },
  };
}

interface RecoverToolOutput {
  recovered: true;
  id: string;
  /** Memory returned (after restore for `deleted`, or head-of-chain for `superseded`). */
  memory: Sage;
  /** True when the requested id was already-active or superseded (no-op write). */
  noop: boolean;
}

function memoryRecoverTool(
  memory: SageServiceLike,
): Tool<{ id: string; reason?: string }, RecoverToolOutput> {
  return {
    name: 'memory_recover',
    category: 'Session',
    description:
      'Restore a deleted SAGE entry to active status. Superseded entries resolve to the head of their version chain (no-op write).',
    usageHint:
      'Use after a `deleted` entry has been surfaced by `memory_search` with `includeStatuses: ["deleted"]`, ' +
      'or from the MemoryManager "↺ Recover" button. Idempotent: already-active or superseded entries return `noop: true`.\n' +
      '- Provide a short `reason` for the audit log.\n' +
      '- Permanence is preserved — recovering a `deleted` memory does not alter its `persistence` class.',
    permission: 'confirm',
    mutating: true,
    riskTier: 'standard',
    timeoutMs: 2_000,
    capabilities: ['memory.recover'],
    icon: 'settings',
    inputSchema: objectSchema(
      {
        id: { type: 'string', minLength: 1, description: 'The memory id to recover.' },
        reason: stringSchema('Reason recorded in the audit log.'),
      },
      ['id'],
    ),
    async execute(input, ctx, opts) {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();
      await assertSessionMayMutate(memory, input.id, ctx);
      // Read pre-call status: only `deleted` → `active` is a real write.
      // Id-equality can't distinguish "wrote and returned same id" from
      // "returned same id unchanged" (the idempotent already-active retry path).
      const preCall = await memory.getSage(input.id);
      if (!preCall) {
        throw new Error(`SAGE "${input.id}" not found.`);
      }
      const result = await memory.recoverSage(input.id, input.reason);
      const noop = preCall.status !== 'deleted';
      return { recovered: true, id: input.id, memory: result, noop };
    },
  };
}

interface BackfillRecoverableToolInput {
  filter?: SageBackfillFilter | undefined;
  /** Default true: report only. Pass `--apply` (set false) to actually create new versions. */
  apply?: boolean | undefined;
  /** Optional operator/LLM reason recorded in audit. */
  reason?: string | undefined;
}

function memoryBackfillRecoverableTool(
  memory: SageServiceLike,
): Tool<BackfillRecoverableToolInput, SageBackfillReport> {
  return {
    name: 'memory_backfill_recoverable',
    category: 'Session',
    description:
      'Find status="deleted" memories that are still recoverable and either preview them (default) or restore them as fresh active versions.',
    usageHint:
      'Use when you want to undo legacy hygiene-driven deletions. Default is `dryRun: true` — the tool returns a report without writing anything.\n' +
      '- Pass `--apply` (or `apply: false`) to actually create fresh active versions for each recoverable memory. The original `deleted` records are preserved (audit trail); a new active version is created and linked via `supersedes`.\n' +
      '- Use `filter.kinds` / `filter.scopes` / `filter.updatedAfter` / `filter.updatedBefore` to narrow scope. `filter.requireText: false` lets in records with empty text; `filter.requireProvenance: false` lets in records with neither sources nor anchors.\n' +
      '- The audit log records every run (`memory.backfill_dry_run` or `memory.backfill_applied`).',
    permission: 'confirm',
    mutating: false, // default dry-run; flips to true when apply is requested — see execute()
    riskTier: 'standard',
    timeoutMs: 5_000,
    capabilities: ['memory.backfill'],
    icon: 'search',
    inputSchema: objectSchema(
      {
        filter: {
          type: 'object',
          description: 'Optional filter — see schema for fields. Empty/missing means "no filter".',
          properties: {
            kinds: {
              type: 'array',
              items: { type: 'string', enum: KIND_VALUES },
              description: 'Only consider memories with one of these kinds.',
            },
            scopes: {
              type: 'array',
              items: { type: 'string', enum: SCOPE_VALUES },
              description: 'Only consider memories with one of these scopes.',
            },
            updatedAfter: stringSchema(
              'ISO-8601 cutoff: only memories with updatedAt >= this are considered.',
            ),
            updatedBefore: stringSchema(
              'ISO-8601 cutoff: only memories with updatedAt <= this are considered.',
            ),
            requireText: {
              type: 'boolean',
              description: 'Default true. Set false to also consider empty-text records.',
            },
            requireProvenance: {
              type: 'boolean',
              description:
                'Default true. Set false to consider records with neither sources nor anchors.',
            },
          },
          additionalProperties: false,
        },
        apply: {
          type: 'boolean',
          description: 'Default false (dry-run). Set true to actually create new active versions.',
        },
        reason: stringSchema('Optional reason recorded in the audit log.'),
      },
      [],
    ),
    async execute(input, ctx, opts) {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();
      // `--apply` semantics: the CLI surfaces the flag as `apply: true`,
      // the JS API as `dryRun: false`. We accept both shapes here.
      const dryRun = input.apply !== true;
      const report = await memory.backfillRecoverable({
        dryRun,
        ...(input.filter !== undefined ? { filter: input.filter } : {}),
      });
      return report;
    },
  };
}

/**
 * Rich file-drawer query: returns three buckets (`primaryMatches`,
 * `symbolMatches`, `relatedMatches`) with `matchedVia`, `matchStrength`,
 * `supersededByActiveId`, and `pendingReview` metadata so the file-editor
 * UI can render "why this matched" + give the user recovery / review actions.
 *
 * Side-effect-free: opening a file in the editor must never mutate the memory
 * store. Cursor-aware via `lineStart`/`lineEnd` — when both are provided,
 * symbol anchors overlapping that range get a strength boost (0.95) so the
 * user sees the most relevant notes pinned when their caret lands on a
 * function/class.
 */
function memoryForFileTool(memory: SageServiceLike): Tool<
  {
    path: string;
    /** Optional cursor line — symbol anchors overlapping get a strength boost. */
    lineStart?: number;
    lineEnd?: number;
    /** Per-bucket cap. Default 50. */
    limit?: number;
    /** Default true. Include superseded memories (with `supersededByActiveId`). */
    showSuperseded?: boolean;
    /**
     * Default false. Set true (typically via a "Show recoverable" UI toggle)
     * to surface `status='deleted'` memories for one-click recovery.
     */
    showDeleted?: boolean;
  },
  FindMemoriesForFileResponse
> {
  return {
    name: 'memory_for_file',
    category: 'Inspect',
    description:
      'Retrieve memories attached to a file, grouped by how they match. ' +
      'Supports a cursor line range so symbol-anchored memories under the caret surface first.',
    usageHint:
      'Use when opening a file in the editor and you want to surface every memory ' +
      'that is attached, anchored, or mentions the file. Pass `lineStart` / `lineEnd` ' +
      'to pin symbol-anchored memories overlapping the cursor.\n' +
      '- `primaryMatches`: scope_file or file/directory anchor (strongest).\n' +
      '- `symbolMatches`: scope_symbol or symbol anchor (cursor-boosted).\n' +
      '- `relatedMatches`: text mentions (weakest — shown under "Mentioned in").\n' +
      'Set `showDeleted: true` after a Show-recoverable toggle to include deleted records.',
    inputSchema: objectSchema(
      {
        path: stringSchema('Project-relative file path.'),
        lineStart: {
          type: 'integer',
          minimum: 1,
          description:
            'Optional — caret line (1-indexed). When both `lineStart` and `lineEnd` are set, symbol anchors overlapping this range get a strength boost.',
        },
        lineEnd: {
          type: 'integer',
          minimum: 1,
          description: 'Optional — last caret line. Pair with `lineStart`.',
        },
        limit: { ...numberSchema(1, 200), description: 'Per-bucket cap. Default 50.' },
        showSuperseded: {
          type: 'boolean',
          description: 'Default true. Set false to hide superseded memories (use for compact UI).',
        },
        showDeleted: {
          type: 'boolean',
          description:
            'Default false. Set true (typically via a "Show recoverable" UI toggle) to surface deleted memories for recovery.',
        },
      },
      ['path'],
    ),
    permission: 'auto',
    mutating: false,
    riskTier: 'safe',
    capabilities: ['memory.read'],
    icon: 'search',
    async execute(input, ctx, opts) {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();
      return memory.findMemoriesForFile(input.path, {
        sessionId: callerSessionId(ctx),
        ...(input.lineStart !== undefined ? { lineStart: input.lineStart } : {}),
        ...(input.lineEnd !== undefined ? { lineEnd: input.lineEnd } : {}),
        limit: input.limit ?? 50,
        includeSuperseded: input.showSuperseded !== false,
        includeDeleted: input.showDeleted === true,
      });
    },
  };
}

function memoryForPathTool(
  memory: SageServiceLike,
): Tool<{ path: string; limit?: number }, Sage[]> {
  return {
    name: 'memory_for_path',
    category: 'Inspect',
    description: 'Retrieve project knowledge for a path and its ancestor directories.',
    inputSchema: objectSchema(
      {
        path: stringSchema('Project-relative file or directory path.'),
        limit: numberSchema(1, 50),
      },
      ['path'],
    ),
    permission: 'auto',
    mutating: false,
    riskTier: 'safe',
    capabilities: ['memory.read'],
    icon: 'search',
    async execute(input, ctx, opts) {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();
      return memory.retrieveForPath({
        path: input.path,
        limit: input.limit ?? 20,
        includeAncestors: true,
        sessionId: callerSessionId(ctx),
      });
    },
  };
}

function memorySearchTool(
  memory: SageServiceLike,
): Tool<{ query: string; limit?: number; include_stale?: boolean }, Sage[]> {
  return {
    name: 'memory_search',
    category: 'Inspect',
    description: 'Search structured project memory using lexical, tag, path, and anchor signals.',
    inputSchema: objectSchema(
      {
        query: stringSchema('Search text, symbol, tag, command, or path.'),
        limit: numberSchema(1, 100),
        include_stale: { type: 'boolean' },
      },
      ['query'],
    ),
    permission: 'auto',
    mutating: false,
    riskTier: 'safe',
    capabilities: ['memory.read'],
    icon: 'search',
    async execute(input, ctx, opts) {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();
      return memory.searchSage(input.query, {
        limit: input.limit ?? 20,
        includeStatuses: input.include_stale ? ['active', 'stale'] : ['active'],
        // Without this the tool could never read back a session-scoped memory
        // — not even one written moments earlier by this same session.
        sessionId: callerSessionId(ctx),
      });
    },
  };
}

/**
 * Rich-variant tool: returns the same hits as `memory_search` but with a
 * per-channel breakdown — which channels matched, the lexical / vector
 * scores, the RRF final score, and a `source` attribution. Use this
 * when the agent needs to answer "why was this memory returned?" and
 * to choose between competing channels (e.g. trust the lexical match
 * for an exact symbol, or trust the semantic match for a paraphrase).
 *
 * Falls back to plain `memory_search` results (with `vectorScore: null`
 * and `source: 'lexical'`) when the underlying port doesn't expose
 * `searchSageWithBreakdown` — keeps the tool usable on remote IPC
 * ports that don't ship the rich variant.
 */
function memorySearchExplainTool(memory: SageServiceLike): Tool<
  { query: string; limit?: number; include_stale?: boolean },
  Array<{
    memory: Sage;
    vectorScore: number | null;
    lexicalScore: number | null;
    finalScore: number;
    source: 'lexical' | 'vector' | 'both';
  }>
> {
  return {
    name: 'memory_search_explain',
    category: 'Inspect',
    description:
      'Like `memory_search` but each result carries a per-channel score ' +
      'breakdown — lexical score, vector score, RRF final score, and a ' +
      '`source` attribution (`lexical` | `vector` | `both`). Use when the ' +
      'agent needs to weigh channels (e.g. trust a paraphrased semantic ' +
      'hit vs an exact lexical hit) or to surface WHY a result is in ' +
      'the list. Falls back to lexical-only hits when the underlying port ' +
      'does not expose the rich variant.',
    inputSchema: objectSchema(
      {
        query: stringSchema('Search text, symbol, tag, command, or path.'),
        limit: numberSchema(1, 100),
        include_stale: { type: 'boolean' },
      },
      ['query'],
    ),
    permission: 'auto',
    mutating: false,
    riskTier: 'safe',
    capabilities: ['memory.read'],
    icon: 'search',
    async execute(input, ctx, opts) {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();
      const sessionId = callerSessionId(ctx);
      const includeStatuses: Sage['status'][] = input.include_stale
        ? ['active', 'stale']
        : ['active'];
      // Prefer the rich variant when the port exposes it.
      if (memory.searchSageWithBreakdown) {
        const hits = await memory.searchSageWithBreakdown(input.query, {
          limit: input.limit ?? 20,
          includeStatuses,
          sessionId,
        });
        return hits.map((h) => ({
          memory: h.memory,
          vectorScore: h.vectorScore,
          lexicalScore: h.lexicalScore,
          finalScore: h.finalScore,
          source: h.source,
        }));
      }
      // Fallback: synthesize a lexical-only breakdown so consumers can
      // branch on `source` and `vectorScore` uniformly. The position
      // score is the same `1 - index / (n - 1)` heuristic the wrapper
      // uses, so the per-result scores stay consistent.
      const rows = await memory.searchSage(input.query, {
        limit: input.limit ?? 20,
        includeStatuses: includeStatuses as Sage['status'][],
        sessionId,
      });
      const total = rows.length;
      return rows.map((memory, index) => ({
        memory,
        vectorScore: null,
        lexicalScore: total <= 1 ? 1 : 1 - index / (total - 1),
        finalScore: total <= 1 ? 1 : 1 - index / (total - 1),
        source: 'lexical' as const,
      }));
    },
  };
}

function memoryGraphTool(
  memory: SageServiceLike,
): Tool<{ query: string; depth?: number; limit?: number }, MemoryGraphEdge[]> {
  return {
    name: 'memory_graph',
    category: 'Inspect',
    description: 'Traverse relationships between memories, files, symbols, commands, and sessions.',
    inputSchema: objectSchema(
      {
        query: stringSchema('A memory id, graph node, path, symbol, or search query.'),
        depth: numberSchema(1, 6),
        limit: numberSchema(1, 500),
      },
      ['query'],
    ),
    permission: 'auto',
    mutating: false,
    riskTier: 'safe',
    capabilities: ['memory.read'],
    icon: 'tree',
    async execute(input, ctx, opts) {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();
      return memory.graphFor(input.query, input.depth ?? 2, input.limit ?? 100);
    },
  };
}

function memoryGatherBatchTool(memory: SageServiceLike): Tool<
  {
    statuses?: Sage['status'][] | undefined;
    kind?: string | undefined;
    query?: string | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
    /** Include graph edges among gathered memories. Default true. */
    includeRelations?: boolean | undefined;
  },
  GatherBatchResult
> {
  return {
    name: 'memory_gather_batch',
    category: 'Session',
    description:
      'Gather a bounded batch of memories with optional graph relations. Use this for bulk memory review and cleanup workflows — enumerates active memories by status, kind, or text substring, and optionally includes their graph edges for collective evaluation.',
    inputSchema: objectSchema({
      statuses: {
        type: 'array',
        items: { type: 'string', enum: STATUS_VALUES },
        description: 'Statuses to include. Default: all except deleted.',
      },
      kind: stringSchema('Optional kind filter (e.g. "fact").'),
      query: stringSchema('Case-insensitive substring match against memory text.'),
      limit: numberSchema(1, 500),
      cursor: stringSchema("Opaque cursor from a previous page's `nextCursor`."),
      includeRelations: {
        type: 'boolean',
        description: 'Include graph edges among gathered memories. Default true.',
      },
    }),
    permission: 'auto',
    mutating: false,
    riskTier: 'safe',
    capabilities: ['memory.read'],
    icon: 'search',
    async execute(input, ctx, opts) {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();
      const pageOpts: ListSagePageOptions = {
        statuses: input.statuses,
        kind: input.kind,
        query: input.query,
        limit: input.limit,
        cursor: input.cursor,
        // Bulk enumeration is the widest read in the tool surface — 500 rows a
        // page, cursor-paged over everything. It gets the same session filter
        // as every other read rather than an exemption for being a bulk API.
        sessionId: callerSessionId(ctx),
      };
      const page = await memory.listSagePage(pageOpts);
      // Optionally gather graph relations for the first N memories
      const relations: MemoryGraphEdge[] = [];
      let scannedCount = 0;
      if (input.includeRelations !== false && page.memories.length > 0) {
        const seen = new Set<string>();
        const idsToScan = page.memories.slice(0, BATCH_GRAPH_SCAN_LIMIT);
        for (const mem of idsToScan) {
          signal?.throwIfAborted();
          scannedCount++;
          try {
            const edges = await memory.graphFor(mem.id, 1, 100);
            for (const edge of edges) {
              if (!seen.has(edge.id)) {
                seen.add(edge.id);
                relations.push(edge);
              }
            }
          } catch (err) {
            // Best-effort: one memory's graph failure does not fail the batch;
            // rethrow abort so the caller can cancel promptly.
            if (signal?.aborted) throw err;
          }
        }
      }
      return {
        memories: page.memories,
        relations,
        relationsScannedAt: scannedCount,
        nextCursor: page.nextCursor,
        total: page.total,
        statusCounts: page.statusCounts,
      };
    },
  };
}

function memoryVerifyTool(
  memory: SageServiceLike,
): Tool<{ memory_id?: string }, MemoryVerificationResult[]> {
  return {
    name: 'memory_verify',
    category: 'Session',
    description:
      'Verify file, directory, symbol, content-hash, and git-blob anchors and update stale state.',
    inputSchema: objectSchema({
      memory_id: stringSchema('Optional memory id; omit to verify all.'),
    }),
    permission: 'confirm',
    mutating: true,
    riskTier: 'standard',
    capabilities: ['memory.write', 'fs.read'],
    icon: 'settings',
    async execute(input, ctx, opts) {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();
      return memory.verify(input.memory_id, signal);
    },
  };
}

function memoryHygieneTool(memory: SageServiceLike): Tool<SageHygieneOptions, SageHygieneReport> {
  return {
    name: 'memory_hygiene',
    category: 'Session',
    description:
      'Deduplicate, verify anchors, mark stale, supersede old versions, and surface review candidates for deletion or archival. Never auto-deletes live memories — those decisions belong to the user or agent. The optional, opt-in purgeDeletedAfterDays physically compacts ALREADY-deleted tombstones older than N days out of the JSONL log (never touches active or permanent memories).',
    inputSchema: objectSchema({
      retentionDays: numberSchema(0, 3650),
      archiveLowConfidenceAfterDays: numberSchema(0, 3650),
      verify: { type: 'boolean' },
      purgeDeletedAfterDays: {
        ...numberSchema(0, 3650),
        description:
          'OPT-IN cleanup: physically remove records that are already status="deleted" and were deleted more than this many days ago, compacting them out of the JSONL log. Omit or 0 to disable (default). Never deletes active/permanent memories and never creates new deletions. JSONL backend only.',
      },
    }),
    permission: 'confirm',
    mutating: true,
    riskTier: 'standard',
    capabilities: ['memory.write', 'memory.delete', 'fs.read'],
    icon: 'settings',
    async execute(input, ctx, opts) {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();
      return memory.hygiene(input, signal);
    },
  };
}
