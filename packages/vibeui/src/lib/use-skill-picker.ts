'use client';

import {
  detectSkillMention,
  insertSkillMention,
  matchSkillMentions,
  type SkillMentionCandidate,
} from '@wrongstack/webui-protocol';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { clientId } from './ids';
import { record, rows, text } from './session';
import type { SessionController } from './use-session';

export function useSkillPicker(
  input: string,
  setInput: (value: string) => void,
  textarea: React.RefObject<HTMLTextAreaElement | null>,
  controller: SessionController,
) {
  const { state, send, subscribe, connection } = controller;
  const listId = useId();
  const [cursor, setCursor] = useState(0);
  const [dismissed, setDismissed] = useState('');
  const [skills, setSkills] = useState<SkillMentionCandidate[]>([]);
  const [selected, setSelected] = useState(0);
  const [status, setStatus] = useState('Loading skills…');
  const selection = useRef<number | null>(null);
  const key = `${state.id}\0${input}\0${cursor}`;
  const mention = dismissed === key ? null : detectSkillMention(input, cursor);
  const open = Boolean(mention && connection === 'open');
  useEffect(() => {
    if (!open) return;
    const requestId = clientId();
    setSkills([]);
    setStatus('Loading skills…');
    const timer = setTimeout(() => setStatus('Skills could not be loaded. Close and retry.'), 5000);
    const off = subscribe((frame) => {
      const p = record(frame.payload);
      if (frame.type !== 'skills.list' || p.requestId !== requestId) return;
      clearTimeout(timer);
      setSkills(
        rows(p.skills)
          .filter((s) => text(s.name))
          .map((s) => ({ name: text(s.name), description: text(s.description) })),
      );
      setStatus(
        text(p.error) ||
          (p.enabled === false
            ? 'Skills are unavailable in this workspace.'
            : 'No matching skills.'),
      );
    });
    send('skills.list', { sessionId: state.id, requestId });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [open, state.id, send, subscribe]);
  useEffect(() => {
    setSelected(0);
  }, [mention?.query]);
  const matches = matchSkillMentions(skills, mention?.query ?? '');
  useEffect(() => {
    if (open)
      document.getElementById(`${listId}-${selected}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, listId, selected]);
  useLayoutEffect(() => {
    if (selection.current === null) return;
    textarea.current?.focus();
    textarea.current?.setSelectionRange(selection.current, selection.current);
    selection.current = null;
  }, [input, textarea]);
  const pick = (name: string) => {
    if (!mention) return;
    const next = insertSkillMention(input, mention, name);
    selection.current = next.cursor;
    setInput(next.text);
    setCursor(next.cursor);
  };
  return {
    open,
    listId,
    matches,
    total: skills.length,
    selected,
    status,
    pick,
    trackCursor: () => setCursor(textarea.current?.selectionStart ?? 0),
    onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open || event.nativeEvent.isComposing) return false;
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(key);
        return true;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setSelected((value) =>
          matches.length
            ? (value + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length
            : 0,
        );
        return true;
      }
      if (['PageDown', 'PageUp'].includes(event.key)) {
        event.preventDefault();
        setSelected((value) =>
          Math.max(0, Math.min(matches.length - 1, value + (event.key === 'PageDown' ? 8 : -8))),
        );
        return true;
      }
      if (!event.shiftKey && (event.key === 'Enter' || event.key === 'Tab')) {
        event.preventDefault();
        if (matches[selected]) pick(matches[selected].name);
        return true;
      }
      return false;
    },
  };
}
