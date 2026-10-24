import type { Middleware } from '@wrongstack/contracts/kernel';
import type { ContentBlock, Request, TextBlock } from '@wrongstack/contracts/types';
import { formatMemoryEvidenceBlock, LIVE_CONTEXT_MARKER } from '@wrongstack/core/utils';
import { formatMemoryHintsDetailed } from '../retrieval/format.js';
import { checkInjectionValidity } from '../retrieval/validity-checks.js';
import { isSageVisibleForSearch } from '../retrieval/visibility.js';
import type { Sage } from '../types.js';
import type { InjectionTracker } from './injection-tracker.js';
import {
  memoryIdsInEvidence,
  TOOL_MEMORY_EVIDENCE_SOURCE,
  TOOL_MEMORY_EVIDENCE_WINDOW_CHARS,
} from './tool-call-memory-trace.js';

export type GetEvidenceMemory = (id: string) => Promise<Sage | null | undefined>;

/** Re-read the rolling window by id; rendering/cooldown must never freeze a row. */
export async function refreshMemoryEvidence(
  text: string,
  getMemory: GetEvidenceMemory,
  sessionId?: string,
  projectRoot?: string,
  tracker?: InjectionTracker,
): Promise<string> {
  const ids = [...memoryIdsInEvidence(text)];
  if (ids.length === 0) return '';
  // The window is bounded, but keep an alternate host's input bounded too.
  const reads = await Promise.allSettled(ids.slice(0, 64).map(getMemory));
  const memories = reads.flatMap((read, index) => {
    if (
      read.status !== 'fulfilled' ||
      !read.value ||
      read.value.id !== ids[index] ||
      read.value.kind === 'memory_review'
    )
      return [];
    return isSageVisibleForSearch(read.value, { sessionId, includeAudienceScoped: false })
      ? [read.value]
      : [];
  });
  const validityReviews = await checkInjectionValidity(memories, projectRoot);
  const heading = /^--- (.+) ---$/.exec(text.split('\n')[0] ?? '')?.[1];
  const rendered = formatMemoryHintsDetailed(memories, {
    heading,
    maxChars: TOOL_MEMORY_EVIDENCE_WINDOW_CHARS,
    validityReviews,
  });
  for (const memory of memories) {
    if (rendered.memoryIds.includes(memory.id))
      tracker?.refresh(memory.id, memory.text, sessionId, rendered.text);
  }
  return rendered.text;
}

/** Refresh only the provider's live evidence, leaving durable history untouched. */
export function createSageEvidenceRefreshMiddleware(opts: {
  getMemory: GetEvidenceMemory;
  projectRoot?: string | undefined;
  getSessionId?: (() => string | undefined) | undefined;
  tracker?: InjectionTracker | undefined;
}): Middleware<Request> {
  const opening = `[memory_evidence source="${TOOL_MEMORY_EVIDENCE_SOURCE}"]\n`;
  const closing = '\n[/memory_evidence]';
  return {
    name: 'sage.evidence-refresh',
    owner: 'sage',
    async handler(request, next) {
      const sessionId = request.cache?.sessionId ?? opts.getSessionId?.();
      const refresh = async (block: ContentBlock): Promise<ContentBlock[]> => {
        if (
          block.type !== 'text' ||
          !block.text.startsWith(opening) ||
          !block.text.endsWith(closing)
        )
          return [block];
        let text = '';
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          text = await Promise.race([
            refreshMemoryEvidence(
              block.text.slice(opening.length, -closing.length),
              opts.getMemory,
              sessionId,
              opts.projectRoot,
              opts.tracker,
            ),
            new Promise<string>((resolve) => {
              timer = setTimeout(() => resolve(''), 5_000);
              timer.unref?.();
            }),
          ]);
        } catch {
          // Unreadable current state must not turn an old row into current evidence.
        } finally {
          if (timer) clearTimeout(timer);
        }
        return text
          ? [{ ...block, text: formatMemoryEvidenceBlock(TOOL_MEMORY_EVIDENCE_SOURCE, text) }]
          : [];
      };
      const system = request.system
        ? ((await Promise.all(request.system.map(refresh))).flat() as TextBlock[])
        : undefined;
      const messages = request.messages.slice();
      const last = messages.at(-1);
      if (last?.role === 'user' && Array.isArray(last.content)) {
        const liveStart = last.content.findIndex(
          (block) => block.type === 'text' && block.text === LIVE_CONTEXT_MARKER,
        );
        if (liveStart >= 0) {
          messages[messages.length - 1] = {
            ...last,
            content: [
              ...last.content.slice(0, liveStart + 1),
              ...(await Promise.all(last.content.slice(liveStart + 1).map(refresh))).flat(),
            ],
          };
        }
      }
      return next({ ...request, ...(system ? { system } : {}), messages });
    },
  };
}
