import { useCallback } from 'react';
import type { Action } from '../app-reducer.js';
import type { AppProps } from '../app-props.js';

export function useHelpPanel(
  dispatch: React.Dispatch<Action>,
  slashRegistry: AppProps['slashRegistry'],
): {
  openHelpPanel: () => void;
} {
  const openHelpPanel = useCallback(() => {
    const entries = Array.from(slashRegistry.listWithOwner()).map(({ cmd, owner }) => ({
      name: owner === 'core' ? cmd.name : `${owner}:${cmd.name}`,
      description: cmd.description,
      category: cmd.category ?? 'App',
      aliases: cmd.aliases,
      argsHint: cmd.argsHint,
    }));
    dispatch({ type: 'helpOpen', entries });
  }, [dispatch, slashRegistry]);

  return { openHelpPanel };
}
