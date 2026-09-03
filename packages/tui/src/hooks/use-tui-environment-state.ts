import { getIndexState, getProcessRegistry, onIndexStateChange } from '@wrongstack/tools';
import { useEffect, useRef, useState } from 'react';
import type { AppProps } from '../app-props.js';
import {
  activeMemoryContextCount,
  emptyMemoryContextMonitor,
  readMemoryRecordTotal,
} from '../memory-context-monitor.js';
import { useStatuslineState } from './use-statusline-state.js';

type EnvironmentProps = Omit<
  Pick<
    AppProps,
    | 'events'
    | 'memoryStore'
    | 'model'
    | 'provider'
    | 'effectiveMaxContext'
    | 'yolo'
    | 'getAutonomy'
    | 'modeLabel'
    | 'statuslineHiddenItems'
    | 'statuslineLines'
    | 'statuslineDensities'
    | 'toolCount'
    | 'getSettings'
    | 'setStatuslineHiddenItems'
    | 'saveStatuslineHiddenItems'
    | 'setStatuslineLines'
    | 'saveStatuslineLines'
    | 'setStatuslineDensities'
    | 'saveStatuslineDensities'
  >,
  'yolo'
> & { yolo: boolean };

/**
 * A failed statusline write is logged, never thrown — losing a layout tweak
 * must not take the session down.
 */
function logPersistFailure(event: string): (error: unknown) => void {
  return (error) => {
    console.error(
      JSON.stringify({
        level: 'error',
        event,
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
  };
}

export function useTuiEnvironmentState({
  events,
  memoryStore,
  model,
  provider,
  effectiveMaxContext,
  yolo,
  getAutonomy,
  modeLabel,
  statuslineHiddenItems,
  statuslineLines,
  statuslineDensities,
  toolCount,
  getSettings,
  setStatuslineHiddenItems,
  saveStatuslineHiddenItems,
  setStatuslineLines,
  saveStatuslineLines,
  setStatuslineDensities,
  saveStatuslineDensities,
}: EnvironmentProps) {
  const [memoryContextMonitor, setMemoryContextMonitor] = useState(emptyMemoryContextMonitor);
  const [memoryRecordTotal, setMemoryRecordTotal] = useState<number | undefined>();
  const memoryContextMonitorRef = useRef(memoryContextMonitor);
  memoryContextMonitorRef.current = memoryContextMonitor;
  const memoryRecordTotalRef = useRef(memoryRecordTotal);
  memoryRecordTotalRef.current = memoryRecordTotal;
  const activeMemoryInContext = activeMemoryContextCount(memoryContextMonitor);

  useEffect(() => {
    let cancelled = false;
    const refreshTotal = async (): Promise<void> => {
      try {
        const total = await readMemoryRecordTotal(memoryStore);
        if (!cancelled) setMemoryRecordTotal(total);
      } catch {
        if (!cancelled) setMemoryRecordTotal(undefined);
      }
    };

    void refreshTotal();
    const offAccepted = events.on('memory.accepted', () => void refreshTotal());
    return () => {
      cancelled = true;
      offAccepted();
    };
  }, [events, memoryStore]);

  const statusline = useStatuslineState({
    model,
    provider,
    effectiveMaxContext,
    yolo,
    getAutonomy,
    modeLabel,
    statuslineHiddenItems,
    statuslineLines,
    statuslineDensities,
  });
  const hiddenItemsRef = useRef(statusline.hiddenItems);
  hiddenItemsRef.current = statusline.hiddenItems;

  const [liveToolCount, setLiveToolCount] = useState(toolCount);
  useEffect(() => setLiveToolCount(toolCount), [toolCount]);

  const [indexState, setIndexState] = useState(() => getIndexState());
  useEffect(() => {
    setIndexState(getIndexState());
    return onIndexStateChange(setIndexState);
  }, []);

  const [breakerCountdown, setBreakerCountdown] = useState(() =>
    getProcessRegistry().getBreakerCountdown(),
  );
  useEffect(() => {
    const settings = getSettings?.();
    if (settings) {
      getProcessRegistry().setBreakerConfig({
        enabled: settings.breakerEnabled ?? false,
        autoKillResetMs: settings.breakerAutoKillResetMs ?? 60_000,
      });
    }
    return getProcessRegistry().onBreakerCountdownChange(setBreakerCountdown);
  }, [getSettings]);

  const breakerArmed = breakerCountdown !== null;
  useEffect(() => {
    if (!breakerArmed) return;
    const timer = setInterval(
      () => setBreakerCountdown(getProcessRegistry().getBreakerCountdown()),
      1000,
    );
    return () => clearInterval(timer);
  }, [breakerArmed]);

  useEffect(() => {
    statusline.setHiddenItems([...statuslineHiddenItems]);
  }, [statuslineHiddenItems, statusline.setHiddenItems]);

  useEffect(() => {
    setStatuslineHiddenItems(statusline.hiddenItems);
    saveStatuslineHiddenItems(statusline.hiddenItems).catch?.((error: unknown) => {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'statusline.persist_hidden_failed',
          message: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        }),
      );
    });
  }, [setStatuslineHiddenItems, saveStatuslineHiddenItems, statusline.hiddenItems]);

  // Layout (line assignment + density pins) persists on the same terms as
  // chip visibility: mirror into the host's in-memory copy, then write
  // statusline.json best-effort. Both effects skip their mount pass — the
  // layout we just loaded from disk does not need writing back to disk.
  const layoutHydrated = useRef(false);
  useEffect(() => {
    if (!layoutHydrated.current) {
      layoutHydrated.current = true;
      return;
    }
    setStatuslineLines?.(statusline.lines);
    saveStatuslineLines?.(statusline.lines).catch?.(
      logPersistFailure('statusline.persist_lines_failed'),
    );
  }, [setStatuslineLines, saveStatuslineLines, statusline.lines]);

  const densityHydrated = useRef(false);
  useEffect(() => {
    if (!densityHydrated.current) {
      densityHydrated.current = true;
      return;
    }
    setStatuslineDensities?.(statusline.densities);
    saveStatuslineDensities?.(statusline.densities).catch?.(
      logPersistFailure('statusline.persist_densities_failed'),
    );
  }, [setStatuslineDensities, saveStatuslineDensities, statusline.densities]);

  return {
    ...statusline,
    hiddenItemsRef,
    memoryContextMonitor,
    setMemoryContextMonitor,
    memoryRecordTotal,
    memoryContextMonitorRef,
    memoryRecordTotalRef,
    activeMemoryInContext,
    liveToolCount,
    setLiveToolCount,
    indexState,
    breakerCountdown,
  };
}
