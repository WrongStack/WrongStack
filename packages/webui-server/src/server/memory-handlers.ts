/**
 * Shared memory-operation WebSocket handlers for both the standalone WebUI
 * server and the CLI's `--webui` embedded server.
 *
 * Each function handles the full request→response cycle for one message
 * type. Callers drop them into their switch statement:
 *
 *   case 'memory.list': return handleMemoryList(ws, memoryStore);
 *
 * Sage handlers request the typed surface capability:
 *
 *   case 'memory.sage.list': return handleSageList(ws, memoryStore);
 */

import type { MemoryPort } from '@wrongstack/core/types';
import { getSageSurface, type SageStatus } from '@wrongstack/sage';
import type { WebSocket } from 'ws';
import type { WSClientMessage } from './types.js';
import { errMessage, send, withRequestId } from './ws-utils.js';

// ── Sage response projection ──────────────────────────────────

interface SageLike {
  id: string;
  kind: string;
  status: string;
  text: string;
  tags: string[];
}

interface SageStatsLike {
  total: number;
  byStatus: Record<string, number>;
  byKind: Partial<Record<string, number>>;
  edges: number;
}

function requiresSage(command: string): string {
  return `\`${command}\` requires the SAGE backend (Sage.enabled).`;
}

// ── Memory list (chat `/memory`) — renders the single SAGE store ──

/**
 * List memory for the chat `/memory` command. When the backend is SAGE
 * (always, in practice) this renders the rich structured view — the same one
 * surface as the MemoryManager panel and the CLI/TUI `/memory show`. Falls back
 * to `readAll()` text only for a non-SAGE store.
 * Responds with `{ type: 'memory.list', payload: { text } }`.
 */
export async function handleMemoryList(
  ws: WebSocket,
  msg: WSClientMessage,
  memoryStore: MemoryPort,
): Promise<void> {
  try {
    const Sage = getSageSurface(memoryStore);
    if (Sage) {
      const [stats, memories] = await Promise.all([Sage.stats(), Sage.listSage()]);
      const text = memories.length === 0 ? '🧠 SAGE is empty.' : formatSageText(stats, memories);
      send(ws, { type: 'memory.list', payload: withRequestId(msg.payload, { text }) });
      return;
    }
    const text = await memoryStore.readAll();
    send(ws, { type: 'memory.list', payload: withRequestId(msg.payload, { text }) });
  } catch (err) {
    send(ws, {
      type: 'memory.list',
      payload: withRequestId(msg.payload, { text: '', error: errMessage(err) }),
    });
  }
}

/** Render the SAGE list as markdown for the chat `/memory` view. */
function formatSageText(stats: SageStatsLike, memories: SageLike[]): string {
  const active = stats.byStatus['active'] ?? 0;
  const stale = stats.byStatus['stale'] ?? 0;
  const archived = stats.byStatus['archived'] ?? 0;
  const lines: string[] = [
    '## 🧠 SAGE',
    '',
    `**Total:** ${stats.total} · 🟢 ${active} active · 🟡 ${stale} stale · 🔵 ${archived} archived · **edges:** ${stats.edges}`,
    '',
  ];
  for (const m of memories) {
    const tags = m.tags.length > 0 ? ` \`${m.tags.slice(0, 3).join('` `')}\`` : '';
    const icon =
      m.status === 'active'
        ? '🟢'
        : m.status === 'stale'
          ? '🟡'
          : m.status === 'archived'
            ? '🔵'
            : '⚪';
    const preview = m.text.replace(/\s+/g, ' ').trim().slice(0, 140);
    lines.push(`- ${icon} \`${m.id.slice(0, 12)}…\` [${m.kind}] ${preview}${tags}`);
  }
  return lines.join('\n');
}

// ── Sage handlers ─────────────────────────────────────────────

/**
 * List all Sage entries with stats.
 * Request:  { type: 'memory.sage.list' }
 * Response: { type: 'memory.sage.list', payload: { memories, stats } }
 */
