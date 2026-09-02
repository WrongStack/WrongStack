import { ChevronDown, Eye, Search } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusTrap } from './hooks/use-focus-trap.js';
import type { PendingModelSwitch } from './hooks/use-model-catalog.js';
import { isVisionModel } from './lib/model-capabilities.js';
import {
  type ModelPickerRow,
  pushRecentModel,
  readRecentModels,
  searchModelRows,
} from './lib/model-catalog-view.js';
import type { ModelDescriptor } from './types.js';

export interface ModelSwitcherProps {
  selectedModel: string;
  groupedModels: [string, ModelDescriptor[]][];
  providerLabels: Record<string, string>;
  disabled: boolean;
  pendingModelSwitch: PendingModelSwitch | null;
  onSelectModel: (provider: string, model: string) => void;
  onConfirmSwitch: () => void;
  onCancelSwitch: () => void;
}

function formatWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

/**
 * With 1000+ catalog entries a native <select> is unusable: no search, no
 * dedupe hint, no recents. This picker keeps the same props contract as the
 * old select-based switcher but renders a searchable, keyboard-driven listbox
 * (the same interaction pattern as the command palette).
 */
export function ModelSwitcher(props: ModelSwitcherProps): React.JSX.Element {
  const {
    selectedModel,
    groupedModels,
    providerLabels,
    disabled,
    pendingModelSwitch,
    onSelectModel,
    onConfirmSwitch,
    onCancelSwitch,
  } = props;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recents, setRecents] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  useFocusTrap(dialogRef, open);

  const allRows = useMemo(
    () => searchModelRows(groupedModels, providerLabels, ''),
    [groupedModels, providerLabels],
  );
  const queryRows = useMemo(
    () => (query.trim() ? searchModelRows(groupedModels, providerLabels, query).slice(0, 200) : []),
    [groupedModels, providerLabels, query],
  );

  const recentRows = useMemo(() => {
    if (query.trim()) return [];
    const byValue = new Map(allRows.map((row) => [`${row.provider}\t${row.entry.id}`, row]));
    return recents
      .map((value) => byValue.get(value))
      .filter((row): row is ModelPickerRow => Boolean(row));
  }, [allRows, query, recents]);

  // Unfiltered catalogs can hold 1000+ rows; cap the initial render and let
  // search narrow the rest.
  const browsingRows = useMemo(() => (query.trim() ? [] : allRows.slice(0, 80)), [allRows, query]);

  const visible: ModelPickerRow[] = useMemo(() => {
    if (query.trim()) return queryRows;
    return recentRows.length > 0 || browsingRows.length > 0 ? [...recentRows, ...browsingRows] : [];
  }, [browsingRows, query, queryRows, recentRows]);

  useEffect(() => {
    if (selectedIndex >= visible.length) setSelectedIndex(0);
  }, [selectedIndex, visible.length]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelectedIndex(0);
    setRecents(readRecentModels());
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const selectedLabel = useMemo(() => {
    if (!selectedModel) return 'No model';
    const tabIndex = selectedModel.indexOf('\t');
    const provider = tabIndex === -1 ? '' : selectedModel.slice(0, tabIndex);
    const model = tabIndex === -1 ? selectedModel : selectedModel.slice(tabIndex + 1);
    const entries = groupedModels.find(([p]) => p === provider)?.[1] ?? [];
    const entry = entries.find((candidate) => candidate.id === model);
    return entry?.name ?? model;
  }, [groupedModels, selectedModel]);

  if (!open) {
    return (
      <div className="model-control">
        <button
          type="button"
          className="model-select-trigger"
          disabled={disabled || groupedModels.length === 0}
          aria-haspopup="dialog"
          aria-expanded={false}
          aria-label="Switch model"
          title={selectedLabel}
          onClick={() => setOpen(true)}
        >
          <span className="model-select-trigger-name">
            {groupedModels.length === 0 ? 'Loading models…' : selectedLabel}
          </span>
          <ChevronDown size={11} className="select-chevron" aria-hidden="true" />
        </button>
        {pendingModelSwitch && (
          <PendingSwitchWarning
            pendingModelSwitch={pendingModelSwitch}
            onConfirmSwitch={onConfirmSwitch}
            onCancelSwitch={onCancelSwitch}
          />
        )}
      </div>
    );
  }

  const choose = (row: ModelPickerRow) => {
    pushRecentModel(row.provider, row.entry.id);
    onSelectModel(row.provider, row.entry.id);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((current) => (visible.length === 0 ? 0 : (current + 1) % visible.length));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((current) =>
        visible.length === 0 ? 0 : (current - 1 + visible.length) % visible.length,
      );
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const row = visible[selectedIndex];
      if (row) choose(row);
    }
  };

  return (
    <div className="model-control">
      <button
        type="button"
        className="settings-overlay"
        tabIndex={-1}
        aria-label="Close model picker"
        onClick={() => setOpen(false)}
      />
      <section
        className="model-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Switch model"
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="model-picker-search">
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
            placeholder="Search models…"
            aria-label="Search models"
            aria-activedescendant={
              visible[selectedIndex] ? `model-option-${selectedIndex}` : undefined
            }
          />
          <kbd>Esc</kbd>
        </div>
        <div className="model-picker-list" role="listbox" aria-label="Models">
          {visible.length === 0 && (
            <p className="model-picker-empty">
              {groupedModels.length === 0
                ? 'Loading models…'
                : query.trim()
                  ? 'No matching models.'
                  : 'No models available.'}
            </p>
          )}
          {recentRows.length > 0 && !query.trim() && <p className="model-picker-section">RECENT</p>}
          {visible.map((row, index) => {
            const isSelected = `${row.provider}\t${row.entry.id}` === selectedModel;
            const vision = isVisionModel(row.entry.id);
            const window = row.entry.contextWindow
              ? ` · ${formatWindow(row.entry.contextWindow)}`
              : '';
            return (
              <Fragment key={`${row.provider}\t${row.entry.id}`}>
                {!query.trim() && index === recentRows.length && browsingRows.length > 0 && (
                  <p className="model-picker-section">ALL MODELS</p>
                )}
                <button
                  type="button"
                  id={`model-option-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  className={`model-picker-item${index === selectedIndex ? ' selected' : ''}${isSelected ? ' current' : ''}`}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => choose(row)}
                >
                  <span className="model-picker-item-main">
                    <strong>
                      {row.entry.name}
                      {window}
                    </strong>
                    <small>{row.providerLabel}</small>
                  </span>
                  {vision && (
                    <Eye size={12} className="model-picker-vision" aria-label="Vision capable" />
                  )}
                </button>
              </Fragment>
            );
          })}
          {!query.trim() && allRows.length > browsingRows.length && (
            <p className="model-picker-more" role="note">
              Showing {browsingRows.length} of {allRows.length} — type to search
            </p>
          )}
        </div>
        <footer className="model-picker-foot">
          <span>{allRows.length} models</span>
          <span>↑↓ select · Enter switch</span>
        </footer>
      </section>
      {pendingModelSwitch && (
        <PendingSwitchWarning
          pendingModelSwitch={pendingModelSwitch}
          onConfirmSwitch={onConfirmSwitch}
          onCancelSwitch={onCancelSwitch}
        />
      )}
    </div>
  );
}

function PendingSwitchWarning(props: {
  pendingModelSwitch: PendingModelSwitch;
  onConfirmSwitch: () => void;
  onCancelSwitch: () => void;
}): React.JSX.Element {
  const { pendingModelSwitch, onConfirmSwitch, onCancelSwitch } = props;
  return (
    <div className="model-switch-warning" role="alertdialog" aria-label="Smaller context window">
      <p>
        <strong>{pendingModelSwitch.modelName}</strong> has a smaller context window (
        {formatWindow(pendingModelSwitch.nextWindow)} vs current{' '}
        {formatWindow(pendingModelSwitch.currentWindow)}). The session may need to compact mid-run.
      </p>
      <div className="model-switch-warning-actions">
        <button type="button" className="model-switch-confirm" onClick={onConfirmSwitch}>
          Switch anyway
        </button>
        <button type="button" className="model-switch-cancel" onClick={onCancelSwitch}>
          Cancel
        </button>
      </div>
    </div>
  );
}
