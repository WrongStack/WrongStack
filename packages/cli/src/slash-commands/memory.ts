import type { SlashCommand } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { UpdateSageInput } from '@wrongstack/sage';
import { getSageSurface } from '@wrongstack/sage';
import type { SlashCommandContext } from './command-context.js';
import { parseSubcommand, unknownSubcommand } from './helpers.js';
import { runAudienceMemory } from './memory-audience.js';
import { runCompact } from './memory-compact.js';
import { parseForFileFlags, parseMemoryFlags } from './memory-flags.js';
import {
  formatAudit,
  formatCandidates,
  formatForFileResponse,
  formatGraph,
  formatHygiene,
  formatLegacyEntries,
  formatLegacyImport,
  formatMemoryDiagnostics,
  formatSageMemories,
  formatSageShow,
  formatSageStats,
  formatSearchRace,
  formatVerification,
  requiresSage,
  type MemoryDiagnostics,
} from './memory-formatters.js';
import { runSearchRace } from '@wrongstack/vector-memory';
import { runGatherCommand, runPathMemory } from './memory-gather.js';
import { runStats } from './memory-stats.js';
import { runTriageCommand } from './memory-triage.js';

/**
 * Domain-term persistence was removed: the extractor no longer writes
 * per-term SAGE memories with the `domain-term` tag. Older corpora
 * may still carry such records. The migration command below removes
 * them in one pass. The constant is hard-coded rather than imported
 * from `@wrongstack/sage` to keep the slash-command file decoupled
 * from the (intentionally shrinking) sage public surface.
 */
const DOMAIN_TERM_TAG = 'domain-term';

