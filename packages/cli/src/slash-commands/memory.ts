import type { SlashCommand } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import type {
  MemoryAudienceSelector,
  SageSurface,
  UpdateSageInput,
} from '@wrongstack/sage';
import { getSageSurface } from '@wrongstack/sage';
import type { SlashCommandContext } from './command-context.js';
import { parseSubcommand, unknownSubcommand } from './helpers.js';
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
import { parseForFileFlags, parseMemoryFlags } from './memory-flags.js';

export function buildMemoryCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'memory',
    category: 'Inspect',
    description:
      'Inspect or edit persistent memory: /memory [show|search|file|path|for-file|graph|remember|update|delete|forget|hygiene|verify|candidates|audit|import-legacy|clear|compact|compact-log|stats|audience]',
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
            const [stats, allMemories] = await Promise.all([
              Sage.stats(),
              Sage.listSage(),
            ]);
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
                'graph',
                'remember',
                'update',
                'delete',
                'forget',
                'hygiene',
                'verify',
                'candidates',
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

async function runPathMemory(
  store: NonNullable<SlashCommandContext['memoryStore']>,
  targetPath: string,
  includeAncestors: boolean,
): Promise<{ message: string }> {
  const Sage = getSageSurface(store);
  if (!Sage) {
    return {
      message:
        '`/memory file` requires the SAGE backend. Enable `Sage.enabled` and restart the session.',
    };
  }
  const memories = await Sage.retrieveForPath({
    path: targetPath,
    limit: 20,
    includeAncestors,
  });
  if (memories.length === 0) {
    return { message: `No SAGE entries are attached to ${targetPath}.` };
  }
  const lines = [`## SAGE for ${targetPath}`];
  for (const memory of memories) {
    const tags = memory.tags.length > 0 ? ` ${memory.tags.map((tag) => `#${tag}`).join(' ')}` : '';
    const anchor = memory.anchors.find((a) => a.path || a.symbol || a.command);
    const anchorText = anchor
      ? `\n  anchor: ${anchor.path ?? anchor.symbol ?? anchor.command}`
      : '';
    lines.push(`- [${memory.kind}|${memory.status}] ${memory.text}${tags}${anchorText}`);
  }
  return { message: lines.join('\n') };
}

// ── /memory audience — view and manage role-scoped memories ──────────

interface ParsedAudienceFlags {
  roles?: string[];
  taskTypes?: string[];
  modes?: string[];
  errors: string[];
}

function parseAudienceFlags(tokens: string[]): ParsedAudienceFlags {
  const out: ParsedAudienceFlags = { errors: [] };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    if (!token.startsWith('--')) continue;
    const name = token.slice(2).toLowerCase();
    const value = tokens[i + 1];
    if (!value || value.startsWith('--')) {
      out.errors.push(`--${name} needs a value.`);
      continue;
    }
    i++;
    const csv = value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    switch (name) {
      case 'role':
      case 'roles':
        out.roles = [...(out.roles ?? []), ...csv];
        break;
      case 'task-type':
      case 'task-types':
      case 'tasktype':
      case 'tasktypes':
        out.taskTypes = [...(out.taskTypes ?? []), ...csv];
        break;
      case 'mode':
      case 'modes':
        out.modes = [...(out.modes ?? []), ...csv];
        break;
      default:
        out.errors.push(`Unknown audience flag "--${name}".`);
    }
  }
  return out;
}

function hasAudienceSelector(parsed: ParsedAudienceFlags): boolean {
  return !!(parsed.roles?.length || parsed.taskTypes?.length || parsed.modes?.length);
}

function formatAudienceSelector(audience: MemoryAudienceSelector): string {
  const parts: string[] = [];
  if (audience.roles?.length) parts.push(`roles: ${audience.roles.join(', ')}`);
  if (audience.taskTypes?.length) parts.push(`taskTypes: ${audience.taskTypes.join(', ')}`);
  if (audience.modes?.length) parts.push(`modes: ${audience.modes.join(', ')}`);
  return parts.join(' · ');
}