export async function handleSageList(
  ws: WebSocket,
  msg: WSClientMessage,
  memoryStore: MemoryPort,
): Promise<void> {
  const Sage = getSageSurface(memoryStore);
  if (!Sage) {
    send(ws, {
      type: 'memory.sage.list',
      payload: withRequestId(msg.payload, { error: requiresSage('memory.sage.list') }),
    });
    return;
  }
  try {
    const [stats, memories] = await Promise.all([Sage.stats(), Sage.listSage()]);
    send(ws, {
      type: 'memory.sage.list',
      payload: withRequestId(msg.payload, { memories, stats }),
    });
  } catch (err) {
    send(ws, {
      type: 'memory.sage.list',
      payload: withRequestId(msg.payload, { error: errMessage(err) }),
    });
  }
}

/**
 * Paginated, status-filtered Sage listing. Preferred over
 * `memory.sage.list` for the MemoryManager: it returns a bounded page plus a
 * cursor so the WebUI never loads thousands of soft-deleted records at once.
 *
 * Request:  { type: 'memory.sage.listPage', payload: { statuses?, kind?, query?, limit?, cursor? } }
 * Response: { type: 'memory.sage.listPage', payload: { memories, nextCursor, total, statusCounts } }
 *
 * `statuses` defaults (backend-side) to every status EXCEPT `deleted`. Pass
 * `statuses: ['deleted']` for the WebUI "Deleted" tab. Falls back gracefully to
 * a full `listSage()` for stores that predate `listSagePage`.
 */
export async function handleSageListPage(
  ws: WebSocket,
  msg: unknown,
  memoryStore: MemoryPort,
): Promise<void> {
  const Sage = getSageSurface(memoryStore);
  if (!Sage) {
    send(ws, {
      type: 'memory.sage.listPage',
      payload: withRequestId((msg as { payload?: unknown })?.payload, {
        error: requiresSage('memory.sage.listPage'),
      }),
    });
    return;
  }
  try {
    const payload = (msg as { payload?: Record<string, unknown> }).payload ?? {};
    const options = {
      statuses: Array.isArray(payload['statuses'])
        ? (payload['statuses'] as unknown[]).filter((s): s is string => typeof s === 'string')
        : undefined,
      kind: typeof payload['kind'] === 'string' ? (payload['kind'] as string) : undefined,
      query: typeof payload['query'] === 'string' ? (payload['query'] as string) : undefined,
      limit: typeof payload['limit'] === 'number' ? (payload['limit'] as number) : undefined,
      cursor: typeof payload['cursor'] === 'string' ? (payload['cursor'] as string) : undefined,
    };

    if (typeof Sage.listSagePage === 'function') {
      const [page, stats] = await Promise.all([Sage.listSagePage(options as never), Sage.stats()]);
      send(ws, {
        type: 'memory.sage.listPage',
        payload: withRequestId(payload, { ...page, stats }),
      });
      return;
    }

    // Backend without native pagination: emulate by loading + slicing in-memory.
    const allowed =
      options.statuses && options.statuses.length > 0 ? new Set(options.statuses) : undefined; // undefined => every status; deleted filtered below
    const everything = await Sage.listSage();
    const statusCounts: Record<string, number> = {};
    for (const m of everything) statusCounts[m.status] = (statusCounts[m.status] ?? 0) + 1;
    const kind = options.kind && options.kind !== 'all' ? options.kind : undefined;
    const q = options.query?.trim().toLowerCase();
    const filtered = everything
      .filter((m) => {
        if (allowed) return allowed.has(m.status);
        return m.status !== 'deleted';
      })
      .filter((m) => !kind || m.kind === kind)
      .filter((m) => !q || m.text.toLowerCase().includes(q));
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 50)));
    send(ws, {
      type: 'memory.sage.listPage',
      payload: withRequestId(payload, {
        memories: filtered.slice(0, limit),
        nextCursor: null,
        total: filtered.length,
        statusCounts,
        stats: await Sage.stats(),
      }),
    });
  } catch (err) {
    send(ws, {
      type: 'memory.sage.listPage',
      payload: withRequestId(
        (msg as { payload?: Record<string, unknown> }).payload,
        { error: errMessage(err) },
      ),
    });
  }
}

