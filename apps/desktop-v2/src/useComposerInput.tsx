import { detectSkillMention, insertSkillMention } from '@wrongstack/webui-protocol';
import { Terminal } from 'lucide-react';
import { type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { ComposerMentionPicker } from './ComposerMentionPicker';
import {
  type ComposerFileReference,
  desktopCommands,
  fileMention,
  withReference,
} from './composer-resources-model';
import type { ChatMessage } from './engine-state';

export function useComposerInput({
  draft,
  onDraftChange,
  references,
  onReferencesChange,
  messages,
  projectId,
  textarea,
}: {
  draft: string;
  onDraftChange: (text: string) => void;
  references: ComposerFileReference[];
  onReferencesChange: (refs: ComposerFileReference[]) => void;
  messages: ChatMessage[];
  projectId: string;
  textarea: RefObject<HTMLTextAreaElement | null>;
}) {
  const [cursor, setCursor] = useState(draft.length),
    [dismissed, setDismissed] = useState(''),
    [commandIndex, setCommandIndex] = useState(0);
  const keys = useRef<((key: string) => void) | null>(null),
    pending = useRef<{ text: string; cursor: number } | null>(null),
    history = useRef({ index: -1, sticky: '', emitted: '' });
  const identity = `${draft}\0${cursor}`;
  const skill = dismissed === identity ? null : detectSkillMention(draft, cursor);
  const file = dismissed === identity || skill ? null : fileMention(draft, cursor);
  const commandQuery =
    dismissed !== identity && /^\/[\w!-]*$/.test(draft) ? draft.toLowerCase() : null;
  const commands =
    commandQuery === null
      ? []
      : desktopCommands.filter(
          (command) =>
            command.name.startsWith(commandQuery) ||
            ('aliases' in command &&
              command.aliases.some((alias) => alias.startsWith(commandQuery))),
        );
  const replace = (text: string, nextCursor = text.length) => {
    pending.current = { text, cursor: nextCursor };
    onDraftChange(text);
    setCursor(nextCursor);
  };
  useLayoutEffect(() => {
    const next = pending.current;
    if (next && textarea.current?.value === next.text) {
      pending.current = null;
      textarea.current.focus();
      textarea.current.setSelectionRange(next.cursor, next.cursor);
    }
  }, [draft, cursor, textarea]);
  const dismiss = () => setDismissed(identity);
  const pick = (value: string) => {
    if (skill) {
      const next = insertSkillMention(draft, skill, value);
      replace(next.text, next.cursor);
    } else if (file) {
      const whole = withReference(references, { path: value });
      if (whole.length !== references.length) onReferencesChange(whole);
      const next = draft.slice(0, file.start) + draft.slice(file.end);
      replace(next, file.start);
    }
    history.current.index = -1;
  };
  const onKey = (key: string, shift: boolean): boolean => {
    if (
      (skill || file) &&
      ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown'].includes(key) &&
      !(key === 'Enter' && shift)
    ) {
      keys.current?.(key);
      if (key === 'Escape') dismiss();
      return true;
    }
    if (
      commandQuery !== null &&
      commands.length &&
      ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown'].includes(key) &&
      !(key === 'Enter' && shift)
    ) {
      if (key === 'Escape') dismiss();
      else if (key === 'ArrowDown' || key === 'ArrowUp')
        setCommandIndex(
          (index) => (index + (key === 'ArrowDown' ? 1 : commands.length - 1)) % commands.length,
        );
      else {
        const command = commands[Math.min(commandIndex, commands.length - 1)];
        if (command) replace(`${command.name} `);
      }
      return true;
    }
    const element = textarea.current;
    if (!element || shift || !['ArrowUp', 'ArrowDown'].includes(key)) return false;
    const promptHistory = [
      ...new Set(
        messages
          .filter((message) => message.role === 'user')
          .map((message) => message.text)
          .reverse(),
      ),
    ].slice(0, 50);
    const item = history.current;
    if (item.index >= 0 && item.emitted !== draft) item.index = -1;
    if (
      key === 'ArrowUp' &&
      promptHistory.length &&
      (item.index >= 0 || !draft.slice(0, element.selectionStart).includes('\n'))
    ) {
      if (item.index < 0) item.sticky = draft;
      item.index = Math.min(item.index + 1, promptHistory.length - 1);
      item.emitted = promptHistory[item.index]!;
      replace(item.emitted);
      return true;
    }
    if (key === 'ArrowDown' && item.index >= 0) {
      item.index--;
      item.emitted = item.index < 0 ? item.sticky : promptHistory[item.index]!;
      replace(item.emitted);
      return true;
    }
    return false;
  };
  const popup =
    skill || file ? (
      <ComposerMentionPicker
        projectId={projectId}
        kind={skill ? 'skill' : 'file'}
        query={skill?.query ?? file?.query ?? ''}
        onPick={pick}
        onDismiss={dismiss}
        keys={keys}
      />
    ) : commandQuery !== null && commands.length ? (
      <section
        className="composer-mention-popup command-suggestions"
        aria-label="Desktop command suggestions"
      >
        <header>
          <Terminal size={14} /> Desktop commands
          <small>↑↓ select · Enter/Tab complete · Enter again runs</small>
        </header>
        <div role="listbox" aria-label="Desktop commands">
          {commands.map((command, i) => (
            <button
              type="button"
              role="option"
              aria-selected={i === Math.min(commandIndex, commands.length - 1)}
              key={command.name}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => replace(`${command.name} `)}
            >
              <strong>{command.name}</strong>
              <span>{command.description}</span>
            </button>
          ))}
        </div>
      </section>
    ) : null;
  return {
    popup,
    onKey,
    replace,
    onSelect: (position: number) => setCursor(position),
    onChange: (text: string, position: number) => {
      history.current.index = -1;
      setCommandIndex(0);
      onDraftChange(text);
      setCursor(position);
    },
  };
}
