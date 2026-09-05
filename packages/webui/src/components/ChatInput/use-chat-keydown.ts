import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileMentionState } from './file-mention-picker.js';
import { matchSlash } from './slash-commands.js';

export interface UseChatKeyDownOptions {
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  atMention: FileMentionState | null;
  promptHistory: string[];
  runSlashCommand: (raw: string) => boolean;
  handleSubmit: (e: React.FormEvent) => void;
}

export function useChatKeyDown({
  input,
  setInput,
  textareaRef,
  atMention,
  promptHistory,
  runSlashCommand,
  handleSubmit,
}: UseChatKeyDownOptions) {
  const [slashIndex, setSlashIndex] = useState(0);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const stickyDraftRef = useRef<string | null>(null);

  const slashSuggestions = input.startsWith('/') && !input.includes(' ') ? matchSlash(input) : [];

  useEffect(() => {
    if (slashIndex >= slashSuggestions.length) setSlashIndex(0);
  }, [slashSuggestions.length, slashIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (atMention && e.defaultPrevented) return;
      if (slashSuggestions.length === 0 && !atMention && promptHistory.length > 0) {
        if (e.key === 'ArrowUp') {
          const ta = e.currentTarget;
          const beforeCursor = ta.value.slice(0, ta.selectionStart);
          if (historyIdx >= 0 || beforeCursor.indexOf('\n') === -1) {
            e.preventDefault();
            if (historyIdx === -1) stickyDraftRef.current = ta.value;
            const next = Math.min(promptHistory.length - 1, historyIdx + 1);
            setHistoryIdx(next);
            const text = promptHistory[next] ?? '';
            setInput(text);
            requestAnimationFrame(() => {
              const el = textareaRef.current;
              if (el) {
                el.style.height = 'auto';
                el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
                el.setSelectionRange(text.length, text.length);
              }
            });
            return;
          }
        }
        if (e.key === 'ArrowDown' && historyIdx >= 0) {
          e.preventDefault();
          const next = historyIdx - 1;
          if (next < 0) {
            const restored = stickyDraftRef.current ?? '';
            stickyDraftRef.current = null;
            setHistoryIdx(-1);
            setInput(restored);
            requestAnimationFrame(() => {
              const el = textareaRef.current;
              if (el) {
                el.style.height = 'auto';
                el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
                el.setSelectionRange(restored.length, restored.length);
              }
            });
          } else {
            setHistoryIdx(next);
            const text = promptHistory[next] ?? '';
            setInput(text);
            requestAnimationFrame(() => {
              const el = textareaRef.current;
              if (el) {
                el.style.height = 'auto';
                el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
                el.setSelectionRange(text.length, text.length);
              }
            });
          }
          return;
        }
      }

      if (slashSuggestions.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSlashIndex((i) => (i + 1) % slashSuggestions.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSlashIndex((i) => (i - 1 + slashSuggestions.length) % slashSuggestions.length);
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          const pick = slashSuggestions[slashIndex];
          if (pick) {
            setInput(pick.name + ' ');
            setSlashIndex(0);
          }
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          const pick = slashSuggestions[slashIndex];
          if (pick && pick.name !== input.toLowerCase().trim()) {
            e.preventDefault();
            setInput('');
            runSlashCommand(pick.name);
            return;
          }
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setInput('');
          return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit(e);
      }
    },
    [
      slashSuggestions,
      slashIndex,
      atMention,
      promptHistory,
      historyIdx,
      input,
      runSlashCommand,
      handleSubmit,
      setInput,
      textareaRef,
    ],
  );

  return {
    slashIndex,
    setSlashIndex,
    slashSuggestions,
    historyIdx,
    setHistoryIdx,
    stickyDraftRef,
    handleKeyDown,
  };
}