/**
 * Run a search and return the per-channel score breakdown
 * (lexical / vector / final + `source` attribution). Used by the
 * WebUI's Memory panel so the operator can see WHY a memory is in
 * the result list.
 *
 * Request:  { type: 'memory.sage.searchBreakdown', payload: { query, limit?, includeStale? } }
 * Response: { type: 'memory.sage.searchBreakdown', payload: { hits, source } }
 *
 * `source` is one of:
 *  - `breakdown`: the underlying surface returned a `VectorAugmentHit[]`
 *    with both lexical and vector scores populated per hit.
 *  - `lexical`: the surface only has the flat `searchSage` — we wrap
 *    the results with a position-derived score and `source: 'lexical'`.
 *
 * Clients branch on `source` to decide whether to render the dual
 * score panel or a single lexical column.
 */
export async function handleSageSearchBreakdown(
  ws: WebSocket,
  msg: unknown,
  memoryStore: MemoryPort,
): Promise<void> {
  const Sage = getSageSurface(memoryStore);
  if (!Sage) {
    send(ws, {
      type: 'memory.sage.searchBreakdown',
      payload: withRequestId(msg, { error: requiresSage('memory.sage.searchBreakdown') }),
    });
    return;
  }
  try {
    const payload = (msg as { payload?: Record<string, unknown> }).payload ?? {};
    const query = typeof payload['query'] === 'string' ? (payload['query'] as string) : '';
    if (query.trim().length === 0) {
      send(ws, {
        type: 'memory.sage.searchBreakdown',
        payload: withRequestId(msg, { error: 'Missing required field `query`' }),
      });
      return;
    }
    const limit = typeof payload['limit'] === 'number' ? payload['limit'] : 20;
    const includeStale = payload['includeStale'] === true;
    const includeStatuses: SageStatus[] = includeStale ? ['active', 'stale'] : ['active'];
    const options = { limit, includeStatuses };
    if (typeof Sage.searchSageWithBreakdown === 'function') {
      const hits = await Sage.searchSageWithBreakdown(query, options);
      send(ws, {
        type: 'memory.sage.searchBreakdown',
        payload: withRequestId(payload, { hits, source: 'breakdown' }),
      });
      return;
    }
    // Fallback: synthesize a lexical-only breakdown so the WebUI can
    // render a uniform card even when the rich variant isn't
    // available on the underlying surface.
    const rows = await Sage.searchSage(query, options);
    const total = rows.length;
    const hits = rows.map((memory, index) => ({
      memory,
      vectorScore: null,
      lexicalScore: total <= 1 ? 1 : 1 - index / Math.max(1, total - 1),
      finalScore: total <= 1 ? 1 : 1 - index / Math.max(1, total - 1),
      source: 'lexical' as const,
    }));
    send(ws, {
      type: 'memory.sage.searchBreakdown',
      payload: withRequestId(payload, { hits, source: 'lexical' }),
    });
  } catch (err) {
    send(ws, {
      type: 'memory.sage.searchBreakdown',
      payload: withRequestId(
        (msg as { payload?: Record<string, unknown> }).payload,
        { error: errMessage(err) },
      ),
    });
  }
}

/**
 * Get a single Sage entry by ID.
 * Request:  { type: 'memory.sage.get', payload: { id } }
 * Response: { type: 'memory.sage.get', payload: { memory } }
 */
