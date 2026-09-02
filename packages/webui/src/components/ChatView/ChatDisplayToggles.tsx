import { useAppTranslation } from '@/i18n';
import { useUIStore } from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';
import { ToggleSwitch } from './ToggleSwitch';
import { fmtTok } from './utils.js';

export function ChatDisplayToggles({
  hasStatusContent,
  totalTokens,
  rowsCount,
  iteration,
  startTime,
  formatDuration,
  onToggleAutoCollapse,
}: {
  hasStatusContent: boolean;
  totalTokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  rowsCount: number;
  iteration?: { index: number; max: number } | null;
  startTime: number | null;
  formatDuration: (start: number | null) => string;
  onToggleAutoCollapse: () => void;
}) {
  const { t } = useAppTranslation();
  const showThinkingLogs = useLocalPrefs((s) => s.showThinkingLogs);
  const groupToolCallsPref = useLocalPrefs((s) => s.groupToolCalls);
  const autoCollapseInput = useLocalPrefs((s) => s.autoCollapseInput);
  const compactMode = useUIStore((s) => s.compactMode);

  return (
    <div className="ws-display-toggles flex max-w-6xl mx-auto px-2 pb-1.5 items-center gap-3 text-[11px] text-muted-foreground/75 select-none overflow-x-auto min-h-[1.75rem]">
      <div className="flex items-center gap-2 shrink-0">
        <ToggleSwitch
          label={t('activity:chatView.reasoning')}
          value={showThinkingLogs}
          onChange={() => {
            useLocalPrefs
              .getState()
              .set({ showThinkingLogs: !useLocalPrefs.getState().showThinkingLogs });
          }}
        />
        <span className="opacity-30">|</span>
        <ToggleSwitch
          label={t('activity:chatView.groupTools')}
          value={groupToolCallsPref}
          onChange={() => {
            useLocalPrefs
              .getState()
              .set({ groupToolCalls: !useLocalPrefs.getState().groupToolCalls });
          }}
        />
        <span className="opacity-30">|</span>
        <ToggleSwitch
          label={t('activity:chatView.compact')}
          value={compactMode}
          onChange={() => useUIStore.getState().toggleCompactMode()}
        />
        <span className="opacity-30">|</span>
        <ToggleSwitch
          label={t('activity:chatView.autoCollapse')}
          value={autoCollapseInput}
          onChange={onToggleAutoCollapse}
        />
      </div>
      {hasStatusContent && (
        <>
          <span className="opacity-20 grow min-w-[1rem]" />
          <div className="flex items-center gap-3 tabular-nums text-[10px] text-muted-foreground/70 shrink-0">
            {totalTokens.input > 0 && (
              <span
                className="flex items-center gap-1"
                title={`${totalTokens.input.toLocaleString()} tokens in`}
              >
                <span className="font-medium text-foreground/80">{fmtTok(totalTokens.input)}</span>
                <span className="text-[9px]">in</span>
              </span>
            )}
            {totalTokens.output > 0 && (
              <span
                className="flex items-center gap-1"
                title={`${totalTokens.output.toLocaleString()} tokens out`}
              >
                <span className="font-medium text-foreground/80">{fmtTok(totalTokens.output)}</span>
                <span className="text-[9px]">out</span>
              </span>
            )}
            {rowsCount > 0 && (
              <span className="flex items-center gap-1" title={t('activity:chatView.messages')}>
                <span className="font-medium text-foreground/80">{rowsCount}</span>
                <span className="text-[9px]">msgs</span>
              </span>
            )}
            {iteration?.index && (
              <span
                className="flex items-center gap-1 text-primary/70"
                title={t('activity:chatView.currentIteration')}
              >
                <span className="font-medium">{iteration.index}</span>
                <span className="text-[9px]">iter</span>
              </span>
            )}
            {startTime && (
              <span className="tabular-nums text-muted-foreground/50">
                {formatDuration(startTime)}
              </span>
            )}
          </div>
        </>
      )}
      <span className="opacity-20 ml-2 text-[9px] shrink-0">
        <kbd className="font-mono text-[9px] border rounded px-1 py-0.5 bg-muted/40">?</kbd>
      </span>
    </div>
  );
}
