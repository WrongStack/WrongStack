'use client';

import { ArrowUpRight, Command, MessageSquare } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { WorkspaceCommand } from '../lib/workspace-commands';
import { Modal } from './dialogs';
import { SearchHighlight } from './search-highlight';

export type { WorkspaceCommand };
export function CommandPalette({
  commands,
  onClose,
}: {
  commands: WorkspaceCommand[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = commands.filter((command) =>
    terms.every((term) => `${command.title} ${command.detail}`.toLowerCase().includes(term)),
  );
  const available = matches.flatMap((command, index) => (command.disabled ? [] : [index]));
  const active = available.includes(selected) ? selected : (available[0] ?? -1);
  useEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [listId, active, query]);
  const choose = (index: number) => {
    const command = matches[index];
    if (!command || command.disabled) return;
    onClose();
    command.run();
  };
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Quick actions"
      initialFocusRef={input}
      description="Find a workspace action or jump to a recent session. Ctrl/Cmd+P opens this menu."
    >
      <input
        ref={input}
        className="context-search"
        role="combobox"
        aria-label="Search actions"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={matches[active] ? `${listId}-${active}` : undefined}
        placeholder="Search commands, resources or sessions…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelected(0);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (available.length)
              setSelected(
                available[
                  (available.indexOf(active) +
                    (e.key === 'ArrowDown' ? 1 : -1) +
                    available.length) %
                    available.length
                ] ?? active,
              );
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            choose(active);
          }
        }}
      />
      <div id={listId} role="listbox" aria-label="Workspace actions" className="command-results">
        {matches.map((command, index) => (
          <button
            type="button"
            role="option"
            aria-selected={active === index}
            aria-disabled={command.disabled === true}
            id={`${listId}-${index}`}
            key={command.id}
            onClick={() => choose(index)}
          >
            <strong>
              {command.id.startsWith('session-') ? (
                <MessageSquare size={15} />
              ) : (
                <Command size={15} />
              )}
              <span className="search-title-text">
                <SearchHighlight value={command.title} query={query} />
              </span>
              <ArrowUpRight size={13} className="search-result-arrow" />
            </strong>
            <small>
              <SearchHighlight value={command.detail} query={query} />
              {command.disabled ? ' · Unavailable right now' : ''}
            </small>
          </button>
        ))}
      </div>
      {!matches.length && <p className="panel-hint">No matching actions.</p>}
      <div className="search-footer">
        <span>
          {matches.length} {matches.length === 1 ? 'result' : 'results'}
        </span>
        <span>
          <kbd>↑↓</kbd> navigate <kbd>↵</kbd> open
        </span>
      </div>
    </Modal>
  );
}
