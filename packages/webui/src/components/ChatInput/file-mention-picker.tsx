import type React from 'react';
import { useFileReferenceStore } from '@/stores/file-reference-store.js';
import { FilePicker } from '../FilePicker';

export interface FileMentionState {
  start: number;
  query: string;
}

interface FileMentionPickerProps {
  atMention: FileMentionState | null;
  input: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  setInput: (value: string) => void;
  setAtMention: (value: FileMentionState | null) => void;
}

export function FileMentionPicker({
  atMention,
  input,
  textareaRef,
  setInput,
  setAtMention,
}: FileMentionPickerProps) {
  const { addRef } = useFileReferenceStore.getState();

  if (!atMention) return null;

  return (
    <FilePicker
      query={atMention.query}
      onClose={() => setAtMention(null)}
      onPick={(path) => {
        // Remove the partial `@query` token from the textarea and add the
        // chosen file as a reference chip instead of plain text.
        const before = input.slice(0, atMention.start);
        const after = input.slice(atMention.start + 1 + atMention.query.length);
        const next = `${before}${after}`.replace(/\s+/g, ' ').trim();
        setInput(next);
        setAtMention(null);
        addRef({ kind: 'file', path });
        requestAnimationFrame(() => {
          const textarea = textareaRef.current;
          if (textarea) {
            const pos = atMention.start;
            textarea.focus();
            textarea.setSelectionRange(pos, pos);
            textarea.style.height = 'auto';
            textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
          }
        });
      }}
    />
  );
}
