import { Command, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFocusTrap } from './hooks/use-focus-trap.js';
import {
  type CommandPaletteAction,
  type CommandPaletteContext,
  commandPaletteItems,
  filterCommandPaletteItems,
} from './lib/command-palette-model.js';

interface CommandPaletteProps {
  open: boolean;
  context: CommandPaletteContext;
  onClose: () => void;
  onRun: (action: CommandPaletteAction) => void;
}

export function CommandPalette({ open, context, onClose, onRun }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  useFocusTrap(dialogRef, open);

  const items = useMemo(() => commandPaletteItems(context), [context]);
  const visibleItems = useMemo(() => filterCommandPaletteItems(items, query), [items, query]);
  const enabledItems = visibleItems.filter((item) => !item.disabled);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelectedIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (selectedIndex >= visibleItems.length) setSelectedIndex(0);
  }, [selectedIndex, visibleItems.length]);

  if (!open) return null;

  const run = (index: number) => {
    const item = visibleItems[index];
    if (!item || item.disabled) return;
    onRun(item.id);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((current) =>
        visibleItems.length === 0 ? 0 : (current + 1) % visibleItems.length,
      );
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((current) =>
        visibleItems.length === 0 ? 0 : (current - 1 + visibleItems.length) % visibleItems.length,
      );
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      run(selectedIndex);
    }
  };

  return (
    <>
      <button type="button" className="command-palette-overlay" tabIndex={-1} onClick={onClose} />
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="command-palette-head">
          <span>
            <Command size={14} aria-hidden="true" /> COMMANDS
          </span>
          <button type="button" onClick={onClose} aria-label="Close command palette">
            <X size={14} aria-hidden="true" />
          </button>
        </header>
        <div className="command-palette-search">
          <Search size={13} aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Type a command…"
            aria-label="Search commands"
            aria-activedescendant={
              visibleItems[selectedIndex]
                ? `command-palette-${visibleItems[selectedIndex].id}`
                : undefined
            }
          />
          <kbd>Esc</kbd>
        </div>
        <div className="command-palette-list" role="listbox" aria-label="Commands">
          {visibleItems.length === 0 && (
            <p className="command-palette-empty">No matching commands.</p>
          )}
          {visibleItems.map((item, index) => (
            <button
              key={item.id}
              id={`command-palette-${item.id}`}
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              disabled={item.disabled}
              className={`command-palette-item${index === selectedIndex ? ' selected' : ''}`}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => run(index)}
            >
              <span className="command-palette-item-main">
                <strong>{item.title}</strong>
                <small>{item.section}</small>
              </span>
              {item.hint && <kbd>{item.hint}</kbd>}
              {item.disabled && <span className="command-palette-disabled">Unavailable</span>}
            </button>
          ))}
        </div>
        <footer className="command-palette-foot">
          <span>{enabledItems.length} available</span>
          <span>↑↓ select · Enter run</span>
        </footer>
      </section>
    </>
  );
}
