import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import { SLASH_CATEGORY_ORDER, type SlashCommandDef } from './slash-commands.js';

export function SlashCommandPopup({
  suggestions,
  selectedIndex,
  onSelectIndex,
  onRun,
}: {
  suggestions: SlashCommandDef[];
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  onRun: (name: string) => void;
}) {
  const { t } = useAppTranslation();
  if (suggestions.length === 0) return null;
  const byCategory: Record<string, Array<{ cmd: SlashCommandDef; idx: number }>> = {};
  suggestions.forEach((cmd, idx) => {
    if (!byCategory[cmd.category]) byCategory[cmd.category] = [];
    byCategory[cmd.category]?.push({ cmd, idx });
  });
  const orderedCategories = SLASH_CATEGORY_ORDER.filter((category) => byCategory[category]?.length);

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 max-h-72 overflow-auto rounded-lg border border-border/70 bg-popover p-1 text-sm shadow-xl">
      <div className="mb-1 border-b px-3 py-1 text-[10px] uppercase text-muted-foreground">
        {t('activity:slashpopup.selectTabCompleteEnterDispatchEsc')}
      </div>
      {orderedCategories.map((category) => (
        <div key={category} className="mb-1">
          <div className="px-3 pb-0.5 pt-1 text-[10px] font-semibold uppercase text-muted-foreground/70">
            {category}
          </div>
          {byCategory[category]?.map(({ cmd, idx }) => (
            <button
              type="button"
              key={cmd.name}
              onClick={() => onRun(cmd.name)}
              onMouseEnter={() => onSelectIndex(idx)}
              className={cn(
                'flex w-full items-center gap-3 rounded px-3 py-1.5 text-left transition-colors',
                idx === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/40',
              )}
            >
              <span className="shrink-0 font-mono">{cmd.name}</span>
              {cmd.aliases?.length ? (
                <span className="shrink-0 font-mono text-xs text-muted-foreground/70">
                  ({cmd.aliases.join(', ')})
                </span>
              ) : null}
              <span className="truncate text-xs text-muted-foreground">— {cmd.description}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
