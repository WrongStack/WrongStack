/**
 * `/memory triage` slash command.
 *
 * Runs the SAGE Memory Triage pipeline (Phase 1 → 2 → 3 → 4 → 5):
 *   1. preFilter     → keep / discard / uncertain
 *   2. valueScore    → 0-100 numeric score
 *   3. LLM triage    → gray-zone evaluation (1-5)
 *   4. merge detect  → cluster + pair LLM comparison
 *   5. dispatch      → auto-apply updates + proposals
 *
 * Flags:
 *   --dry-run  (default)  Print what would happen. No state changes.
 *   --apply                Execute auto-apply updates and file proposals.
 *   --limit N              Max memories to process (default: all active).
 *   --max-phase3 N         Max LLM calls for Phase 3 (default: 1000).
 *   --max-phase4-pairs N   Max pairs for Phase 4 (default: 50).
 *
 * Transport: `opts.llmProvider` (Provider.complete) — same pattern as
 * `/memory compact`. Falls back to a no-op LLM if the provider is absent
 * (Phase 3 and 4 will degrade to skip-only; report is still useful).
 */

import { toErrorMessage } from '@wrongstack/core/utils';
import type { LlmCallFn, Sage, SageSurface, UpdateSageInput } from '@wrongstack/sage';
import {
  fileTriageProposals,
  formatTriageReport,
  getSageSurface,
  runTriage,
  type TriageReport,
} from '@wrongstack/sage';
import type { SlashCommandContext } from './command-context.js';

const DEFAULT_MAX_PHASE3 = 1000;
const DEFAULT_MAX_PHASE4_PAIRS = 50;

export async function runTriageCommand(
  opts: SlashCommandContext,
  args: string[],
): Promise<{ message: string }> {
  const Sage = getSage(opts);
  if (!Sage) return { message: 'No SAGE surface available.' };

  // ── Parse flags ──────────────────────────────────────────────
  let dryRun = true;
  let limit: number | undefined;
  let maxPhase3 = DEFAULT_MAX_PHASE3;
  let maxPhase4Pairs = DEFAULT_MAX_PHASE4_PAIRS;
  const flagErrors: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token) continue;
    if (!token.startsWith('--')) continue;
    const name = token.slice(2).toLowerCase();
    const next = args[i + 1];

    switch (name) {
      case 'dry-run':
        dryRun = true;
        break;
      case 'apply':
        dryRun = false;
        break;
      case 'limit': {
        if (next === undefined || next.startsWith('--')) {
          flagErrors.push('--limit needs a value.');
          continue;
        }
        const parsed = Number.parseInt(next, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          flagErrors.push(`--limit must be a positive integer (got "${next}").`);
          continue;
        }
        limit = Math.min(500, Math.max(1, parsed));
        i++;
        break;
      }
      case 'max-phase3': {
        if (next === undefined || next.startsWith('--')) {
          flagErrors.push('--max-phase3 needs a value.');
          continue;
        }
        const parsed = Number.parseInt(next, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          flagErrors.push(`--max-phase3 must be a positive integer (got "${next}").`);
          continue;
        }
        maxPhase3 = parsed;
        i++;
        break;
      }
      case 'max-phase4-pairs': {
        if (next === undefined || next.startsWith('--')) {
          flagErrors.push('--max-phase4-pairs needs a value.');
          continue;
        }
        const parsed = Number.parseInt(next, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          flagErrors.push(`--max-phase4-pairs must be a positive integer (got "${next}").`);
          continue;
        }
        maxPhase4Pairs = parsed;
        i++;
        break;
      }
      default:
        flagErrors.push(`Unknown flag "--${name}".`);
    }
  }

  if (flagErrors.length > 0) {
    return {
      message: `Cannot triage:\n- ${flagErrors.join('\n- ')}\n\nUsage: /memory triage [--dry-run|--apply] [--limit N] [--max-phase3 N] [--max-phase4-pairs N]`,
    };
  }

  // ── Load memories ────────────────────────────────────────────
  const memories = await loadActiveMemories(Sage, limit);
  if (memories.length === 0) {
    return { message: 'No active memories to triage.' };
  }

  // ── Build LLM transport ─────────────────────────────────────
  const provider = opts.llmProvider;
  const model = opts.llmModel ?? '';
  const callLlm: LlmCallFn = provider?.complete
    ? async (system: string, userPrompt: string) => {
        const signal = AbortSignal.timeout(30_000);
        const response = await provider.complete!(
          {
            model,
            system: [{ type: 'text', text: system }],
            messages: [{ role: 'user', content: userPrompt }],
            maxTokens: 60,
            temperature: 0.1,
          },
          { signal },
        );
        return response.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim();
      }
    : async () => '3'; // no provider → neutral score, no merges

  // ── Run pipeline ─────────────────────────────────────────────
  let report: TriageReport;
  try {
    report = await runTriage(memories, callLlm, {
      dryRun,
      maxPhase3Calls: maxPhase3,
      maxPhase4Pairs,
      verbose: false,
    });
  } catch (err) {
    return { message: `Triage failed: ${toErrorMessage(err)}` };
  }

  // ── Apply actions if --apply ─────────────────────────────────
  if (!dryRun) {
    const applyReport = await applyDispatch(Sage, report);
    return {
      message: formatTriageReport(report) + '\n\n' + applyReport,
    };
  }

  return { message: formatTriageReport(report) };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function getSage(opts: SlashCommandContext): SageSurface | null {
  if (!opts.memoryStore) return null;
  try {
    return getSageSurface(opts.memoryStore) ?? null;
  } catch {
    return null;
  }
}