export async function handleSageGet(
  ws: WebSocket,
  msg: unknown,
  memoryStore: MemoryPort,
): Promise<void> {
  const Sage = getSageSurface(memoryStore);
  if (!Sage) {
    send(ws, {
      type: 'memory.sage.get',
      payload: withRequestId(msg, { error: requiresSage('memory.sage.get') }),
    });
    return;
  }
  const { id } = (msg as { payload: { id: string } }).payload;
  if (!id) {
    send(ws, {
      type: 'memory.sage.get',
      payload: withRequestId(msg, { error: 'id is required' }),
    });
    return;
  }
  try {
    const memory = await Sage.getSage(id);
    if (!memory) {
      send(ws, {
        type: 'memory.sage.get',
        payload: withRequestId(msg, { error: `Memory "${id}" not found.` }),
      });
      return;
    }
    send(ws, { type: 'memory.sage.get', payload: withRequestId(msg, { memory }) });
  } catch (err) {
    send(ws, {
      type: 'memory.sage.get',
      payload: withRequestId(msg, { error: errMessage(err) }),
    });
  }
}

/** Return the real persisted graph plus memory records for directly referenced nodes. */
export async function handleSageGraph(
  ws: WebSocket,
  msg: unknown,
  memoryStore: MemoryPort,
): Promise<void> {
  const Sage = getSageSurface(memoryStore);
  if (!Sage?.graphFor) {
    send(ws, {
      type: 'memory.sage.graph',
      payload: withRequestId(msg, { query: '', error: requiresSage('memory.sage.graph') }),
    });
    return;
  }
  const payload = (msg as { payload?: Record<string, unknown> }).payload ?? {};
  const query = typeof payload['query'] === 'string' ? payload['query'].trim() : '';
  if (!query) {
    send(ws, {
      type: 'memory.sage.graph',
      payload: withRequestId(msg, { query, error: 'query is required' }),
    });
    return;
  }
  const maxDepth =
    typeof payload['maxDepth'] === 'number'
      ? Math.max(1, Math.min(3, Math.floor(payload['maxDepth'])))
      : 1;
  const limit =
    typeof payload['limit'] === 'number'
      ? Math.max(1, Math.min(250, Math.floor(payload['limit'])))
      : 100;
  try {
    const edges = await Sage.graphFor(query, maxDepth, limit);
    const memoryIds = new Set<string>();
    for (const edge of edges) {
      for (const node of [edge.from, edge.to]) {
        if (node.startsWith('mem:')) memoryIds.add(node.slice(4));
      }
    }
    const memories = (await Promise.all([...memoryIds].map((id) => Sage.getSage(id)))).filter(
      (memory) => memory !== null,
    );
    send(ws, {
      type: 'memory.sage.graph',
      payload: withRequestId(msg, { query, edges, memories }),
    });
  } catch (err) {
    send(ws, {
      type: 'memory.sage.graph',
      payload: withRequestId(msg, { query, error: errMessage(err) }),
    });
  }
}

/**
 * Update a Sage entry.
 * Request:  { type: 'memory.sage.update', payload: { id, ...patch } }
 * Response: { type: 'memory.sage.update', payload: { memory } }
 * On error: { type: 'memory.sage.update', payload: { error } }
 */
export async function handleSageUpdate(
  ws: WebSocket,
  msg: unknown,
  memoryStore: MemoryPort,
): Promise<void> {
  const Sage = getSageSurface(memoryStore);
  if (!Sage) {
    send(ws, {
      type: 'memory.sage.update',
      payload: withRequestId(msg, { error: requiresSage('memory.sage.update') }),
    });
    return;
  }
  const payload = (msg as { payload: Record<string, unknown> }).payload;
  const id = payload['id'] as string | undefined;
  if (!id) {
    send(ws, {
      type: 'memory.sage.update',
      payload: withRequestId(msg, { error: 'id is required' }),
    });
    return;
  }

  // Extract patch fields (everything except id)
  const patch: Record<string, unknown> = { ...payload };
  delete patch['id'];

  if (Object.keys(patch).length === 0) {
    send(ws, {
      type: 'memory.sage.update',
      payload: withRequestId(msg, { error: 'No fields to update.' }),
    });
    return;
  }

  try {
    const memory = await Sage.updateSage(id, patch as never);
    send(ws, { type: 'memory.sage.update', payload: withRequestId(msg, { memory }) });
  } catch (err) {
    send(ws, {
      type: 'memory.sage.update',
      payload: withRequestId(msg, { error: errMessage(err) }),
    });
  }
}