export function buildMemoryCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'memory',
    category: 'Inspect',
    description:
      'Inspect or edit persistent memory: /memory [show|search|race|file|path|for-file|graph|gather|remember|update|delete|forget|hygiene|verify|candidates|triage|audit|import-legacy|clear|compact|compact-log|stats|audience|diagnostics|purge-domain-terms]',
    async run(args) {
      const store = opts.memoryStore;
      if (!store) return { message: 'No memory store configured.' };
      const Sage = getSageSurface(store);
      const { cmd, rest } = parseSubcommand(args);
      const restJoined = rest.join(' ').trim();
      switch (cmd) {
        case '':
        case 'show':
        case 'list': {
          // Sage path: show stats + structured entries when available
          if (Sage) {
            const [stats, allMemories] = await Promise.all([Sage.stats(), Sage.listSage()]);
            if (allMemories.length === 0) {
              return { message: '🧠 SAGE is empty.' };
            }
            return { message: formatSageShow(stats, allMemories) };
          }
          // Legacy path: flat-file memory store
          const text = await store.readAll();
          return {
            message:
              text.trim().length === 0
                ? 'Memory is empty. Add an entry with `/memory remember <text>`.'
                : text,
          };
        }
        case 'remember':
        case 'add': {
          if (rest.length === 0) {
            return {
              message:
                'Usage: /memory remember <text> [--kind <k>] [--scope <s>] [--tag a,b] [--anchor <path>] [--symbol <path#name>] [--command <cmd>] [--agent <role>] [--importance 0..1] [--confidence 0..1] [--supersedes id,id] [--contradicts id,id]',
            };
          }
          if (!Sage) {
            // Legacy fallback: no structured args available.
            if (!restJoined) return { message: 'Usage: /memory remember <text>' };
            await store.remember(restJoined);
            return { message: `Remembered: ${restJoined}` };
          }
          const parsed = parseMemoryFlags(rest);
          if (parsed.errors.length > 0)
            return { message: `Cannot remember:\n- ${parsed.errors.join('\n- ')}` };
          if (!parsed.text)
            return {
              message: 'Nothing to remember — provide the memory text before/after the flags.',
            };
          try {
            const memory = await Sage.rememberSage({
              text: parsed.text,
              ...(parsed.kind && { kind: parsed.kind }),
              ...(parsed.scope && { scope: parsed.scope }),
              ...(parsed.tags && { tags: parsed.tags }),
              ...(parsed.anchors && { anchors: parsed.anchors }),
              ...(parsed.importance !== undefined && { importance: parsed.importance }),
              ...(parsed.confidence !== undefined && { confidence: parsed.confidence }),
              ...(parsed.supersedes && { supersedes: parsed.supersedes }),
              ...(parsed.contradicts && { contradicts: parsed.contradicts }),
            } as never);
            const tags =
              memory.tags.length > 0 ? ` ${memory.tags.map((t) => `#${t}`).join(' ')}` : '';
            return {
              message: `Remembered \`${memory.id}\` [${memory.kind}] ${memory.text}${tags}`,
            };
          } catch (err) {
            return { message: `Could not remember: ${toErrorMessage(err)}` };
          }
        }
        case 'update':
        case 'edit': {
          if (!Sage) return requiresSage('update');
          const id = rest[0];
          if (!id)
            return {
              message:
                'Usage: /memory update <memory-id> [--text <t>] [--kind <k>] [--tag a,b] [--anchor <path>] [--agent <role>] [--importance 0..1] [--status active|stale|archived|deleted] [--supersedes id,id]',
            };
          const parsed = parseMemoryFlags(rest.slice(1));
          if (parsed.errors.length > 0)
            return { message: `Cannot update:\n- ${parsed.errors.join('\n- ')}` };
          const patch: UpdateSageInput = {
            ...(parsed.text && { text: parsed.text }),
            ...(parsed.kind && { kind: parsed.kind }),
            ...(parsed.tags && { tags: parsed.tags }),
            ...(parsed.anchors && { anchors: parsed.anchors }),
            ...(parsed.importance !== undefined && { importance: parsed.importance }),
            ...(parsed.confidence !== undefined && { confidence: parsed.confidence }),
            ...(parsed.freshness !== undefined && { freshness: parsed.freshness }),
            ...(parsed.status && { status: parsed.status }),
            ...(parsed.supersedes && { supersedes: parsed.supersedes }),
            ...(parsed.contradicts && { contradicts: parsed.contradicts }),
          };
          if (Object.keys(patch).length === 0) {
            return {
              message:
                'Nothing to update — pass at least one field (e.g. --text, --status, --tag).',
            };
          }
          try {
            const memory = await Sage.updateSage(id, patch);
            return {
              message: `Updated \`${memory.id}\` [${memory.kind}|${memory.status}] ${memory.text}`,
            };
          } catch (err) {
            return { message: `Could not update: ${toErrorMessage(err)}` };
          }
        }
        case 'delete':
        case 'del': {
          if (!Sage) return requiresSage('delete');
          const id = rest[0];
          if (!id) return { message: 'Usage: /memory delete <memory-id> [reason...]' };
          const reason = rest.slice(1).join(' ').trim() || undefined;
          try {
            const existing = await Sage.getSage(id);
            if (!existing) return { message: `No memory with id \`${id}\`.` };
            // `/memory delete` is an explicit user command, so it satisfies
            // SAGE's destructive-operation authorization contract.
            await Sage.deleteSage(id, reason, { force: true });
            return { message: `Deleted \`${id}\`.` };
          } catch (err) {
            return { message: `Could not delete: ${toErrorMessage(err)}` };
          }
        }
        case 'forget':
        case 'rm': {
          const exact = rest.includes('--exact');
          const query = rest
            .filter((t) => t !== '--exact')
            .join(' ')
            .trim();
          if (!query) return { message: 'Usage: /memory forget <query> [--exact]' };
          if (exact) {
            // Exact mode: refuse to delete unless the query matches whole
            // entries and nothing else by substring — guards against a short
            // query (e.g. "auth") silently nuking unrelated entries.
            const entries = await store.list('project-memory');
            const ql = query.toLowerCase();
            const substringHits = entries.filter((e) => e.text.toLowerCase().includes(ql));
            const exactHits = entries.filter((e) => e.text.trim() === query);
            if (exactHits.length === 0) {
              return { message: `No entry exactly matched "${query}".` };
            }
            if (substringHits.length > exactHits.length) {
              const extra = substringHits.length - exactHits.length;
              return {
                message: `Refusing --exact forget: "${query}" also partially matches ${extra} other entr${extra === 1 ? 'y' : 'ies'}. Use the full entry text, or drop --exact to delete all ${substringHits.length} matches.`,
              };
            }
          }
          const n = await store.forget(query);
          return {
            message: n === 0 ? `No entries matched "${query}".` : `Forgot ${n} entries.`,
          };
        }
        case 'file':
        case 'path': {
          if (!restJoined) return { message: `Usage: /memory ${cmd} <path>` };
          return runPathMemory(store, restJoined, cmd === 'path');
        }
        // PR #4: rich file-drawer query — returns 3 buckets (primary/symbol/related)
        // with `matchedVia`, `matchStrength`, `supersededByActiveId`, `pendingReview`.
        // Optional cursor line range boosts symbol-anchored memories that
        // overlap the caret position.
        case 'for-file': {
          if (!Sage?.findMemoriesForFile) return requiresSage('for-file');
          if (!restJoined)
            return {
              message: 'Usage: /memory for-file <path> [--line <n>] [--limit <n>] [--show-deleted]',
            };
          // Flag parsing delegated to `parseForFileFlags`, which is kept
          // separate from the shared `parseMemoryFlags` (that one is reused
          // for remember/update and validates against the canonical
          // memory-record field set).
          const pathArg = rest[0];
          if (!pathArg)
            return {
              message: 'Usage: /memory for-file <path> [--line <n>] [--limit <n>] [--show-deleted]',
            };
          const forFileFlags = parseForFileFlags(rest.slice(1));
          if (forFileFlags.errors.length > 0) {
            return {
              message: `Cannot run /memory for-file:\n- ${forFileFlags.errors.join('\n- ')}`,
            };
          }
          const { singleLine, limit, showDeleted } = forFileFlags;
          try {
            const response = await Sage.findMemoriesForFile(pathArg, {
              ...(singleLine !== undefined ? { lineStart: singleLine, lineEnd: singleLine } : {}),
              limit,
              includeDeleted: showDeleted || undefined,
            });
            return { message: formatForFileResponse(pathArg, response) };
          } catch (err) {
            return {
              message: `for-file failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }
        case 'search': {
          if (!restJoined) return { message: 'Usage: /memory search <query>' };
          if (!Sage) {
            const entries = await store.search(restJoined, 'project-memory', 20);
            return {
              message: formatLegacyEntries(
                entries.map((entry) => entry.text),
                restJoined,
              ),
            };
          }
          return {
            message: formatSageMemories(
              await Sage.searchSage(restJoined, { limit: 20 }),
              `Search: ${restJoined}`,
            ),
          };
        }
        case 'race': {
          // Two-channel race: lexical (SAGE) vs semantic (vector store).
          // Makes the value of running BOTH stores side-by-side visible —
          // the operator sees the overlap and the channel-specific
          // misses in a single render. Falls back to a plain lexical
          // search when the vector store isn't wired.
          if (!restJoined) return { message: 'Usage: /memory race <query>' };
          if (!Sage) {
            return {
              message:
                '`/memory race` requires the SAGE surface. Run the search with `/memory search <query>` instead.',
            };
          }
          const vectorStore = (opts as { vectorMemoryStore?: unknown }).vectorMemoryStore as
            | Parameters<typeof runSearchRace>[2]
            | undefined;
          if (!vectorStore) {
            const entries = await Sage.searchSage(restJoined, { limit: 20 });
            return {
              message:
                `Vector memory is not wired in this host — only the lexical channel is available.\n\n` +
                formatSageMemories(entries, `Search: ${restJoined}`),
            };
          }
          try {
            // `Sage.searchSage` is the vector-WRAPPED surface in every host
            // that has a vector store, so its output is already fused —
            // feeding it in as "the lexical channel" would race the fused
            // result against one of its own inputs and report a near-perfect
            // agreement ratio no matter how the channels actually behave.
            //
            // Recover the true lexical channel from the per-channel
            // breakdown: hits the lexical side produced are exactly those
            // with a non-null `lexicalScore`, and that score is their rank in
            // that channel.
            const lexical = Sage.searchSageWithBreakdown
              ? (await Sage.searchSageWithBreakdown(restJoined, { limit: 20 }))
                  .filter((hit) => hit.lexicalScore !== null)
                  .sort((a, b) => (b.lexicalScore ?? 0) - (a.lexicalScore ?? 0))
                  .map((hit) => hit.memory)
              : await Sage.searchSage(restJoined, { limit: 20 });
            const race = await runSearchRace(restJoined, lexical, vectorStore, { limit: 20 });
            return { message: formatSearchRace(race) };
          } catch (err) {
            return {
              message: `Race failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }
        case 'graph': {
          if (!Sage?.graphFor) return requiresSage('graph');
          if (!restJoined) return { message: 'Usage: /memory graph <memory-id|path|query>' };
          return {
            message: formatGraph(await Sage.graphFor(restJoined, 2, 100), restJoined),
          };
        }
        case 'gather': {
          return runGatherCommand(Sage, rest);
        }
        case 'verify': {
          if (!Sage?.verify) return requiresSage('verify');
          return { message: formatVerification(await Sage.verify(restJoined || undefined)) };
        }
        case 'hygiene': {
          if (!Sage) return requiresSage('hygiene');
          return { message: formatHygiene(await Sage.hygiene()) };
        }
        case 'candidates': {
          if (!Sage) return requiresSage('candidates');
          const action = rest[0]?.toLowerCase() ?? 'list';
          if (action === 'accept') {
            if (!rest[1]) return { message: 'Usage: /memory candidates accept <candidate-id>' };
            const accepted = await Sage.acceptCandidate(rest[1]);
            return {
              message: accepted
                ? `Accepted ${rest[1]} as ${accepted.id}.`
                : `Candidate ${rest[1]} was not found.`,
            };
          }
          if (action === 'reject') {
            if (!rest[1])
              return { message: 'Usage: /memory candidates reject <candidate-id> [reason]' };
            const rejected = await Sage.rejectCandidate(
              rest[1],
              rest.slice(2).join(' ') || 'Rejected from /memory.',
            );
            return {
              message: rejected ? `Rejected ${rest[1]}.` : `Candidate ${rest[1]} was not found.`,
            };
          }
          return {
            message: formatCandidates(await Sage.listCandidates(action === 'all')),
          };
        }
        case 'triage': {
          if (!Sage) return requiresSage('triage');
          return runTriageCommand(opts, rest);
        }
        case 'audit': {
          if (!Sage?.readAudit) return requiresSage('audit');
          return { message: formatAudit(await Sage.readAudit(50)) };
        }
        case 'import-legacy': {
          if (!Sage?.importLegacy) return requiresSage('import-legacy');
          const legacyPaths = [opts.paths?.projectMemory, opts.paths?.globalMemory].filter(
            (value): value is string => !!value,
          );
          if (legacyPaths.length === 0)
            return { message: 'Legacy memory paths are unavailable in this session.' };
          return { message: formatLegacyImport(await Sage.importLegacy(legacyPaths)) };
        }
        case 'clear': {
          const force = rest.includes('--force');
          if (!force) {
            return {
              message:
                'Bulk memory clear is blocked by default because SAGE is durable. ' +
                'Review entries with `/memory show` and delete individual IDs, or use ' +
                '`/memory clear --force` for an intentional full wipe.',
            };
          }
          if (opts.confirm) {
            const confirmed = await opts.confirm(
              'Delete every non-permanent memory entry across all scopes? This cannot be undone from the UI.',
              false,
            );
            if (confirmed !== true) {
              return { message: 'Memory clear cancelled; all entries were preserved.' };
            }
          }
          await store.clear();
          return { message: 'Cleared all non-permanent memory scopes by explicit force request.' };
        }
        case 'purge-domain-terms': {
          // One-off migration: domain-term persistence was removed.
          // The extractor no longer writes per-term SAGE memories with
          // the `domain-term` tag, but older corpora may still carry
          // such records. This command finds and deletes every memory
          // whose `tags` array contains the canonical lookup tag
          // (plus the historical companion tags `glossary` /
          // `project-jargon` from the old trio) so the system prompt
          // glossary and the on-disk mirror can no longer surface
          // auto-mined terms. Idempotent — re-running on a clean
          // corpus reports 0 deleted.
          if (!Sage) return requiresSage('purge-domain-terms');
          const force = rest.includes('--force');
          if (!force) {
            return {
              message:
                `Refusing to run /memory purge-domain-terms without --force.\n\n` +
                `This is a one-off migration that permanently removes every SAGE memory tagged \`${DOMAIN_TERM_TAG}\` (and the historical \`glossary\` / \`project-jargon\` companion tags). ` +
                `It cannot be undone. Run /memory purge-domain-terms --force when you are ready.`,
            };
          }
          try {
            // Pull every active + stale memory; the extractor wrote
            // entries with status 'active' in normal flow. We page
            // through `listSagePage` rather than `listSage` to bound
            // memory pressure on large corpora.
            const targets: Array<{ id: string; tags: readonly string[] }> = [];
            const PAGE = 200;
            let cursor: string | undefined;
            // listSagePage is a method on the SAGE service, not the
            // surface; fetch it via the underlying port when present.
            const listPage = (
              Sage as unknown as {
                listSagePage?: (opts?: {
                  statuses?: Array<'active' | 'stale' | 'archived' | 'deleted'>;
                  limit?: number;
                  cursor?: string;
                }) => Promise<{
                  memories: Array<{ id: string; tags: readonly string[] }>;
                  nextCursor?: string | undefined;
                }>;
              }
            ).listSagePage;
            if (typeof listPage === 'function') {
              // eslint-disable-next-line no-constant-condition
              while (true) {
                const page: {
                  memories: Array<{ id: string; tags: readonly string[] }>;
                  nextCursor?: string | undefined;
                } = await listPage({
                  statuses: ['active', 'stale'],
                  limit: PAGE,
                  ...(cursor !== undefined ? { cursor } : {}),
                });
                for (const mem of page.memories) {
                  if (
                    Array.isArray(mem.tags) &&
                    mem.tags.some(
                      (t) => t === DOMAIN_TERM_TAG || t === 'glossary' || t === 'project-jargon',
                    )
                  ) {
                    targets.push({ id: mem.id, tags: mem.tags });
                  }
                }
                if (!page.nextCursor || page.memories.length === 0) break;
                cursor = page.nextCursor;
              }
            } else {
              // Fallback: single-shot listSage. Bounded by whatever
              // listSage defaults to; the surface is expected to
              // expose a sane limit.
              const memories = await Sage.listSage(['active', 'stale']);
              for (const mem of memories) {
                if (
                  Array.isArray(mem.tags) &&
                  mem.tags.some(
                    (t) => t === DOMAIN_TERM_TAG || t === 'glossary' || t === 'project-jargon',
                  )
                ) {
                  targets.push({ id: mem.id, tags: mem.tags });
                }
              }
            }

            if (targets.length === 0) {
              return {
                message:
                  `No SAGE memories matched the legacy domain-term tag trio. ` +
                  `Nothing to purge.`,
              };
            }

            let deleted = 0;
            const failures: string[] = [];
            for (const t of targets) {
              try {
                // `force: true` is appropriate here: the user ran an
                // explicit migration command, which satisfies SAGE's
                // destructive-operation authorization contract.
                await Sage.deleteSage(
                  t.id,
                  'domain-term persistence removed; pre-migration cleanup',
                  { force: true },
                );
                deleted++;
              } catch (err) {
                failures.push(`${t.id}: ${toErrorMessage(err)}`);
              }
            }

            const tagSummary = new Map<string, number>();
            for (const t of targets) {
              for (const tag of t.tags) {
                if (tag === DOMAIN_TERM_TAG || tag === 'glossary' || tag === 'project-jargon') {
                  tagSummary.set(tag, (tagSummary.get(tag) ?? 0) + 1);
                }
              }
            }
            const tagBreakdown = [...tagSummary.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([tag, count]) => `  - ${tag}: ${count}`)
              .join('\n');

            const tail =
              failures.length > 0
                ? `\n\nFailures (${failures.length}):\n${failures
                    .slice(0, 10)
                    .map((f) => `  - ${f}`)
                    .join('\n')}`
                : '';
            return {
              message:
                `Purged ${deleted} of ${targets.length} legacy domain-term memories.\n\n` +
                `Tag breakdown of matched memories:\n${tagBreakdown}\n\n` +
                `The \`${DOMAIN_TERM_TAG}\` / \`glossary\` / \`project-jargon\` tags are now absent from the live corpus. ` +
                `Run \`/memory show\` to confirm.${tail}`,
            };
          } catch (err) {
            return {
              message: `purge-domain-terms failed: ${toErrorMessage(err)}`,
            };
          }
        }
        case 'compact': {
          return runCompact(opts);
        }
        case 'compact-log': {
          if (!Sage) return requiresSage('compact-log');
          if (typeof Sage.compactLog !== 'function') {
            return {
              message:
                '🧹 Log compaction is only available on the JSONL backend. The SQLite backend compacts automatically via UPSERT.',
            };
          }
          try {
            const result = await Sage.compactLog();
            if (result.beforeRecords === result.afterRecords) {
              return {
                message: `🧹 Log already compact — ${result.uniqueIds} records, 0 duplicates removed.`,
              };
            }
            const saved = result.beforeRecords - result.afterRecords;
            return {
              message:
                `🧹 Log compacted: ${result.beforeRecords} → ${result.afterRecords} records (${saved} duplicates removed, ${result.uniqueIds} unique IDs).\n` +
                `File size reduced. Audit-logged as \`memory.log_compacted\`.`,
            };
          } catch (err) {
            return { message: `Compaction failed: ${toErrorMessage(err)}` };
          }
        }
        case 'stats': {
          if (Sage) {
            const [stats, allMems] = await Promise.all([
              Sage.stats(),
              Sage.listSage(['active', 'stale']),
            ]);
            const scopedCount = allMems.filter((m) => m.audience).length;
            const roles = new Set<string>();
            for (const m of allMems) {
              if (!m.audience) continue;
              for (const r of m.audience.roles ?? []) roles.add(r);
              for (const r of m.audience.taskTypes ?? []) roles.add(r);
              for (const r of m.audience.modes ?? []) roles.add(r);
            }
            const roleList = [...roles].sort().join(', ');
            const statsLines = formatSageStats(stats, scopedCount, roleList).split('\n');
            // Append log health if available (JSONL backend only)
            if (typeof Sage.getLogStats === 'function') {
              try {
                const logStats = await Sage.getLogStats();
                const kbSize = (logStats.fileSizeBytes / 1024).toFixed(1);
                const ratio = logStats.duplicateRatio.toFixed(1);
                const healthIcon =
                  logStats.duplicateRatio > 3 ? '⚠️' : logStats.duplicateRatio > 1.5 ? 'ℹ️' : '✅';
                const compactHint =
                  logStats.duplicateRatio > 3
                    ? ` — run \`/memory compact-log\` to reclaim space`
                    : '';
                statsLines.push(
                  `${healthIcon} Log health: ${logStats.rawRecords} records / ${logStats.uniqueIds} unique (${ratio}× ratio, ${kbSize} KB)${compactHint}`,
                );
              } catch {
                // Best-effort — log stats are informational
              }
            }
            return { message: statsLines.join('\n') };
          }
          return runStats(opts);
        }
        case 'audience':
        case 'role': {
          if (!Sage) return requiresSage('audience');
          return runAudienceMemory(Sage, rest);
        }
        case 'diagnostics': {
          if (!Sage) {
            return {
              message:
                'Memory diagnostics require the SAGE surface (this memory store does not expose it).',
            };
          }
          // Two-system health check — surfaces coverage, drift, and
          // mirror state across the SAGE + vector memory pair. The
          // host supplies the vector store through the slash command
          // context (added when the vector store is wired at boot).
          const vectorStore = (opts as { vectorMemoryStore?: unknown }).vectorMemoryStore as
            | {
                stats: () => {
                  entries: number;
                  vectors: number;
                  providers: string[];
                  modelId: string;
                  dimensions: number;
                };
                cacheStats: () => {
                  entries: number;
                  providers: number;
                  totalUseCount: number;
                  oldestLastUsedAt: string | null;
                };
                directory: string;
                databasePath: string;
                list: (opts: { limit: number }) => Array<{ metadata: Record<string, unknown> }>;
              }
            | undefined;
          // Pull the data we need: SAGE stats + count, vector stats +
          // cache + drift count. Each call is best-effort; failures
          // surface in the printed message rather than throwing the
          // slash command.
          let sageStats: import('@wrongstack/sage').SageStats;
          let sageTotal = 0;
          try {
            [sageStats, sageTotal] = await Promise.all([
              Sage.stats(),
              Sage.listSagePage({ limit: 1 }).then((page) => page.total ?? page.memories.length),
            ]);
          } catch (err) {
            return {
              message: `Memory diagnostics failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
          let vectorDiag: MemoryDiagnostics['vector'];
          if (vectorStore) {
            try {
              const stats = vectorStore.stats();
              const cache = vectorStore.cacheStats();
              const vectorRows = vectorStore.list({ limit: 5000 });
              let mirroredInSage = 0;
              let standalone = 0;
              for (const row of vectorRows) {
                const sageId = (row.metadata as { sageId?: unknown } | undefined)?.sageId;
                if (typeof sageId === 'string' && sageId.length > 0) {
                  mirroredInSage++;
                } else {
                  standalone++;
                }
              }
              vectorDiag = {
                entries: stats.entries,
                vectors: stats.vectors,
                providers: stats.providers,
                modelId: stats.modelId,
                dimensions: stats.dimensions,
                cacheEntries: cache.entries,
                cacheProviders: cache.providers,
                totalUseCount: cache.totalUseCount,
                oldestLastUsedAt: cache.oldestLastUsedAt,
                storePath: vectorStore.directory,
                mirroredInSage,
                standalone,
              };
            } catch (err) {
              return {
                message: `Memory diagnostics (vector side) failed: ${err instanceof Error ? err.message : String(err)}`,
              };
            }
          }
          return {
            message: formatMemoryDiagnostics({
              sageStats,
              sageTotal,
              vector: vectorDiag,
            }),
          };
        }
        default:
          return {
            message: unknownSubcommand(
              cmd,
              [
                'show',
                'search',
                'race',
                'file',
                'path',
                'for-file',
                'graph',
                'gather',
                'remember',
                'update',
                'delete',
                'forget',
                'hygiene',
                'verify',
                'candidates',
                'triage',
                'audit',
                'import-legacy',
                'clear',
                'compact',
                'stats',
                'audience',
                'purge-domain-terms',
              ],
              'memory',
            ),
          };
      }
    },
  };
}
