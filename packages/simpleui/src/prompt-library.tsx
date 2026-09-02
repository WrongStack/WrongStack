import { Bookmark, Plus, Trash2, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useFocusTrap } from './hooks/use-focus-trap.js';
import { onSimplePanel } from './lib/panel-events.js';
import { readPersisted, writePersisted } from './lib/persisted.js';

interface SavedPrompt {
  id: string;
  text: string;
  label: string;
  savedAt: number;
}

const STORAGE_KEY = 'wrongstack.simpleui.prompts';
const STORAGE_VERSION = 1;

function isValidPrompt(value: unknown): value is SavedPrompt {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as SavedPrompt).id === 'string' &&
    typeof (value as SavedPrompt).text === 'string'
  );
}

function loadPrompts(): SavedPrompt[] {
  const stored = readPersisted<SavedPrompt[]>(STORAGE_KEY, {
    version: STORAGE_VERSION,
    validate: (value) => (Array.isArray(value) && value.every(isValidPrompt) ? value : null),
  });
  return stored ?? [];
}

function savePrompts(prompts: SavedPrompt[]): boolean {
  return writePersisted(STORAGE_KEY, STORAGE_VERSION, prompts);
}

interface PromptLibraryProps {
  onRecall: (text: string) => void;
}

export function PromptLibrary({ onRecall }: PromptLibraryProps) {
  const [open, setOpen] = useState(false);
  const [prompts, setPrompts] = useState<SavedPrompt[]>(loadPrompts);
  const [newText, setNewText] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [storageWarning, setStorageWarning] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  useFocusTrap(dialogRef, open);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    return onSimplePanel('open-prompt-library', onOpen);
  }, []);

  const add = () => {
    if (!newText.trim()) return;
    const p: SavedPrompt = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text: newText.trim(),
      label: newLabel.trim() || newText.trim().slice(0, 40),
      savedAt: Date.now(),
    };
    const updated = [p, ...prompts];
    setPrompts(updated);
    setStorageWarning(!savePrompts(updated));
    setNewText('');
    setNewLabel('');
  };

  const remove = (id: string) => {
    const updated = prompts.filter((p) => p.id !== id);
    setPrompts(updated);
    setStorageWarning(!savePrompts(updated));
  };

  if (!open) {
    return (
      <button
        type="button"
        className="prompt-library-trigger"
        title="Prompt library"
        aria-label="Open prompt library"
        onClick={() => setOpen(true)}
      >
        <Bookmark size={13} aria-hidden="true" />
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        className="settings-overlay"
        tabIndex={-1}
        onClick={() => setOpen(false)}
      />
      <aside
        className="prompt-library"
        role="dialog"
        aria-modal="true"
        aria-label="Prompt library"
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="prompt-library-head">
          <span>
            <Bookmark size={13} aria-hidden="true" /> PROMPTS
          </span>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close" ref={closeRef}>
            <X size={14} />
          </button>
        </header>
        <div className="prompt-library-add">
          <input
            type="text"
            placeholder="Label"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
          />
          <textarea
            placeholder="Prompt text…"
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            rows={3}
          />
          <button type="button" onClick={add} disabled={!newText.trim()}>
            <Plus size={12} aria-hidden="true" /> Save
          </button>
          {storageWarning && (
            <p className="prompt-library-storage-warning" role="alert">
              <TriangleAlert size={12} aria-hidden="true" /> Could not save — browser storage is
              full or blocked.
            </p>
          )}
        </div>
        <div className="prompt-library-list">
          {prompts.length === 0 && <p className="prompt-library-empty">No saved prompts yet.</p>}
          {prompts.map((p) => (
            <article key={p.id} className="prompt-item">
              <button
                type="button"
                className="prompt-item-recall"
                onClick={() => {
                  onRecall(p.text);
                  setOpen(false);
                }}
              >
                <strong>{p.label}</strong>
                <span>{p.text.length > 80 ? `${p.text.slice(0, 77)}…` : p.text}</span>
              </button>
              <button
                type="button"
                className="prompt-item-remove"
                aria-label={`Remove "${p.label}"`}
                onClick={() => remove(p.id)}
              >
                <Trash2 size={12} aria-hidden="true" />
              </button>
            </article>
          ))}
        </div>
      </aside>
    </>
  );
}
