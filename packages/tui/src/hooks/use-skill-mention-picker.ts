import type { SkillLoader } from '@wrongstack/contracts/types';
import { detectSkillMention, matchSkillMentions } from '@wrongstack/core/skill-mentions';
import { type Dispatch, useEffect, useRef } from 'react';
import type { Action } from '../app-action-type.js';
import type { State } from '../app-state.js';

export function useSkillMentionPicker(
  state: State,
  loader: SkillLoader | undefined,
  dispatch: Dispatch<Action>,
): void {
  const latest = useRef(state);
  latest.current = state;
  const { buffer, cursor, bashMode } = state;
  useEffect(() => {
    const mention = bashMode ? null : detectSkillMention(buffer, cursor);
    if (!mention || !loader) {
      if (latest.current.skillPicker.mention) dispatch({ type: 'skillPickerClose' });
      return;
    }
    dispatch({ type: 'skillPickerOpen', entries: [], mention });
    dispatch({ type: 'skillPickerHint', text: 'Loading skills…' });
    let cancelled = false;
    void loader
      .listEntries()
      .then(async (entries) => {
        const descriptions = new Map(
          (await loader.list()).map((skill) => [skill.name, skill.description]),
        );
        if (cancelled) return;
        const matches = matchSkillMentions(
          entries.map((entry) => ({
            ...entry,
            description: descriptions.get(entry.name) ?? entry.trigger,
          })),
          mention.query,
        );
        dispatch({ type: 'skillMentionResults', entries: matches, mention });
      })
      .catch(() => {
        if (!cancelled)
          dispatch({
            type: 'skillMentionResults',
            entries: [],
            mention,
            hint: 'Unable to load skills',
          });
      });
    return () => {
      cancelled = true;
    };
  }, [buffer, cursor, bashMode, loader, dispatch]);
}