/**
 * Create a new Sage entry with full metadata.
 * Request:  { type: 'memory.sage.remember', payload: { text, kind?, scope?, tags?, anchors?, importance?, confidence?, freshness?, supersedes?, contradicts? } }
 * Response: { type: 'memory.sage.remember', payload: { memory } }
 * On error: { type: 'memory.sage.remember', payload: { error } }
 */
export async function handleSageRemember(
  ws: WebSocket,
  msg: unknown,
  memoryStore: MemoryPort,
): Promise<void> {
  const Sage = getSageSurface(memoryStore);
  if (!Sage) {
    send(ws, {
      type: 'memory.sage.remember',
      payload: withRequestId(msg, { error: requiresSage('memory.sage.remember') }),
    });
    return;
  }
  const payload = (msg as { payload: Record<string, unknown> }).payload;
  const text = payload['text'] as string | undefined;
  if (!text?.trim()) {
    send(ws, {
      type: 'memory.sage.remember',
      payload: withRequestId(msg, { error: 'text is required' }),
    });
    return;
  }
  try {
    const memory = await Sage.rememberSage({
      text: text.trim(),
      kind: payload['kind'] as string | undefined,
      scope: payload['scope'] as string | undefined,
      tags: payload['tags'] as string[] | undefined,
      anchors: payload['anchors'] as
        | Array<{ type: string; path?: string; symbol?: string; command?: string }>
        | undefined,
      importance: payload['importance'] as number | undefined,
      confidence: payload['confidence'] as number | undefined,
      freshness: payload['freshness'] as number | undefined,
      audience: payload['audience'] as
        | { roles?: string[]; taskTypes?: string[]; modes?: string[] }
        | undefined,
      supersedes: payload['supersedes'] as string[] | undefined,
      contradicts: payload['contradicts'] as string[] | undefined,
    } as never);
    send(ws, { type: 'memory.sage.remember', payload: withRequestId(msg, { memory }) });
  } catch (err) {
    send(ws, {
      type: 'memory.sage.remember',
      payload: withRequestId(msg, { error: errMessage(err) }),
    });
  }
}

/**
 * Delete a Sage entry (soft-delete with cascade cleanup).
 * Request:  { type: 'memory.sage.delete', payload: { id, reason?, force?, neverInject? } }
 * Response: { type: 'memory.sage.delete', payload: { success, message } }
 *
 * `force` defaults to `false`. The caller must explicitly pass `force: true`
 * to authorize deletion. The permanent-memory guard in `deleteSage` is
 * always respected when force is not set.
 *
 * `neverInject` (default false) marks the memory so context injection
 * never loads it — used when a memory is factually wrong, not just
 * superseded.
 *
 * Uses an operation-specific response type (not the generic
 * `key.operation_result`) so the client can correlate the response
 * to this specific action without matching unrelated broadcast events.
 */
export async function handleSageDelete(
  ws: WebSocket,
  msg: unknown,
  memoryStore: MemoryPort,
): Promise<void> {
  const Sage = getSageSurface(memoryStore);
  if (!Sage) {
    send(ws, {
      type: 'memory.sage.delete',
      payload: { success: false, message: requiresSage('memory.sage.delete') },
    });
    return;
  }
  const { id, reason, neverInject, force } = (
    msg as {
      payload: {
        id: string;
        reason?: string | undefined;
        neverInject?: boolean | undefined;
        force?: boolean | undefined;
      };
    }
  ).payload;
  if (!id) {
    send(ws, {
      type: 'memory.sage.delete',
      payload: { success: false, message: 'id is required' },
    });
    return;
  }
  try {
    await Sage.deleteSage(id, reason, {
      force: force === true,
      neverInject: neverInject === true,
    });
    send(ws, {
      type: 'memory.sage.delete',
      payload: { success: true, message: `Deleted memory "${id}".` },
    });
  } catch (err) {
    send(ws, {
      type: 'memory.sage.delete',
      payload: { success: false, message: errMessage(err) },
    });
  }
}

