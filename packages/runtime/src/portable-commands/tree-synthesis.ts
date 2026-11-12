import type { Config, MemoryStore, Provider } from '@wrongstack/contracts/types';
import type { SessionTreeCoordinatorOptions } from '@wrongstack/core/storage';

const FOLD_SYNTHESIS_TIMEOUT_MS = 30_000;
const FOLD_SYNTHESIS_SYSTEM_PROMPT =
  'You distill exploratory coding session branches into concise, technical Markdown fold-back handoff briefs. Preserve concrete root causes, rejected dead ends, and verified file paths without fabricating details.';

export interface HostTreeFoldHooksInput {
  getConfig?: (() => Partial<Config> | undefined) | undefined;
  getProvider?: (() => Provider | undefined) | undefined;
  getModel?: (() => string | undefined) | undefined;
  memoryStore?: MemoryStore | undefined;
}

function extractCompletionText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * Build host-wired `SessionTreeCoordinator` fold hooks (`synthesizeSummary`,
 * `branchFoldMaxTokens`, and `onFoldInsight` for SAGE project memory) shared by
 * CLI, TUI, WebUI, and ACP surfaces.
 */
export function createHostTreeFoldHooks(
  input: HostTreeFoldHooksInput,
): Pick<
  SessionTreeCoordinatorOptions,
  'synthesizeSummary' | 'branchFoldMaxTokens' | 'onFoldInsight'
> {
  const rawMax = input.getConfig?.()?.session?.branchFoldMaxTokens;
  const branchFoldMaxTokens =
    typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0
      ? Math.floor(rawMax)
      : undefined;

  const hasLiveProvider = (): { provider: Provider; model: string } | undefined => {
    const provider = input.getProvider?.();
    const model = input.getModel?.() ?? input.getConfig?.()?.model;
    if (!provider || typeof provider.complete !== 'function' || !model) return undefined;
    return { provider, model };
  };

  const synthesizeSummary: SessionTreeCoordinatorOptions['synthesizeSummary'] = hasLiveProvider()
    ? async (prompt: string) => {
        const resolved = hasLiveProvider();
        if (!resolved) return '';
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), FOLD_SYNTHESIS_TIMEOUT_MS);
        timer.unref?.();
        try {
          const resp = await resolved.provider.complete(
            {
              model: resolved.model,
              system: [{ type: 'text', text: FOLD_SYNTHESIS_SYSTEM_PROMPT }],
              messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
              temperature: 0.2,
              ...(branchFoldMaxTokens !== undefined ? { maxTokens: branchFoldMaxTokens } : {}),
            },
            { signal: ac.signal },
          );
          return extractCompletionText(resp.content);
        } finally {
          clearTimeout(timer);
        }
      }
    : undefined;

  const onFoldInsight: SessionTreeCoordinatorOptions['onFoldInsight'] = input.memoryStore
    ? async ({ sessionId, sourceBranch, targetBranch, summary, touchedFiles }) => {
        const cfg = input.getConfig?.();
        if (cfg?.features?.memory === false || cfg?.features?.sageBranchInsights === false) {
          return undefined;
        }
        const tags = ['branch-fold', sourceBranch.name, ...touchedFiles.slice(0, 5)].filter(
          (tag) => tag.length > 0,
        );
        await input.memoryStore?.remember(
          `[Branch Fold: ${sourceBranch.name} -> ${targetBranch.name}]\n${summary}`,
          'project-memory',
          {
            type: 'decision',
            priority: 'medium',
            confidence: 0.85,
            source: sessionId,
            tags,
          },
        );
        return [`sage:${sessionId}:${sourceBranch.id}`];
      }
    : undefined;

  return {
    ...(synthesizeSummary ? { synthesizeSummary } : {}),
    ...(branchFoldMaxTokens !== undefined ? { branchFoldMaxTokens } : {}),
    ...(onFoldInsight ? { onFoldInsight } : {}),
  };
}
