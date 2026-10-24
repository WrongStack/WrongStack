import type { MemoryScope, Tool } from '@wrongstack/contracts/types';
import type { SageServiceLike } from '../service-contract.js';
import { validityKey } from '../shared/memory-validity.js';
import type {
  MemoryAnchor,
  MemoryAudienceSelector,
  MemorySourceRef,
  MemoryVerificationResult,
  PersistenceClass,
  Sage,
  SageBackfillFilter,
  SageBackfillReport,
  SageHygieneOptions,
  SageHygieneReport,
  SageKind,
  SageScope,
} from '../types.js';
import { memoryCandidatesTool } from './memory-candidates-tool.js';
import { memoryDeleteTool, memoryUpdateTool } from './memory-edit-tools.js';
import {
  memoryForFileTool,
  memoryForPathTool,
  memoryGatherBatchTool,
  memoryGraphTool,
  memorySearchExplainTool,
  memorySearchTool,
} from './memory-query-tools.js';
import { assertSessionMayMutate, callerSessionId } from './memory-tool-session.js';
import {
  anchorsSchema,
  audienceSchema,
  enumSchema,
  KIND_VALUES,
  LEGACY_SCOPE_VALUES,
  numberSchema,
  objectSchema,
  SCOPE_VALUES,
  sourcesSchema,
  stringArraySchema,
  stringSchema,
  validitySchema,
} from './tool-schema-helpers.js';

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
  validity?: Sage['validity'];
  sources?: MemorySourceRef[] | undefined;
  kind?: SageKind | undefined;
  scope?: SageScope | undefined;
  tags?: string[] | undefined;
  anchors?: MemoryAnchor[] | undefined;
  audience?: MemoryAudienceSelector | undefined;
  /** When true, disables auto-scoping from agent role. */
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
      '7. Attach sources actually inspected; distinguish explicit user statements from agent observations.\n' +
      '8. After materially relying on memory, use memory_update feedback with the observed revision and concrete evidence.\n\n' +
      '9. For context-dependent claims, supply validity.statement describing when the claim applies. Optional source_contains checks must use literals actually inspected; they do not establish every assumption. Do not invent conditions for unconditional preferences.\n\n' +
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
        sources: sourcesSchema(),
        validity: validitySchema(),
        audience: audienceSchema(),
        no_auto_audience: {
          type: 'boolean',
          description:
            'Set to true to prevent auto-scoping from your agent role. Creates a general project memory even when called from a subagent.',
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
      // Auto-scoping keys on the caller's ROLE only. `ctx.meta.mode` is the
      // session's runtime mode (default / teach / yolo), which every worker
      // inherits from its leader: scoping by it turned ordinary project facts
      // into `{ modes: ['default'] }` audience memories, which ordinary path
      // injection skips and every default-mode subagent spawn receives.
      // Measured on the live store: three such memories made up 1,299 of
      // 2,020 injections in one day. A mode audience must be explicit.
      const autoAudience =
        !input.audience && !input.no_auto_audience && detectedRole
          ? { roles: [detectedRole] }
          : input.audience;
      const saved = await memory.rememberSage({
        text: input.text,
        validity: input.validity,
        kind: input.kind,
        scope: input.scope,
        // Ambient session identity wins over nothing, but an explicit
        // argument still wins over ambient: a caller replaying another
        // session's record must be able to say so.
        ownerSessionId: input.ownerSessionId ?? callerSessionId(ctx),
        tags: input.tags,
        anchors: input.anchors,
        sources: (input.sources ?? [{ type: 'session' as const }]).map((source) => ({
          ...source,
          sessionId: callerSessionId(ctx),
        })),
        audience: autoAudience,
        importance: input.importance,
        confidence: input.confidence,
        persistence: input.persistence,
        supersedes: input.supersedes,
        contradicts: input.contradicts,
        type: input.type,
        priority: input.priority,
      });
      if (input.validity && validityKey(saved.validity) !== validityKey(input.validity))
        throw new Error(
          'SAGE backend did not preserve validity conditions. The claim may have been saved without them; inspect it before relying on it and rebuild/restart the backend.',
        );
      return saved;
    },
  };
}

/**
 * Shortest `forget` query that is not, in practice, a mass delete.
 *
 * `forget` matches a substring against text, tags and anchors, so a one- or
 * two-character query matches nearly every memory in the scope:
 * `forget({ query: 'e' })` empties the project knowledge base. There is no
 * legitimate call that needs a query this short — `memory_delete` exists for
 * targeted removal — so this is a floor, not a heuristic.
 */
const MIN_FORGET_QUERY_LEN = 3;

function memoryForgetTool(
  memory: SageServiceLike,
): Tool<
  { query: string; scope?: MemoryScope; force?: boolean },
  { removed: number; scope: MemoryScope }
> {
  return {
    name: 'forget',
    category: 'Session',
    description:
      'Remove memory entries whose text/tag/anchor matches the query (case-insensitive). Requires force: true — this is a bulk delete. Prefer `memory_delete` when you have a specific memory id.',
    usageHint:
      'This soft-deletes matching memories in the chosen scope.\n' +
      '- **`force: true` is required** — `forget` deletes EVERY match at once, so it is strictly more destructive than `memory_delete`, which requires the same flag for a single entry.\n' +
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
        query: {
          type: 'string',
          minLength: MIN_FORGET_QUERY_LEN,
          description: 'Substring/tag/id to match.',
        },
        scope: enumSchema(
          LEGACY_SCOPE_VALUES,
          'Which scope to search. Defaults to project-memory.',
        ),
        force: {
          type: 'boolean',
          description:
            'Required — authorizes deleting every memory matching the query. Recorded in the audit log.',
        },
      },
      ['query', 'force'],
    ),
    // `forget` sat at the same exposure tier as `memory_delete` — both are
    // `permission: 'confirm'` + `riskTier: 'standard'`, so both become
    // callable together on any surface that opts in (the SAGE MCP server's
    // `--writable`). But `memory_delete` removes ONE entry by id and demanded
    // `force: true`, while `forget` removed EVERY substring match and demanded
    // nothing. The strictly more destructive tool was the unguarded one.
    validate(input) {
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (query.length === 0) return ['query is required'];
      if (query.length < MIN_FORGET_QUERY_LEN) {
        return [
          `query must be at least ${MIN_FORGET_QUERY_LEN} characters. \`forget\` matches a substring against text, tags and anchors, so a shorter query deletes nearly everything in the scope. Use \`memory_delete\` with an id for targeted removal.`,
        ];
      }
      if (input.force !== true) {
        return [
          'force: true is required to bulk-delete memories. `forget` removes every entry matching the query at once — pass force: true to authorize; the override is audit-logged. For non-destructive review, use memory_search to see what would match first.',
        ];
      }
      return [];
    },
    async execute(input, ctx, opts) {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();
      const scope: MemoryScope = input.scope ?? 'project-memory';
      const removed = await memory.forget(input.query, scope);
      return { removed, scope };
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
      '- Pass `apply: true` (CLI: `--apply`) to actually create fresh active versions for each recoverable memory. The original `deleted` records are preserved (audit trail); a new active version is created and linked via `supersedes`.\n' +
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
      // verify(id) returns [] for an unknown id — indistinguishable from
      // "nothing to check". A named target that does not exist is a failure.
      if (input.memory_id) {
        const target = await memory.getSage(input.memory_id);
        if (!target || target.status === 'deleted') {
          throw new Error(`SAGE "${input.memory_id}" not found.`);
        }
      }
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