/**
 * Restore a deleted SAGE entry to active status (PR #1).
 * Request:  { type: 'memory.sage.recover', payload: { id, reason? } }
 * Response: { type: 'memory.sage.recover', payload: { memory?, noop?, activeId? } }
 *
 * - `noop: true` when the id was already active (no write happened)
 * - `activeId: <id>` when the id was superseded — returns the head of the chain
 * - otherwise returns the freshly-restored memory
 */
export async function handleSageRecover(
  ws: WebSocket,
  msg: unknown,
  memoryStore: MemoryPort,
): Promise<void> {
  const Sage = getSageSurface(memoryStore);
  if (!Sage?.recoverSage) {
    send(ws, {
      type: 'memory.sage.recover',
      payload: withRequestId(msg, { error: requiresSage('memory.sage.recover') }),
    });
    return;
  }
  const payload = (msg as { payload: Record<string, unknown> }).payload;
  const id = payload['id'] as string | undefined;
  if (!id) {
    send(ws, {
      type: 'memory.sage.recover',
      payload: withRequestId(msg, { error: 'id is required' }),
    });
    return;
  }
  const reason = payload['reason'] as string | undefined;
  try {
    const preExisting = await Sage.getSage(id);
    if (!preExisting) {
      send(ws, {
        type: 'memory.sage.recover',
        payload: withRequestId(msg, { error: `SAGE "${id}" not found.` }),
      });
      return;
    }
    // Already active: no-op — return the existing record without calling recover.
    if (preExisting.status === 'active') {
      send(ws, {
        type: 'memory.sage.recover',
        payload: withRequestId(msg, { recovered: true, memory: preExisting, noop: true }),
      });
      return;
    }
    // Deleted or superseded: call recover to get the actual result.
    const memory = await Sage.recoverSage(id, reason);
    // Superseded: the store returns the chain head (different id).
    const noop = memory.id !== id;
    const response: Record<string, unknown> = { recovered: true, memory };
    if (noop) {
      response['activeId'] = memory.id;
      response['noop'] = true;
    }
    send(ws, { type: 'memory.sage.recover', payload: withRequestId(msg, response) });
  } catch (err) {
    send(ws, {
      type: 'memory.sage.recover',
      payload: withRequestId(msg, { error: errMessage(err) }),
    });
  }
}

/**
 * List review-queue candidates (hygiene / triage proposals).
 * Request:  { type: 'memory.sage.listCandidates', payload?: { includeResolved?: boolean } }
 * Response: { type: 'memory.sage.listCandidates', payload: { candidates } }
 */
export async function handleSageListCandidates(
  ws: WebSocket,
  msg: unknown,
  memoryStore: MemoryPort,
): Promise<void> {
  const Sage = getSageSurface(memoryStore);
  if (!Sage) {
    send(ws, {
      type: 'memory.sage.listCandidates',
      payload: withRequestId(msg, { error: requiresSage('memory.sage.listCandidates') }),
    });
    return;
  }
  try {
    const payload = (msg as { payload?: Record<string, unknown> }).payload ?? {};
    const includeResolved = payload['includeResolved'] === true;
    if (typeof Sage.listCandidates !== 'function') {
      send(ws, {
        type: 'memory.sage.listCandidates',
        payload: withRequestId(msg, { error: 'listCandidates is not available on this SAGE surface' }),
      });
      return;
    }
    const candidates = await Sage.listCandidates(includeResolved);
    send(ws, {
      type: 'memory.sage.listCandidates',
      payload: withRequestId(msg, { candidates }),
    });
  } catch (err) {
    send(ws, {
      type: 'memory.sage.listCandidates',
      payload: withRequestId(msg, { error: errMessage(err) }),
    });
  }
}

