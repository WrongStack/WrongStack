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
  formatSageMemories,
  formatSageShow,
  formatSageStats,
  formatVerification,
  requiresSage,
} from './memory-formatters.js';
import { runGatherCommand, runPathMemory } from './memory-gather.js';
import { runStats } from './memory-stats.js';
import { runTriageCommand } from './memory-triage.js';

export function buildMemoryCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'memory',
    category: 'Inspect',
    description:
      'Inspect or edit persistent memory: /memory [show|search|file|path|for-file|graph|gather|remember|update|delete|forget|hygiene|verify|candidates|triage|audit|import-legacy|clear|compact|compact-log|stats|audience]',
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
            (value): value is string => !(!value),
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
        default:
          return {
            message: unknownSubcommand(
              cmd,
              [
                'show',
                'search',
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
              ],
              'memory',
            ),
          };
      }
    },
  };
}
