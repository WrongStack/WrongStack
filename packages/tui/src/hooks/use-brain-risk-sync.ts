import { useCallback, useEffect, useRef } from 'react';
import type { Action } from '../app-reducer.js';
import type { BrainRiskLevel } from '../brain-contracts.js';

export function useBrainRiskSync({
  dispatch,
  riskLevel,
  brainPanelOpen,
  onBrainRiskLevel,
}: {
  dispatch: React.Dispatch<Action>;
  riskLevel: BrainRiskLevel;
  brainPanelOpen: boolean;
  onBrainRiskLevel?: ((level: BrainRiskLevel) => string | undefined) | undefined;
}): {
  changeBrainRisk: (delta: number) => void;
} {
  const changeBrainRisk = useCallback(
    (delta: number) => {
      dispatch({ type: 'brainRiskChange', delta });
    },
    [dispatch],
  );

  // Sync risk level to host whenever it changes via left/right in the panel.
  const prevRiskRef = useRef(riskLevel);
  useEffect(() => {
    if (!brainPanelOpen) return;
    if (riskLevel !== prevRiskRef.current && onBrainRiskLevel) {
      prevRiskRef.current = riskLevel;
      const err = onBrainRiskLevel(riskLevel);
      if (err) dispatch({ type: 'brainHint', text: err });
      else dispatch({ type: 'brainHint', text: `Risk ceiling → ${riskLevel.toUpperCase()}` });
    }
  }, [brainPanelOpen, dispatch, onBrainRiskLevel, riskLevel]);

  return { changeBrainRisk };
}