/**
 * Resolve a pending hygiene review candidate (PR #1).
 * Request:  { type: 'memory.sage.candidateResolve', payload: { candidateId, action: 'accept'|'reject', reason? } }
 * Response: { type: 'memory.sage.candidateResolve', payload: { candidate, resolvedAction } }
 *
 * The store handles audit + status mutation; the handler just relays the
 * payload. If the candidate id is unknown, the store returns null and we
 * surface a structured error.
 */
export async function handleSageCandidateResolve(
  ws: WebSocket,
  msg: unknown,
  memoryStore: MemoryPort,
): Promise<void> {
  const Sage = getSageSurface(memoryStore);
  if (!Sage) {
    send(ws, {
      type: 'memory.sage.candidateResolve',
      payload: { error: requiresSage('memory.sage.candidateResolve') },
    });
    return;
  }
  const payload = (msg as { payload: Record<string, unknown> }).payload;
  const candidateId = payload['candidateId'] as string | undefined;
  const action = payload['action'] as 'accept' | 'reject' | undefined;
  if (!candidateId) {
    send(ws, {
      type: 'memory.sage.candidateResolve',
      payload: { error: 'candidateId is required' },
    });
    return;
  }
  if (action !== 'accept' && action !== 'reject') {
    send(ws, {
      type: 'memory.sage.candidateResolve',
      payload: { error: 'action must be "accept" or "reject"' },
    });
    return;
  }
  const reason = payload['reason'] as string | undefined;
  try {
    let candidate: { id: string; status: string } | undefined;
    if (action === 'accept') {
      const accepted = await Sage.acceptCandidate(candidateId);
      candidate = accepted ? { id: accepted.id, status: accepted.status ?? 'active' } : undefined;
    } else {
      const rejected = await Sage.rejectCandidate(candidateId, reason ?? 'Rejected via WebUI');
      candidate = rejected ? { id: candidateId, status: 'rejected' } : undefined;
    }
    if (!candidate) {
      send(ws, {
        type: 'memory.sage.candidateResolve',
        payload: { error: `Candidate "${candidateId}" not found` },
      });
      return;
    }
    send(ws, {
      type: 'memory.sage.candidateResolve',
      payload: { candidate, resolvedAction: action },
    });
  } catch (err) {
    send(ws, {
      type: 'memory.sage.candidateResolve',
      payload: { error: errMessage(err) },
    });
  }
}

/**
 * Scan deleted records and either preview (dry-run) or apply a backfill
 * that creates fresh active versions for recoverable entries (PR #3).
 *
 * Request:  { type: 'memory.sage.backfillRecoverable', payload: { apply, filter? } }
 * Response: { type: 'memory.sage.backfillRecoverable', payload: { examined, recovered, recoverable, dryRun } }
 *
 * `apply` defaults to false (dry-run preview). When true, the store writes
 * new active versions and links them to the original `deleted` records via
 * `supersedes`. The report count fields are forwarded for dashboard / UI use.
 */
