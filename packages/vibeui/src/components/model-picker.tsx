'use client';

import { isAcpProvider } from '@wrongstack/webui-protocol';
import { Check, ChevronDown, RefreshCw, Search, Settings2, Sparkles, Zap } from 'lucide-react';
import { Popover } from 'radix-ui';
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { SessionState } from '../lib/session';
import { effortOptions } from '../lib/workspace-model';

export const ModelPicker = memo(function ModelPicker({
  models,
  providers,
  provider,
  model,
  locked,
  pending,
  onChoose,
  onSettings,
  onRefresh,
}: {
  models: SessionState['models'];
  providers: SessionState['providers'];
  provider: string;
  model: string;
  locked: boolean;
  pending: boolean;
  onChoose: (provider: string, model: string, context: number) => void;
  onSettings: (open: boolean) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const matches = useMemo(
    () =>
      Object.entries(models)
        .flatMap(([owner, entries]) =>
          entries.map((entry) => ({
            ...entry,
            provider: owner,
            label: providers.find((p) => p.id === owner)?.name || owner,
          })),
        )
        .filter((entry) =>
          `${entry.name} ${entry.id} ${entry.label}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
        ),
    [models, providers, query],
  );
  const visible = matches.slice(0, 100);
  useEffect(() => {
    setActive(0);
  }, [query, open]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('.modal-content')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !locked) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [locked]);
  const choose = (entry: (typeof visible)[number]) => {
    onChoose(entry.provider, entry.id, entry.contextWindow);
    setOpen(false);
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) setQuery('');
      }}
    >
      <Popover.Trigger className="model-trigger" disabled={locked} title="Choose a model · Ctrl+K">
        <span className="model-symbol">
          <Sparkles size={13} />
        </span>
        {isAcpProvider(provider) && <span className="acp-runtime-badge">ACP agent</span>}
        <span>{pending ? 'Switching model…' : model || 'Choose a model'}</span>
        <ChevronDown size={13} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="model-popover"
          sideOffset={8}
          align="start"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            input.current?.focus();
          }}
        >
          <label className="model-search">
            <Search size={16} />
            <input
              ref={input}
              role="combobox"
              aria-label="Search models"
              aria-expanded={open}
              aria-controls={id}
              aria-activedescendant={visible[active] ? `${id}-${active}` : undefined}
              autoComplete="off"
              placeholder="Search models or providers…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  const next = visible.length
                    ? (active + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) %
                      visible.length
                    : 0;
                  setActive(next);
                  document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: 'nearest' });
                } else if (event.key === 'Enter' && visible[active]) {
                  event.preventDefault();
                  choose(visible[active]);
                }
              }}
            />
            <kbd>esc</kbd>
          </label>
          <div className="model-results" role="listbox" id={id} aria-label="Models">
            {visible.map((entry, index) => (
              <button
                type="button"
                role="option"
                aria-selected={entry.provider === provider && entry.id === model}
                id={`${id}-${index}`}
                key={`${entry.provider}/${entry.id}`}
                className={active === index ? 'highlighted' : ''}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(entry)}
              >
                <span>
                  <strong>{entry.name}</strong>
                  {isAcpProvider(entry.provider) && (
                    <span className="acp-runtime-badge">ACP agent</span>
                  )}
                  <small>
                    {entry.label} ·{' '}
                    {entry.contextWindow
                      ? `${Math.round(entry.contextWindow / 1000)}k context`
                      : 'Context not listed'}
                  </small>
                </span>
                {entry.provider === provider && entry.id === model && <Check size={15} />}
              </button>
            ))}
            {!matches.length && (
              <p className="model-no-results">
                {Object.keys(models).length
                  ? 'No matching models. Try another name.'
                  : 'Connect a provider to discover its models.'}
              </p>
            )}
          </div>
          <div className="model-picker-footer">
            <span>
              {matches.length > visible.length
                ? `First ${visible.length} of ${matches.length} · narrow your search`
                : `${matches.length} models`}
            </span>
            <button type="button" aria-label="Refresh models" onClick={onRefresh}>
              <RefreshCw size={14} />
            </button>
            <button
              type="button"
              aria-label="Provider settings"
              onClick={() => {
                setOpen(false);
                onSettings(true);
              }}
            >
              <Settings2 size={14} />
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});

export function EffortSelect({
  state,
  disabled,
  onChange,
}: {
  state: SessionState;
  disabled: boolean;
  onChange: (effort: string) => void;
}) {
  if (state.effortSupported === false) return null;
  const current =
    typeof state.prefs.reasoningEffort === 'string' ? state.prefs.reasoningEffort : 'auto';
  return (
    <label
      className="effort-control"
      title={
        current === 'auto'
          ? `Follows the project setting${state.projectEffort ? `: ${state.projectEffort}` : ''}`
          : 'Reasoning effort for this session'
      }
    >
      <Zap size={12} />
      <select
        aria-label="Reasoning effort"
        value={current}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {effortOptions(state.effortLevels, current).map((value) => (
          <option value={value} key={value}>
            {value === 'auto'
              ? 'Auto effort'
              : value === 'xhigh'
                ? 'Extra high'
                : `${value[0]?.toUpperCase()}${value.slice(1)}`}
          </option>
        ))}
      </select>
    </label>
  );
}
