import { PanelRight, PanelRightOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAppTranslation } from '@/i18n';

export function MemoryDrawerToolbar({
  currentFilePath,
  knownFilePaths,
  drawerActive,
  onFilePathChange,
  onToggleDrawer,
}: {
  currentFilePath: string | null;
  knownFilePaths: Set<string>;
  drawerActive: boolean;
  onFilePathChange: (path: string | null) => void;
  onToggleDrawer: () => void;
}) {
  const { t } = useAppTranslation();

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-card/30 px-3 py-1.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {t('activity:memoryManager.fileDrawerLabel')}
      </span>
      <input
        type="text"
        list="memory-drawer-file-list"
        value={currentFilePath ?? ''}
        onChange={(e) => {
          const next = e.target.value.trim() || null;
          onFilePathChange(next);
        }}
        placeholder={t('activity:memoryManager.selectFilePlaceholder')}
        className="min-w-0 max-w-[260px] flex-1 truncate rounded-sm border border-border/60 bg-background px-1.5 py-0.5 text-[10px] font-mono"
        aria-label={t('activity:memoryManager.fileForDrawerAria')}
        data-testid="memory-drawer-file-select"
      />
      <datalist id="memory-drawer-file-list">
        {[...knownFilePaths].sort().map((path) => (
          <option key={path} value={path} />
        ))}
      </datalist>
      <Button
        type="button"
        size="sm"
        variant={drawerActive ? 'default' : 'outline'}
        onClick={onToggleDrawer}
        disabled={!currentFilePath}
        className="h-7 shrink-0 gap-1 px-2 text-[11px]"
        aria-pressed={drawerActive}
        title={
          drawerActive
            ? t('activity:memoryManager.hideFileDrawer')
            : t('activity:memoryManager.showFileDrawer')
        }
      >
        {drawerActive ? <PanelRightOpen className="size-3" /> : <PanelRight className="size-3" />}
        {drawerActive
          ? t('activity:memoryManager.hideDrawer')
          : t('activity:memoryManager.showDrawer')}
      </Button>
    </div>
  );
}