async function runAudienceMemory(
  store: SageSurface,
  rest: string[],
): Promise<{ message: string }> {
  const sub = rest[0]?.toLowerCase() ?? 'list';

  // /memory audience list [--role <r>] [--task-type <t>] [--mode <m>]
  if (sub === 'list' || sub === 'show' || sub === 'ls') {
    const flags = parseAudienceFlags(rest.slice(1));
    if (flags.errors.length > 0) {
      return { message: `Cannot parse audience flags:\n- ${flags.errors.join('\n- ')}` };
    }
    if (hasAudienceSelector(flags)) {
      const matches = await store.retrieveForAudience(
        {
          ...(flags.roles ? { role: flags.roles[0] } : {}),
          ...(flags.taskTypes ? { taskType: flags.taskTypes[0] } : {}),
          ...(flags.modes ? { mode: flags.modes[0] } : {}),
        },
        50,
      );
      if (matches.length === 0)
        return { message: 'No audience-scoped memories match the given selectors.' };
      const lines = ['## Audience-Scoped Memory — Matching', ''];
      for (const mem of matches) {
        const aud = mem.audience ? ` (${formatAudienceSelector(mem.audience)})` : '';
        lines.push(`- \`${mem.id}\` [${mem.kind}|${mem.status}] ${mem.text}${aud}`);
      }
      return { message: lines.join('\n') };
    }
    // No selectors: list ALL audience-scoped memories
    const all = await store.listSage(['active', 'stale']);
    const scoped = all.filter((m) => m.audience);
    if (scoped.length === 0) {
      return {
        message:
          'No audience-scoped memories. Add one with `/memory audience remember --role <r> <text>`.',
      };
    }
    const lines = ['## Audience-Scoped Memory', ''];
    for (const mem of scoped) {
      const aud = mem.audience ? ` (${formatAudienceSelector(mem.audience)})` : '';
      lines.push(`- \`${mem.id}\` [${mem.kind}|${mem.status}] ${mem.text}${aud}`);
    }
    return { message: lines.join('\n') };
  }

  // /memory audience remember --role <r> [--task-type <t>] [--mode <m>] <text>
  if (sub === 'remember' || sub === 'add') {
    const flags = parseAudienceFlags(rest.slice(1));
    if (flags.errors.length > 0) {
      return { message: `Cannot remember:\n- ${flags.errors.join('\n- ')}` };
    }
    if (!hasAudienceSelector(flags)) {
      return {
        message:
          'Usage: /memory audience remember --role <role> [--task-type <t>] [--mode <m>] <text>\nAt least one of --role, --task-type, or --mode is required.',
      };
    }
    // Extract text: tokens after the flags
    const words: string[] = [];
    const flagSet = new Set([
      '--role',
      '--roles',
      '--task-type',
      '--task-types',
      '--tasktype',
      '--tasktypes',
      '--mode',
      '--modes',
    ]);
    for (let i = 1; i < rest.length; i++) {
      const token = rest[i] ?? '';
      if (token.startsWith('--')) {
        if (flagSet.has(token.toLowerCase())) i++; // skip value
        continue;
      }
      words.push(token);
    }
    const text = words.join(' ').trim();
    if (!text) {
      return { message: 'Nothing to remember — provide the memory text after the flags.' };
    }
    try {
      const audience: MemoryAudienceSelector = {};
      if (flags.roles?.length) audience.roles = flags.roles;
      if (flags.taskTypes?.length) audience.taskTypes = flags.taskTypes;
      if (flags.modes?.length) audience.modes = flags.modes;
      const memory = await store.rememberSage({ text, audience });
      return {
        message: `Remembered \`${memory.id}\` for ${formatAudienceSelector(memory.audience!)}: ${memory.text}`,
      };
    } catch (err) {
      return { message: `Could not remember: ${toErrorMessage(err)}` };
    }
  }

  // /memory audience clear <memory-id>
  if (sub === 'clear') {
    const id = rest[1];
    if (!id) return { message: 'Usage: /memory audience clear <memory-id>' };
    try {
      await store.updateSage(id, { audience: {} });
      return {
        message: `Cleared audience scope from \`${id}\` — it is now general project memory.`,
      };
    } catch (err) {
      return { message: `Could not clear audience: ${toErrorMessage(err)}` };
    }
  }

  // /memory audience search <query>
  // Searches audience-scoped memories by partial text/role/mode match.
  // Unlike `list`, this does substring matching against the memory text
  // and all audience selector values, not exact retrieveForAudience.
  if (sub === 'search' || sub === 'find') {
    const query = rest.slice(1).join(' ').trim().toLowerCase();
    if (!query) return { message: 'Usage: /memory audience search <query>' };
    const all = await store.listSage(['active', 'stale']);
    const scoped = all.filter((m) => m.audience);
    const matches = scoped.filter((m) => {
      const haystack = [
        m.text,
        m.audience?.roles?.join(' ') ?? '',
        m.audience?.taskTypes?.join(' ') ?? '',
        m.audience?.modes?.join(' ') ?? '',
        m.tags.join(' '),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
    if (matches.length === 0) return { message: `No audience-scoped memories match "${query}".` };
    const lines = [`## Audience-Scoped Memory — Search: "${query}"`, ''];
    for (const mem of matches) {
      const aud = mem.audience ? ` (${formatAudienceSelector(mem.audience)})` : '';
      lines.push(`- \`${mem.id}\` [${mem.kind}|${mem.status}] ${mem.text}${aud}`);
    }
    return { message: lines.join('\n') };
  }

  // /memory audience transfer <from-role> <to-role>
  // Re-scopes all memories targeting <from-role> to <to-role> instead.
  if (sub === 'transfer' || sub === 'reassign') {
    const fromRole = rest[1]?.toLowerCase();
    const toRole = rest[2]?.toLowerCase();
    if (!fromRole || !toRole) {
      return { message: 'Usage: /memory audience transfer <from-role> <to-role>' };
    }
    const all = await store.listSage(['active', 'stale']);
    const toUpdate = all.filter((m) =>
      m.audience?.roles?.some((r) => r.toLowerCase() === fromRole),
    );
    if (toUpdate.length === 0) {
      return { message: `No audience-scoped memories found for role "${fromRole}".` };
    }
    let updated = 0;
    for (const mem of toUpdate) {
      const roles = (mem.audience!.roles ?? []).map((r) =>
        r.toLowerCase() === fromRole ? toRole : r,
      );
      const deduped = [...new Set(roles)];
      try {
        await store.updateSage(mem.id, {
          audience: {
            roles: deduped,
            ...(mem.audience!.taskTypes?.length ? { taskTypes: mem.audience!.taskTypes } : {}),
            ...(mem.audience!.modes?.length ? { modes: mem.audience!.modes } : {}),
          },
        });
        updated++;
      } catch {
        // continue on per-memory errors
      }
    }
    return {
      message:
        updated === 0
          ? `Failed to transfer any memories from "${fromRole}" to "${toRole}".`
          : `Transferred ${updated} memor${updated === 1 ? 'y' : 'ies'} from role "${fromRole}" to "${toRole}".`,
    };
  }

  // /memory audience export [--role <r>] [--task-type <t>] [--mode <m>]
  // Dumps matching audience-scoped memories as JSON for sharing/backup.
  if (sub === 'export' || sub === 'dump') {
    const flags = parseAudienceFlags(rest.slice(1));
    if (flags.errors.length > 0) {
      return { message: `Cannot parse audience flags:\n- ${flags.errors.join('\n- ')}` };
    }
    const all = await store.listSage(['active', 'stale']);
    let scoped = all.filter((m) => m.audience);
    if (hasAudienceSelector(flags)) {
      const roleMatch = flags.roles?.[0]?.toLowerCase();
      const taskMatch = flags.taskTypes?.[0]?.toLowerCase();
      const modeMatch = flags.modes?.[0]?.toLowerCase();
      scoped = scoped.filter((m) => {
        if (roleMatch && !(m.audience?.roles ?? []).some((r) => r.toLowerCase() === roleMatch))
          return false;
        if (taskMatch && !(m.audience?.taskTypes ?? []).some((r) => r.toLowerCase() === taskMatch))
          return false;
        if (modeMatch && !(m.audience?.modes ?? []).some((r) => r.toLowerCase() === modeMatch))
          return false;
        return true;
      });
    }
    if (scoped.length === 0) {
      return { message: 'No audience-scoped memories to export.' };
    }
    const exportData = scoped.map((m) => ({
      id: m.id,
      text: m.text,
      kind: m.kind,
      status: m.status,
      audience: m.audience,
      tags: m.tags,
      importance: m.importance,
      confidence: m.confidence,
    }));
    return {
      message: '```json\n' + JSON.stringify(exportData, null, 2) + '\n```',
    };
  }

  // /memory audience import <json-array>
  // Loads exported memories from JSON into this project's store.
  if (sub === 'import' || sub === 'load') {
    const jsonText = rest.slice(1).join(' ').trim();
    if (!jsonText) {
      return {
        message:
          'Usage: /memory audience import <json-array>\nPaste the JSON output from `/memory audience export`.',
      };
    }
    let entries: Array<{
      text?: unknown;
      kind?: unknown;
      status?: unknown;
      audience?: unknown;
      tags?: unknown;
      importance?: unknown;
      confidence?: unknown;
    }>;
    try {
      const cleaned = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      entries = JSON.parse(cleaned);
    } catch {
      return { message: 'Invalid JSON. Paste the output from `/memory audience export`.' };
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      return { message: 'No entries found in the JSON.' };
    }
    let imported = 0;
    let skipped = 0;
    for (const entry of entries) {
      if (typeof entry.text !== 'string' || !entry.text.trim()) {
        skipped++;
        continue;
      }
      try {
        await store.rememberSage({
          text: entry.text,
          ...(typeof entry.kind === 'string' ? { kind: entry.kind as never } : {}),
          ...(Array.isArray(entry.tags) ? { tags: entry.tags as string[] } : {}),
          ...(entry.audience && typeof entry.audience === 'object'
            ? { audience: entry.audience as never }
            : {}),
          ...(typeof entry.importance === 'number' ? { importance: entry.importance } : {}),
          ...(typeof entry.confidence === 'number' ? { confidence: entry.confidence } : {}),
        });
        imported++;
      } catch {
        skipped++;
      }
    }
    return {
      message:
        imported === 0
          ? 'No memories imported — all entries were invalid.'
          : `Imported ${imported} memor${imported === 1 ? 'y' : 'ies'}${skipped > 0 ? `, skipped ${skipped}` : ''}.`,
    };
  }

  return {
    message: [
      '## /memory audience',
      '',
      '`/memory audience list [--role <r>] [--task-type <t>] [--mode <m>]` — view scoped memories',
      '`/memory audience remember --role <r> [--task-type <t>] [--mode <m>] <text>` — add a scoped memory',
      '`/memory audience search <query>` — search scoped memories by partial text/role/mode',
      '`/memory audience transfer <from-role> <to-role>` — bulk re-scope memories from one role to another',
      '`/memory audience export [--role <r>]` — dump scoped memories as JSON',
      '`/memory audience import <json-array>` — load exported memories from JSON',
      '`/memory audience clear <memory-id>` — remove scope (becomes general memory)',
    ].join('\n'),
  };
}

// ── /memory compact — LLM-driven memory review and optimization ────────

interface CompactOperation {
  action: 'keep' | 'rewrite' | 'merge' | 'delete';
  /** For rewrite/merge/delete: the memory entry IDs or search queries to match. */
  targets: string[];
  /** For rewrite/merge: the new text. For keep: unused. */
  newText?: string | undefined;
  /** Reason for the operation — shown in the summary. */
  reason: string;
}

interface CompactResponse {
  operations: CompactOperation[];
  /** Optional summary of what was done. */
  summary?: string | undefined;
}

/**
 * System prompt template for the memory compact LLM call.
 * `__ENTRIES__` is replaced with the formatted entry list at call time.
 * Kept as a module-level constant so the prompt text can be reviewed and
 * iterated on independently of the call logic.
 */
const COMPACT_SYSTEM_PROMPT = `You are a memory curator. Your task is to review, deduplicate, and improve a set of long-term memory entries.

These entries are injected into the context of an AI coding agent. Every token counts. The memory must be concise, accurate, and free of noise.

## Current Memory Entries

__ENTRIES__

## Your Task

Review each entry and return a JSON object with an "operations" array. Each operation targets one or more entries:

### Actions

- **"keep"** — The entry is valuable as-is. Include it in the operations so I know you reviewed it.
- **"rewrite"** — The entry has value but needs better wording. Provide improved "newText". Target a single entry.
- **"merge"** — Two or more entries say essentially the same thing. Combine them into one concise entry. The "targets" should list all entries being merged. Provide the combined "newText".
- **"delete"** — The entry is obsolete, redundant, too vague, or not useful for future sessions. Target one or more entries.

### Rules

1. **Be ruthless about noise.** If an entry won't help a future AI agent do its job better, delete it.
2. **Deduplicate aggressively.** Similar entries should be merged. Identical entries MUST be merged.
3. **Keep entries concise.** Each entry should be one clear sentence. Remove filler words.
4. **Preserve factual accuracy.** Don't change the meaning of entries unless they're wrong.
5. **Handle every entry.** Every entry must appear in at least one operation (keep, rewrite, merge, or delete).
6. **Prefer quality over quantity.** 10 excellent entries > 30 mediocre ones.
7. **Tag entries appropriately.** If an entry mentions a technology or concept that could be tagged, suggest tags in the newText using #hashtag syntax.

### Response Format

Return ONLY valid JSON with this structure:

{
  "operations": [
    { "action": "keep",    "targets": ["mem_1234_abcd"], "reason": "Clear and useful" },
    { "action": "rewrite", "targets": ["mem_5678_ef01"], "newText": "Project uses pnpm v9 with ESM-only modules #pnpm #esm", "reason": "Added version and ESM detail" },
    { "action": "merge",   "targets": ["mem_aaaa_1111", "mem_bbbb_2222"], "newText": "All packages use TypeScript strict mode with noUncheckedIndexedAccess #typescript", "reason": "Two entries about TS config, merged" },
    { "action": "delete",  "targets": ["mem_cccc_3333"], "reason": "Obsolete — was a temporary debug note" }
  ],
  "summary": "Merged 2 TS entries, rewrote 1 for clarity, deleted 1 obsolete note. 12 entries → 10 entries."
}

Use the EXACT entry IDs from the list above for "targets". No markdown, no explanation outside the JSON.`;

/**
 * Build the system prompt for the memory compact LLM call.
 * Interpolates the entry list into the shared template.
 */
function buildCompactPrompt(entries: CompactEntry[]): string {
  const entriesBlock = entries
    .map(
      (e, i) =>
        `${i + 1}. [${e.ts.slice(0, 10)}] ${e.id}\n   ${e.text}${e.tags ? `\n   tags: ${e.tags.join(', ')}` : ''}${e.type ? `\n   type: ${e.type}` : ''}${e.priority ? `\n   priority: ${e.priority}` : ''}`,
    )
    .join('\n\n');

  return COMPACT_SYSTEM_PROMPT.replace('__ENTRIES__', entriesBlock);
}

interface CompactEntry {
  id: string;
  text: string;
  ts: string;
  type?: string | undefined;
  tags?: string[] | undefined;
  priority?: string | undefined;
}

async function runCompact(opts: SlashCommandContext): Promise<{ message: string }> {
  const store = opts.memoryStore;
  if (!store) return { message: 'No memory store configured.' };

  // 1. Gather current entries with their REAL ids + metadata.
  // SAGE is the live backend: pull structured memories directly so
  // operations target real memory ids (updateSage/deleteSage).
  // The legacy text-parsing path is only a fallback for a non-SAGE store.
  const sageStore = getSageSurface(store);
  let compactEntries: CompactEntry[];
  if (sageStore) {
    const memories = await sageStore.listSage(['active', 'stale']);
    if (memories.length === 0) {
      return { message: 'Memory is empty — nothing to compact.' };
    }
    compactEntries = memories.map((m) => ({
      id: m.id,
      text: m.text,
      ts: m.createdAt,
      type: m.kind,
      tags: m.tags.length > 0 ? m.tags : undefined,
    }));
  } else {
    const entries = await store.list('project-memory');
    if (entries.length === 0) {
      return { message: 'Memory is empty — nothing to compact.' };
    }
    const raw = await store.read('project-memory');
    compactEntries = parseCompactEntries(raw);
    if (compactEntries.length === 0) {
      return { message: 'No parseable entries found.' };
    }
  }

  // 2. Check for LLM provider
  const provider = opts.llmProvider;
  if (!provider?.complete) {
    return {
      message:
        'No LLM provider available. /memory compact requires an active session with a configured provider.',
    };
  }

  // 3. Build prompt and call LLM
  const prompt = buildCompactPrompt(compactEntries);

  let responseText: string;
  try {
    const signal = AbortSignal.timeout(30_000);
    const response = await provider.complete(
      {
        model: opts.llmModel ?? '',
        system: [{ type: 'text', text: prompt }],
        messages: [
          {
            role: 'user',
            content: `Review the ${compactEntries.length} memory entries above and return operations as JSON.`,
          },
        ],
        maxTokens: 2000,
        temperature: 0.1, // low temperature for deterministic curation
      },
      { signal },
    );

    responseText = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  } catch (err) {
    return {
      message: `LLM call failed: ${toErrorMessage(err)}`,
    };
  }

  if (!responseText) {
    return { message: 'LLM returned empty response.' };
  }

  // 4. Parse the JSON response
  let parsed: CompactResponse;
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { message: `LLM response is not valid JSON:\n${responseText.slice(0, 500)}` };
    }
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    return {
      message: `Failed to parse LLM response: ${toErrorMessage(err)}\n\nRaw response:\n${responseText.slice(0, 500)}`,
    };
  }

  if (!Array.isArray(parsed.operations) || parsed.operations.length === 0) {
    return { message: 'LLM returned no operations.' };
  }

  // 5. Apply operations
  let kept = 0;
  let rewritten = 0;
  let merged = 0;
  let deleted = 0;
  const errors: string[] = [];

  for (const op of parsed.operations) {
    try {
      switch (op.action) {
        case 'keep': {
          kept += op.targets.length;
          break;
        }
        case 'rewrite': {
          if (!op.newText) {
            errors.push(`rewrite missing newText for targets: ${op.targets.join(', ')}`);
            continue;
          }
          if (sageStore) {
            // Edit the first target in place (preserves id/anchors/graph edges);
            // delete any extra targets folded into the rewrite.
            const [first, ...rest] = op.targets;
            if (first) await sageStore.updateSage(first, { text: op.newText });
            for (const t of rest) {
              await sageStore.deleteSage(t, 'compact: rewrite', { force: true });
            }
          } else {
            for (const target of op.targets) await store.forget(target);
            await store.remember(op.newText);
          }
          rewritten++;
          break;
        }
        case 'merge': {
          if (!op.newText) {
            errors.push(`merge missing newText for targets: ${op.targets.join(', ')}`);
            continue;
          }
          if (sageStore) {
            // Keep the first memory (update its text), delete the rest.
            const [keeper, ...rest] = op.targets;
            if (keeper) await sageStore.updateSage(keeper, { text: op.newText });
            for (const t of rest) {
              await sageStore.deleteSage(t, 'compact: merged', { force: true });
            }
          } else {
            for (const target of op.targets) await store.forget(target);
            await store.remember(op.newText);
          }
          merged++;
          break;
        }
        case 'delete': {
          if (sageStore) {
            for (const target of op.targets) {
              await sageStore.deleteSage(target, 'compact: obsolete', { force: true });
            }
          } else {
            for (const target of op.targets) await store.forget(target);
          }
          deleted += op.targets.length;
          break;
        }
        default: {
          errors.push(`unknown action "${(op as { action: string }).action}"`);
        }
      }
    } catch (err) {
      errors.push(`${op.action} failed for ${op.targets.join(', ')}: ${toErrorMessage(err)}`);
    }
  }

  // 6. Build summary
  const lines: string[] = ['## Memory Compact — Complete'];
  const stats: string[] = [];
  if (kept > 0) stats.push(`${kept} kept`);
  if (rewritten > 0) stats.push(`${rewritten} rewritten`);
  if (merged > 0) stats.push(`${merged} merged`);
  if (deleted > 0) stats.push(`${deleted} deleted`);
  lines.push(`**Result:** ${stats.join(', ')}`);
  lines.push(
    `**Before:** ${compactEntries.length} entries → **After:** ${kept + rewritten + merged} entries`,
  );

  if (parsed.summary) {
    lines.push('');
    lines.push(parsed.summary);
  }

  // Show per-operation details
  lines.push('');
  lines.push('### Operations');
  for (const op of parsed.operations) {
    const icon =
      op.action === 'keep'
        ? '✓'
        : op.action === 'rewrite'
          ? '✏️'
          : op.action === 'merge'
            ? '🔀'
            : op.action === 'delete'
              ? '✗'
              : '?';
    const detail = op.newText ? ` → "${op.newText}"` : '';
    lines.push(`- ${icon} **${op.action}** ${op.targets.join(', ')}${detail}`);
    if (op.reason) lines.push(`  _${op.reason}_`);
  }

  if (errors.length > 0) {
    lines.push('');
    lines.push('### Errors');
    for (const err of errors) {
      lines.push(`- ⚠️ ${err}`);
    }
  }

  return { message: lines.join('\n') };
}

/**
 * Parse raw memory content into compact entries with IDs.
 * Each line: `- [ISO] [type|priority] mem_<id> text #tags`
 */
function parseCompactEntries(raw: string): CompactEntry[] {
  const entries: CompactEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- [')) continue;

    // Extract entry ID: mem_<ts>_<rand>
    const idMatch = trimmed.match(/mem_(\d+_\w+)/);
    if (!idMatch) continue;
    const id = idMatch[0] ?? '';
    const afterId = trimmed.slice((idMatch.index ?? 0) + id.length).trim();

    // Extract timestamp
    const tsMatch = trimmed.match(/^-\s*\[([^\]]+)\]/);
    const ts = tsMatch?.[1] ?? '';

    // Extract #tags
    const tags: string[] = [];
    const tagRe = /#([\w-]+)/g;
    let tm: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
    while ((tm = tagRe.exec(afterId)) !== null) {
      tags.push(tm[1] ?? '');
    }

    // Clean text (remove tags)
    const text = afterId
      .replace(tagRe, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!text) continue;

    entries.push({ id, text, ts, tags: tags.length > 0 ? tags : undefined });
  }
  return entries;
}

