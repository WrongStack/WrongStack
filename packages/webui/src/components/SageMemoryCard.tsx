import { Brain } from 'lucide-react';
import { memo } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';

export interface SageMemoryCardProps {
  /** Extracted SAGE block lines, including the `--- SAGE:` header at index 0. */
  sageLines: string[];
  /** Tool name, surfaced in the card header so the user sees which call
   *  triggered the memory injection. */
  toolName?: string | undefined;
  /** Optional extra className for the outer wrapper. */
  className?: string | undefined;
}

/**
 * Bordered card that surfaces SAGE memory-injection lines as a separate
 * section below the tool result body. Mirrors the TUI's
 * `<SageMemoryBlock sageLines={sageLines} toolName={entry.name} />` so the
 * TUI and WebUI render the same injection evidence the same way: the
 * tool result frame carries only the normal tool output and the memory
 * text appears in its own visual card.
 */
export const SageMemoryCard = memo(function SageMemoryCard({
  sageLines,
  toolName,
  className,
}: SageMemoryCardProps) {
  const { t } = useAppTranslation();
  // The header is always `--- SAGE: ... ---` at index 0; the memory lines
  // are the rest. Empty memoryLines means there's nothing to render.
  const memoryLines = sageLines.slice(1);
  if (memoryLines.length === 0) return null;

  const headerSuffix = toolName ? ` · ${toolName}` : '';
  const memoryLabel = t('activity:sageMemory.memoriesLabel', {
    count: memoryLines.length,
  });

  return (
    <div
      data-testid="sage-memory-card"
      className={cn(
        'mt-2 rounded-md border border-primary/40 bg-primary/[0.04] text-foreground overflow-hidden',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-primary/20 bg-primary/[0.06] px-2 py-1">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
          <Brain className="h-3.5 w-3.5" />
          <span data-testid="sage-memory-header">
            {t('activity:sageMemory.injectedHeading')}
            {headerSuffix}
          </span>
        </div>
        <span className="text-[10px] text-muted-foreground">{memoryLabel}</span>
      </div>
      <ul className="divide-y divide-primary/10 font-mono text-[11px]">
        {memoryLines.map((line, idx) => (
          <li
            key={`${idx}-${line}`}
            className="px-2 py-1 text-primary/90 break-words"
            data-testid="sage-memory-line"
          >
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
});