export async function handleSageBackfillRecoverable(
  ws: WebSocket,
  msg: unknown,
  memoryStore: MemoryPort,
): Promise<void> {
  const Sage = getSageSurface(memoryStore);
  if (!Sage?.backfillRecoverable) {
    send(ws, {
      type: 'memory.sage.backfillRecoverable',
      payload: { error: requiresSage('memory.sage.backfillRecoverable') },
    });
    return;
  }
  const payload = (msg as { payload: Record<string, unknown> }).payload ?? {};
  const apply = payload['apply'] === true;
  // Filter passthrough is permissive: the store validates per-field. We
  // only pass fields that are present so absent fields stay absent (the
  // store defaults its own omission to "no filter").
  const rawFilter = (payload['filter'] ?? {}) as Record<string, unknown>;
  const filter: {
    kinds?: string[];
    scopes?: string[];
    updatedAfter?: string;
    updatedBefore?: string;
  } = {};
  if (Array.isArray(rawFilter['kinds'])) filter.kinds = rawFilter['kinds'] as string[];
  if (Array.isArray(rawFilter['scopes'])) filter.scopes = rawFilter['scopes'] as string[];
  if (typeof rawFilter['updatedAfter'] === 'string')
    filter.updatedAfter = rawFilter['updatedAfter'];
  if (typeof rawFilter['updatedBefore'] === 'string')
    filter.updatedBefore = rawFilter['updatedBefore'];
  try {
    const report = await Sage.backfillRecoverable({
      dryRun: !apply,
      ...(Object.keys(filter).length > 0 ? { filter } : {}),
    } as never);
    send(ws, {
      type: 'memory.sage.backfillRecoverable',
      payload: {
        examined: report.examined,
        recovered: report.recovered,
        recoverable: report.recoverable,
        dryRun: !apply,
      },
    });
  } catch (err) {
    send(ws, {
      type: 'memory.sage.backfillRecoverable',
      payload: { error: errMessage(err) },
    });
  }
}

/**
 * Rich file-drawer query — returns 3 buckets (primary/symbol/related)
 * with matchedVia, matchStrength, supersededByActiveId, pendingReview (PR #4).
 */
export async function handleSageForFile(
  ws: WebSocket,
  msg: unknown,
  memoryStore: MemoryPort,
): Promise<void> {
  const Sage = getSageSurface(memoryStore);
  if (!Sage?.findMemoriesForFile) {
    send(ws, {
      type: 'memory.sage.forFile',
      payload: { error: requiresSage('memory.sage.forFile') },
    });
    return;
  }
  const payload = (msg as { payload: Record<string, unknown> }).payload ?? {};
  const filePath = payload['filePath'] as string | undefined;
  if (!filePath) {
    send(ws, { type: 'memory.sage.forFile', payload: { error: 'filePath is required' } });
    return;
  }
  // The wire request uses the UI-facing `showSuperseded` / `showDeleted`
  // names; the store option names are `includeSuperseded` / `includeDeleted`.
  // Both spellings are accepted so a caller written against either contract
  // gets the filter it asked for instead of silently falling back to the
  // defaults (include superseded, exclude deleted).
  const includeSuperseded =
    typeof payload['showSuperseded'] === 'boolean'
      ? (payload['showSuperseded'] as boolean)
      : typeof payload['includeSuperseded'] === 'boolean'
        ? (payload['includeSuperseded'] as boolean)
        : undefined;
  const includeDeleted = payload['showDeleted'] === true || payload['includeDeleted'] === true;
  try {
    const response = await Sage.findMemoriesForFile(filePath, {
      ...(typeof payload['lineStart'] === 'number'
        ? { lineStart: payload['lineStart'] as number }
        : {}),
      ...(typeof payload['lineEnd'] === 'number' ? { lineEnd: payload['lineEnd'] as number } : {}),
      ...(typeof payload['limit'] === 'number' ? { limit: payload['limit'] as number } : {}),
      ...(includeSuperseded !== undefined ? { includeSuperseded } : {}),
      ...(includeDeleted ? { includeDeleted: true } : {}),
    });
    // The response travels under `payload.response` — the same envelope the
    // error branch below uses (`payload.error`). Sending the bucket object
    // as the payload itself made every client read `payload.response` as
    // `undefined` and render "no memories" for files that had matches.
    send(ws, { type: 'memory.sage.forFile', payload: { response } });
  } catch (err) {
    send(ws, { type: 'memory.sage.forFile', payload: { error: errMessage(err) } });
  }
}