// ── /memory stats — memory health dashboard ─────────────────────────────

async function runStats(opts: SlashCommandContext): Promise<{ message: string }> {
  const store = opts.memoryStore;
  if (!store) return { message: 'No memory store configured.' };

  const entries = await store.list('project-memory');
  if (entries.length === 0) {
    return { message: '📊 Memory is empty. Start adding entries with `/memory remember <text>`.' };
  }

  const now = Date.now();
  const lines: string[] = ['## 📊 Memory Stats'];

  // ── Overview
  const raw = await store.read('project-memory');
  const byteSize = Buffer.byteLength(raw, 'utf8');
  const kbSize = (byteSize / 1024).toFixed(1);
  const maxKb = (32_000 / 1024).toFixed(1);
  const pctFull = ((byteSize / 32_000) * 100).toFixed(0);
  lines.push(`**Total:** ${entries.length} entries · ${kbSize} KB / ${maxKb} KB (${pctFull}%)`);

  // ── By type
  const byType = new Map<string, number>();
  for (const e of entries) {
    const t = e.type ?? 'untyped';
    byType.set(t, (byType.get(t) ?? 0) + 1);
  }
  if (byType.size > 0) {
    lines.push('');
    lines.push('### By Type');
    const typeOrder = [
      'convention',
      'decision',
      'fact',
      'preference',
      'reference',
      'anti_pattern',
      'untyped',
    ];
    for (const t of typeOrder) {
      const count = byType.get(t);
      if (count) {
        const bar = '█'.repeat(Math.min(count, 20));
        lines.push(`- \`${t}\` ${bar} ${count}`);
      }
    }
  }

  // ── By priority
  const byPriority = new Map<string, number>();
  for (const e of entries) {
    const p = e.priority ?? 'unset';
    byPriority.set(p, (byPriority.get(p) ?? 0) + 1);
  }
  if (byPriority.size > 0) {
    lines.push('');
    lines.push('### By Priority');
    const icon: Record<string, string> = {
      critical: '⚡',
      high: '▲',
      medium: '●',
      low: '○',
      unset: '·',
    };
    for (const [p, count] of [...byPriority.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${icon[p] ?? '·'} \`${p}\`: ${count}`);
    }
  }

  // ── By age
  const ages = entries.map((e) => {
    const ageDays = (now - new Date(e.ts).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays < 1) return '<1d';
    if (ageDays < 7) return '<7d';
    if (ageDays < 30) return '<30d';
    return '>30d';
  });
  const byAge = new Map<string, number>();
  for (const a of ages) byAge.set(a, (byAge.get(a) ?? 0) + 1);
  lines.push('');
  lines.push('### By Age');
  for (const age of ['<1d', '<7d', '<30d', '>30d']) {
    const actual = byAge.get(age) ?? 0;
    if (actual > 0 || age === '<7d') {
      lines.push(`- ${age}: ${actual}`);
    }
  }

  // ── Top tags
  const tagCounts = new Map<string, number>();
  for (const e of entries) {
    for (const t of e.tags ?? []) {
      tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
  }
  if (tagCounts.size > 0) {
    lines.push('');
    lines.push('### Top Tags');
    const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [tag, count] of sorted) {
      lines.push(`- \`#${tag}\`: ${count}`);
    }
  }

  // ── Health
  lines.push('');
  lines.push('### Health');
  const untyped = byType.get('untyped') ?? 0;
  const unsetPriority = byPriority.get('unset') ?? 0;
  const old = byAge.get('>30d') ?? 0;

  if (untyped > entries.length * 0.5) {
    lines.push(
      `- ⚠️ ${untyped}/${entries.length} entries have no type — run \`/memory compact\` to categorize`,
    );
  } else if (untyped > 0) {
    lines.push(`- ℹ️ ${untyped} entries untyped — consider categorizing`);
  } else {
    lines.push('- ✅ All entries have types');
  }

  if (unsetPriority > entries.length * 0.5) {
    lines.push(`- ⚠️ ${unsetPriority}/${entries.length} entries have no priority`);
  } else if (unsetPriority > 0) {
    lines.push(`- ℹ️ ${unsetPriority} entries have no priority set`);
  } else {
    lines.push('- ✅ All entries have priorities');
  }

  if (old > 5) {
    lines.push(`- ⚠️ ${old} entries older than 30 days — run \`/memory compact\` to review`);
  }

  const pct = Number.parseInt(pctFull, 10);
  if (pct > 80) {
    lines.push(`- ⚠️ Storage ${pct}% full — run \`/memory compact\` to free space`);
  } else {
    lines.push(`- ✅ Storage ${pct}% full — healthy`);
  }

  lines.push('');
  lines.push('**Commands:** `/memory show` · `/memory compact` · `/memory remember <text>`');

  return { message: lines.join('\n') };
}
