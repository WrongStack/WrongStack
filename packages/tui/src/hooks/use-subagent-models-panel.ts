/**
 * `/subagent-models` panel controller.
 *
 * Opens the panel from a host snapshot, and edits a lane through the SAME
 * two-step provider→model overlay the `/model` command uses (`requestModelPick`
 * in purpose 'pick'), so there is exactly one model-selection UI in the TUI.
 */

import React from 'react';
import type { Action } from '../app-action-type.js';
import type { SubagentModelsPanelHost } from '../subagent-models-panel-model.js';
import type { ModelPickSelection } from './use-model-pick.js';

interface UseSubagentModelsPanelOptions {
  dispatch: React.Dispatch<Action>;
  subagentModelsHost?: SubagentModelsPanelHost | undefined;
  /** Shared model overlay; absent when the host exposes no provider list. */
  requestModelPick?: ((title: string) => Promise<ModelPickSelection>) | undefined;
}

export interface SubagentModelsPanelController {
  openSubagentModelsPanel: () => void;
  onSubagentLaneEdit: (index: number) => void;
  onSubagentLaneClear: (index: number) => void;
  onSubagentPlanToggle: (field: 'lock' | 'enabled' | 'followSessionModel') => void;
}

export function useSubagentModelsPanel(
  opts: UseSubagentModelsPanelOptions,
): SubagentModelsPanelController {
  const { dispatch, subagentModelsHost, requestModelPick } = opts;

  const refresh = React.useCallback(
    (hint?: string | undefined) => {
      if (!subagentModelsHost) return;
      const snap = subagentModelsHost.snapshot();
      dispatch({
        type: 'subagentModelsUpdate',
        lanes: snap.lanes,
        roles: snap.roles,
        enabled: snap.enabled,
        lock: snap.lock,
        followSessionModel: snap.followSessionModel,
        sessionTarget: snap.sessionTarget,
      });
      dispatch({ type: 'subagentModelsHint', text: hint });
    },
    [dispatch, subagentModelsHost],
  );

  const openSubagentModelsPanel = React.useCallback(() => {
    if (!subagentModelsHost) return;
    const snap = subagentModelsHost.snapshot();
    dispatch({
      type: 'subagentModelsOpen',
      lanes: snap.lanes,
      roles: snap.roles,
      enabled: snap.enabled,
      lock: snap.lock,
      followSessionModel: snap.followSessionModel,
      sessionTarget: snap.sessionTarget,
    });
  }, [dispatch, subagentModelsHost]);

  /** Run a host mutation and surface its error (or success) as a panel hint. */
  const apply = React.useCallback(
    (run: () => Promise<string | null>, okHint: string) => {
      void run()
        .then((err) => refresh(err ?? okHint))
        .catch((e: unknown) => {
          dispatch({
            type: 'subagentModelsHint',
            text: e instanceof Error ? e.message : String(e),
          });
        });
    },
    [dispatch, refresh],
  );

  const onSubagentLaneEdit = React.useCallback(
    (index: number) => {
      if (!subagentModelsHost || !requestModelPick) return;
      // The overlay renders above this panel and resolves null on Esc, which
      // leaves the lane exactly as it was.
      void requestModelPick(`Lane ${index + 1} model (Esc = keep)`)
        .then((sel) => {
          if (!sel) return;
          apply(
            () => subagentModelsHost.setLane(index, { provider: sel.providerId, model: sel.model }),
            `Lane ${index + 1} → ${sel.providerId}/${sel.model}`,
          );
        })
        .catch((e: unknown) => {
          dispatch({
            type: 'subagentModelsHint',
            text: e instanceof Error ? e.message : String(e),
          });
        });
    },
    [apply, dispatch, requestModelPick, subagentModelsHost],
  );

  const onSubagentLaneClear = React.useCallback(
    (index: number) => {
      if (!subagentModelsHost) return;
      apply(() => subagentModelsHost.clearLane(index), `Lane ${index + 1} cleared`);
    },
    [apply, subagentModelsHost],
  );

  const onSubagentPlanToggle = React.useCallback(
    (field: 'lock' | 'enabled' | 'followSessionModel') => {
      if (!subagentModelsHost) return;
      apply(() => subagentModelsHost.toggle(field), `${field} toggled`);
    },
    [apply, subagentModelsHost],
  );

  return {
    openSubagentModelsPanel,
    onSubagentLaneEdit,
    onSubagentLaneClear,
    onSubagentPlanToggle,
  };
}
