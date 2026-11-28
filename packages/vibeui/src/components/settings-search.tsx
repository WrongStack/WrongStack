'use client';

import { Search, X } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';

export function SettingsSearch({ children }: { children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<{ label: string; hint: string; element: HTMLElement }[]>(
    [],
  );
  const search = (value: string) => {
    setQuery(value);
    const terms = value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    setMatches(
      terms.length
        ? Array.from(content.current?.querySelectorAll<HTMLElement>('.settings-row') ?? []).flatMap(
            (element) => {
              const label = element.querySelector('strong')?.textContent ?? '';
              const hint = element.querySelector('small')?.textContent ?? '';
              const group = element.closest('details')?.querySelector('summary')?.textContent ?? '';
              return terms.every((term) => `${label} ${hint} ${group}`.toLowerCase().includes(term))
                ? [{ label, hint: group || hint, element }]
                : [];
            },
          )
        : [],
    );
  };
  return (
    <>
      <label className="settings-search file-search" data-settings-searching={Boolean(query)}>
        <Search size={15} />
        <input
          ref={input}
          aria-label="Search settings"
          placeholder="Find a setting…"
          value={query}
          onChange={(event) => search(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.preventDefault();
              event.stopPropagation();
              search('');
            }
          }}
        />
        {query && (
          <button
            type="button"
            className="icon-button"
            aria-label="Clear settings search"
            onClick={() => {
              search('');
              input.current?.focus();
            }}
          >
            <X size={14} />
          </button>
        )}
      </label>
      <p className="sr-only" role="status">
        {query.trim() ? `${matches.length} matching settings` : ''}
      </p>
      {query.trim() && (
        <section className="command-results" aria-label="Matching settings">
          <p className="fine-print">{matches.length} matching settings</p>
          {matches.map(({ label, hint, element }) => (
            <button
              type="button"
              key={label}
              onClick={() => {
                search('');
                let ancestor = element.parentElement;
                while (ancestor) {
                  if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
                  ancestor = ancestor.parentElement;
                }
                requestAnimationFrame(() => {
                  element.scrollIntoView({ block: 'center' });
                  element
                    .querySelector<HTMLElement>('input, select, button')
                    ?.focus({ preventScroll: true });
                });
              }}
            >
              <strong>{label}</strong>
              <small>{hint}</small>
            </button>
          ))}
          {!matches.length && (
            <p className="panel-hint">
              Try “reasoning”, “compaction”, “subagents” or “appearance”.
            </p>
          )}
        </section>
      )}
      <div ref={content} hidden={Boolean(query.trim())}>
        {children}
      </div>
    </>
  );
}
