import { type Dispatch, useCallback, useEffect } from 'react';
import type { AppProps } from '../app-props.js';
import type { Action } from '../app-action-type.js';
import type { State } from '../app-state.js';
import { buildSlashCommandMatches } from '../slash-command-search.js';

interface SlashPickerOptions {
  state: State;
  slashRegistry: AppProps['slashRegistry'];
  dispatch: Dispatch<Action>;
  setDraft: (buffer: string, cursor: number) => void;
}

/** Synchronizes the slash menu with the active command token. */
export function useSlashPicker({
  state,
  slashRegistry,
  dispatch,
  setDraft,
}: SlashPickerOptions): () => void {
  useEffect(() => {
    const trimmed = state.buffer.trimStart();
    if (!trimmed.startsWith('/') || /\s/.test(trimmed)) {
      if (state.slashPicker.open) dispatch({ type: 'slashPickerClose' });
      return;
    }
    const query = trimmed.slice(1).toLowerCase();
    const matches = buildSlashCommandMatches(slashRegistry.listWithOwner(), query);
    if (!state.slashPicker.open || state.slashPicker.query !== query) {
      dispatch({ type: 'slashPickerOpen', query, matches });
    }
  }, [state.buffer, state.slashPicker.open, state.slashPicker.query, slashRegistry, dispatch]);

  return useCallback(() => {
    const { open, matches, selected } = state.slashPicker;
    if (!open || matches.length === 0) return;
    const picked = matches[selected];
    if (!picked) return;
    const command = picked.argsHint !== undefined ? `/${picked.name} ` : `/${picked.name}`;
    setDraft(command, command.length);
    dispatch({ type: 'slashPickerClose' });
  }, [state.slashPicker, setDraft, dispatch]);
}