async function loadActiveMemories(Sage: SageSurface, limit: number | undefined): Promise<Sage[]> {
  const all: Sage[] = [];
  let cursor: string | undefined;

  while (true) {
    const pageSize = limit ? Math.min(500, limit - all.length) : 500;
    if (pageSize <= 0) break;

    const page = await Sage.listSagePage({
      statuses: ['active', 'stale'],
      limit: pageSize,
      cursor,
      // Admin surface: the user running this command owns every session in the
      // project, so it opts out of the session filter the agent-facing tools
      // rely on. Without this, session-scoped memories vanish from the listing.
      includeAllSessions: true,
    });

    all.push(...page.memories);

    if (limit && all.length >= limit) break;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return limit ? all.slice(0, limit) : all;
}

async function applyDispatch(Sage: SageSurface, report: TriageReport): Promise<string> {
  const lines: string[] = ['## Apply Results', ''];

  // Auto-apply updates
  let autoOk = 0;
  let autoFail = 0;
  for (const action of report.dispatch.autoApply) {
    const patch: UpdateSageInput = {};
    for (const update of action.updates) {
      if (update.field === 'status') {
        patch.status = update.value as UpdateSageInput['status'];
      } else if (update.field === 'confidence') {
        patch.confidence = update.value as number;
      } else if (update.field === 'importance') {
        patch.importance = update.value as number;
      }
    }
    try {
      await Sage.updateSage(action.memoryId, patch);
      autoOk++;
    } catch (err) {
      autoFail++;
      lines.push(`  ✗ Failed to update ${action.memoryId}: ${toErrorMessage(err)}`);
    }
  }
  lines.push(`**Auto-apply:** ${autoOk} succeeded, ${autoFail} failed`);
  lines.push('');

  // Merges: mark older as superseded, link on keeper
  let mergeOk = 0;
  let mergeFail = 0;
  for (const merge of report.merges.merges) {
    try {
      await Sage.updateSage(merge.supersededId, { status: 'superseded' });
      await Sage.updateSage(merge.keeperId, { supersedes: [merge.supersededId] });
      mergeOk++;
    } catch (err) {
      mergeFail++;
      lines.push(
        `  ✗ Failed to merge ${merge.supersededId} → ${merge.keeperId}: ${toErrorMessage(err)}`,
      );
    }
  }
  lines.push(`**Merges:** ${mergeOk} succeeded, ${mergeFail} failed`);
  lines.push('');

  // Proposals — file as MemoryCandidates via the surface.
  // createCandidate is now exposed on SageSurface; proposals surface for
  // human review via `/memory candidates`.
  const proposalResult = await fileProposals(Sage, report.dispatch.proposals);
  if (proposalResult.total > 0) {
    lines.push(
      `**Proposals:** ${proposalResult.filed} of ${proposalResult.total} filed via memory_candidates (use \`/memory candidates\` to accept/reject).`,
    );
  }
  for (const failure of proposalResult.failures) {
    lines.push(`  ✗ Failed to file proposal for ${failure.memoryId}: ${failure.error}`);
  }

  return lines.join('\n');
}

export type { ProposalFileResult } from '@wrongstack/sage';

/**
 * File triage proposals as MemoryCandidates via the Sage surface.
 * Implementation lives in `@wrongstack/sage` (shared with daily dry-run).
 */
export async function fileProposals(
  Sage: SageSurface,
  proposals: TriageReport['dispatch']['proposals'],
): Promise<import('@wrongstack/sage').ProposalFileResult> {
  return fileTriageProposals(Sage, proposals);
}
