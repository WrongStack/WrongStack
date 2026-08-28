import { useCallback } from 'react';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { Action } from '../app-reducer.js';

interface ShadowPanelHost {
  getShadowData?: (() => { activeId: string | null; running: boolean; model: string; intervalMs: number }) | undefined;
  onShadowStart?: (() => Promise<string | undefined>) | undefined;
  onShadowStop?: (() => Promise<string | undefined>) | undefined;
}

export function useShadowPanel(
  dispatch: React.Dispatch<Action>,
  host: ShadowPanelHost,
): {
  openShadowPanel: () => void;
  handleShadowStart: () => Promise<void>;
  handleShadowStop: () => Promise<void>;
} {
  const { getShadowData, onShadowStart, onShadowStop } = host;

  const openShadowPanel = useCallback(() => {
    if (!getShadowData) return;
    dispatch({ type: 'shadowOpen', shadow: getShadowData() });
  }, [dispatch, getShadowData]);

  const handleShadowStart = useCallback(async () => {
    if (!onShadowStart) return;
    dispatch({ type: 'shadowHint', text: 'Starting Shadow Agent…' });
    try {
      const err = await onShadowStart();
      if (err) dispatch({ type: 'shadowHint', text: err });
      else {
        if (getShadowData) dispatch({ type: 'shadowUpdate', shadow: getShadowData() });
        dispatch({ type: 'shadowHint', text: 'Shadow Agent started.' });
      }
    } catch (error) {
      dispatch({ type: 'shadowHint', text: `Failed to start: ${toErrorMessage(error)}` });
    }
  }, [dispatch, getShadowData, onShadowStart]);

  const handleShadowStop = useCallback(async () => {
    if (!onShadowStop) return;
    dispatch({ type: 'shadowHint', text: 'Stopping Shadow Agent…' });
    try {
      const err = await onShadowStop();
      if (err) dispatch({ type: 'shadowHint', text: err });
      else {
        if (getShadowData) dispatch({ type: 'shadowUpdate', shadow: getShadowData() });
        dispatch({ type: 'shadowHint', text: 'Shadow Agent stopped.' });
      }
    } catch (error) {
      dispatch({ type: 'shadowHint', text: `Failed to stop: ${toErrorMessage(error)}` });
    }
  }, [dispatch, getShadowData, onShadowStop]);

  return { openShadowPanel, handleShadowStart, handleShadowStop };
}
