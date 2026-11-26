/**
 * Pre-Flight Context Pack for ACP sub-clients (P3.1).
 *
 * External ACP models frequently skip proactive `memory_search` or `kanban_read`
 * calls at the start of a task. This module builds a bounded, fail-open
 * `<wrongstack-preflight-context>` block injected into the user task prompt
 * (preserving system-prompt cache stability) with:
 *   1. Top relevant SAGE project memories for the task description
 *   2. Bound Kanban card summary & checklist (when `kanbanTaskId` is present)
 */

export interface PreflightMemoryItem {
  id?: string | undefined;
  title?: string | undefined;
  content: string;
  scope?: string | undefined;
}

export interface PreflightKanbanCard {
  id: string;
  title: string;
  status?: string | undefined;
  checks?: ReadonlyArray<{ label: string; done?: boolean | undefined }> | undefined;
}

export interface AcpPreflightSources {
  fetchMemories?: (query: string, signal: AbortSignal) => Promise<readonly PreflightMemoryItem[]>;
  fetchKanbanCard?: (cardId: string, signal: AbortSignal) => Promise<PreflightKanbanCard | null>;
}

export interface AcpPreflightOptions {
  /** Max total characters for the rendered pre-flight block (default 4800 ≈ 1200 tokens). */
  maxChars?: number | undefined;
  /** Per-source timeout in ms (default 1500ms, fail-open). */
  timeoutMs?: number | undefined;
}

const DEFAULT_MAX_CHARS = 4_800;
const DEFAULT_TIMEOUT_MS = 1_500;

async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T | undefined> {
  if (parentSignal?.aborted) return undefined;
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  // The deadline must bound the AWAIT, not only the signal: a source that
  // ignores its signal (a dead transport, an SDK without cancellation) left
  // this pending forever, and the ACP host awaits this block before starting
  // the worker. Late values and rejections are dropped, so the fail-open
  // result stays `undefined`.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error('preflight timeout'));
      resolve(undefined);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    const work = (async () => fn(controller.signal))().catch(() => undefined);
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

function truncateText(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Build a compact, budget-capped `<wrongstack-preflight-context>` block for an
 * ACP task. Always fail-open: returns `undefined` if no sources return data or
 * if lookups time out.
 */
export async function buildAcpPreflightContext(params: {
  taskDescription: string;
  kanbanCardId?: string | undefined;
  sources: AcpPreflightSources;
  signal?: AbortSignal | undefined;
  options?: AcpPreflightOptions | undefined;
}): Promise<string | undefined> {
  const finiteOption = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const maxChars = Math.max(400, finiteOption(params.options?.maxChars, DEFAULT_MAX_CHARS));
  const timeoutMs = Math.max(100, finiteOption(params.options?.timeoutMs, DEFAULT_TIMEOUT_MS));

  const [memories, card] = await Promise.all([
    params.sources.fetchMemories
      ? withTimeout(
          (sig) => params.sources.fetchMemories!(params.taskDescription, sig),
          timeoutMs,
          params.signal,
        )
      : Promise.resolve(undefined),
    params.kanbanCardId && params.sources.fetchKanbanCard
      ? withTimeout(
          (sig) => params.sources.fetchKanbanCard!(params.kanbanCardId!, sig),
          timeoutMs,
          params.signal,
        )
      : Promise.resolve(undefined),
  ]);

  const sections: string[] = [];

  if (card) {
    const lines = [
      `## Kanban Card (${card.id})`,
      `Title: ${card.title}${card.status ? ` [${card.status}]` : ''}`,
    ];
    if (card.checks && card.checks.length > 0) {
      lines.push('Checks:');
      for (const check of card.checks.slice(0, 12)) {
        lines.push(`- [${check.done ? 'x' : ' '}] ${check.label}`);
      }
    }
    sections.push(lines.join('\n'));
  }

  if (memories && memories.length > 0) {
    const lines = ['## Relevant Project Memories (SAGE)'];
    for (const mem of memories.slice(0, 8)) {
      const prefix = mem.title ? `**${mem.title}**: ` : '';
      const scopeTag = mem.scope ? ` (${mem.scope})` : '';
      lines.push(`- ${prefix}${truncateText(mem.content, 360)}${scopeTag}`);
    }
    sections.push(lines.join('\n'));
  }

  if (sections.length === 0) return undefined;

  const body = truncateText(sections.join('\n\n'), maxChars - 80);
  return `<wrongstack-preflight-context>\n${body}\n</wrongstack-preflight-context>`;
}
