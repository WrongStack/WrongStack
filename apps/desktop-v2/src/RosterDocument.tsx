import { Copy, Pencil, Save, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { DraftMergeChoices } from './DraftMergeChoices';
import type { EngineCommand } from './engine-operations';
import { MarkdownContent } from './MarkdownContent';
import { Modal } from './Modal';
import { rosterDocumentDraft } from './roster-document-store';
import { rosterDocumentKey } from './roster-model';

export type RosterDocumentKind = 'identity' | 'learned' | 'consolidated' | 'skill';
const labels = {
  identity: 'Identity instructions',
  learned: 'Learned directives',
  consolidated: 'Consolidated knowledge',
  skill: 'Skill addendum',
};
const localDrafts = new Map<string, { base: string; text: string }>();
export function RosterDocument({
  projectId,
  role,
  kind,
  skill = '',
  command,
  onClose,
  onSaved,
  onLink,
}: {
  projectId: string;
  role: string;
  kind: RosterDocumentKind;
  skill?: string;
  command: EngineCommand;
  onClose: () => void;
  onSaved: () => void;
  onLink?: (url: string) => void;
}) {
  const key = rosterDocumentKey(projectId, role, `${kind}:${skill}`);
  const cached = useRef(localDrafts.get(key)).current;
  const [base, setBase] = useState(cached?.base ?? ''),
    [text, setText] = useState(cached?.text ?? '');
  const [loaded, setLoaded] = useState(!!cached),
    [editing, setEditing] = useState(!!cached);
  const [readAttempt, setReadAttempt] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [leaving, setLeaving] = useState(false),
    [conflict, setConflict] = useState<string | null>(null);
  const durable = useMemo(
    () => rosterDocumentDraft(projectId, { role, kind, skill }),
    [projectId, role, kind, skill],
  );
  const durableState = useSyncExternalStore(durable.subscribe, durable.snapshot);
  const [recovered, setRecovered] = useState(false);
  // Drops the in-window copy and the device copy together.
  const forget = () => {
    localDrafts.delete(key);
    if (durable.snapshot().ready && durable.snapshot().value) durable.edit(null);
  };
  const live = useRef(true),
    sequence = useRef(0),
    saving = useRef(false);
  const dirty = text !== base;
  const read = useCallback(async () => {
    const type =
      kind === 'identity'
        ? 'agent-roster.read-customization'
        : kind === 'learned'
          ? 'agent-roster.read-learned'
          : kind === 'skill'
            ? 'agent-roster.read-skill'
            : 'agent-roster.read-consolidated';
    const result = await command(
      type,
      {
        role,
        ...(kind === 'identity' ? { documents: ['identity'] } : {}),
        ...(skill ? { skill } : {}),
      },
      [type],
    );
    return String(result[kind === 'identity' ? 'identity' : 'content'] ?? '');
  }, [command, role, kind, skill]);
  useEffect(() => {
    live.current = true;
    const version = ++sequence.current;
    setError('');
    void read()
      .then(async (stored) => {
        if (!live.current || version !== sequence.current) return;
        if (!cached) {
          await durable.load();
          if (!live.current || version !== sequence.current) return;
          const parked = durable.snapshot().value;
          if (parked) {
            // Recovered edits keep their original baseline; a changed store opens the comparison.
            setBase(parked.base);
            setText(parked.text);
            setEditing(true);
            setRecovered(true);
            localDrafts.set(key, parked);
            if (stored !== parked.base) setConflict(stored);
          } else {
            setBase(stored);
            setText(stored);
          }
        }
        setLoaded(true);
      })
      .catch((error) => {
        if (live.current && version === sequence.current) setError(String(error));
      });
    return () => {
      live.current = false;
      sequence.current++;
    };
  }, [key, read, cached, readAttempt]);
  const change = (value: string) => {
    setText(value);
    localDrafts.set(key, { base, text: value });
    if (durable.snapshot().ready) durable.edit(value === base ? null : { base, text: value });
    setNotice('');
  };
  const close = () => {
    if (busy) return;
    if (dirty) setLeaving(true);
    else {
      forget();
      onClose();
    }
  };
  const save = async (reviewed?: string) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      const current = await read();
      if (current !== (reviewed ?? base)) {
        setConflict(current);
        throw Error('The stored document changed. Compare the current text before replacing it.');
      }
      if ((kind === 'skill' || kind === 'consolidated') && !text.trim())
        throw Error(
          'Use the dedicated clear action to remove this document. Empty synthesis is not saved.',
        );
      const type =
        kind === 'identity'
          ? 'agent-roster.update-identity'
          : kind === 'learned'
            ? 'agent-roster.update-learned'
            : kind === 'skill'
              ? 'agent-roster.save-skill'
              : 'agent-roster.save-consolidated';
      await command(type, { role, content: text, ...(skill ? { skill } : {}) }, [type]);
      const actual = await read();
      // Canonical role loaders trim document boundaries, including identity and learned text.
      const expected = text.trim();
      const verified = actual.trim();
      if (verified !== expected) {
        setConflict(actual);
        throw Error(
          'The engine stored a different or bounded version. Your full local text is preserved; review the stored version.',
        );
      }
      if (!live.current) return;
      setBase(actual);
      setText(actual);
      forget();
      setEditing(false);
      setConflict(null);
      setNotice('Project document saved and read back.');
      onSaved();
    } catch (error) {
      if (live.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      saving.current = false;
      if (live.current) setBusy(false);
    }
  };
  return (
    <Modal title={`${labels[kind]} for ${role}`} onClose={close}>
      <div className="roster-document">
        <header>
          <div>
            <span className="eyebrow">
              {role}
              {skill ? ` · ${skill}` : ''}
            </span>
            <h2>{labels[kind]}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close role document"
            disabled={busy}
            onClick={close}
          >
            <X size={18} />
          </button>
        </header>
        <p>
          Read the engine-resolved document. Saving creates or updates this project's role file.
          Unsaved drafts are kept on this device until you save or discard them.
        </p>
        {error && (
          <p className="session-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="composer-notice">
            {notice}
          </p>
        )}
        {durableState.error && (
          <p className="session-error" role="alert">
            {durableState.error}
          </p>
        )}
        {durableState.review && (
          <div className="roster-confirm" role="alert">
            <p>Another window saved different unsaved text for this document.</p>
            <button
              type="button"
              className="button secondary"
              onClick={() => void durable.resolve('local')}
            >
              Keep this window’s text
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                const saved = durableState.review?.value;
                void durable.resolve('saved').then((ok) => {
                  if (ok && saved) {
                    setBase(saved.base);
                    setText(saved.text);
                  }
                });
              }}
            >
              Use saved text
            </button>
            {durableState.review.value?.base === base &&
              durableState.review.value.text !== text && (
                <DraftMergeChoices
                  mine={text}
                  stored={durableState.review.value.text}
                  busy={durableState.saving}
                  onKeep={(merged) => {
                    change(merged);
                    void durable.resolve('local');
                  }}
                />
              )}
          </div>
        )}
        {(cached || recovered) && dirty && (
          <p className="roster-policy-note">
            Recovered local draft. Saving checks the original stored-text baseline.
          </p>
        )}
        {!loaded ? (
          error ? (
            <button
              type="button"
              className="button secondary"
              onClick={() => setReadAttempt((value) => value + 1)}
            >
              Retry reading document
            </button>
          ) : (
            <p role="status">Reading role document…</p>
          )
        ) : (
          <>
            <div className="roster-document-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  setEditing(!editing);
                  setConflict(null);
                }}
              >
                <Pencil size={14} />
                {editing ? 'Preview text' : 'Edit project text'}
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(text)
                    .then(() => setNotice('Document copied.'))
                    .catch((error) => setError(String(error)))
                }
              >
                <Copy size={14} />
                Copy text
              </button>
            </div>
            {editing ? (
              <label>
                Markdown text
                <textarea
                  aria-label="Role document Markdown"
                  value={text}
                  disabled={busy}
                  onChange={(event) => change(event.target.value)}
                  spellCheck={false}
                />
              </label>
            ) : (
              <section className="roster-markdown" aria-label="Role document preview">
                <MarkdownContent
                  text={text || 'This document has no stored content.'}
                  {...(onLink ? { onLink } : {})}
                />
              </section>
            )}
            {conflict !== null && (
              <section className="roster-document-conflict">
                <h3>Stored text</h3>
                <textarea aria-label="Current stored role document" readOnly value={conflict} />
                <div>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={() => {
                      setBase(conflict);
                      setText(conflict);
                      setConflict(null);
                      setEditing(false);
                      setError('');
                      forget();
                    }}
                  >
                    Use stored text
                  </button>
                  <button
                    type="button"
                    className="button danger"
                    disabled={busy}
                    onClick={() => void save(conflict)}
                  >
                    Replace the reviewed stored text
                  </button>
                </div>
              </section>
            )}
          </>
        )}
        {leaving && (
          <div className="roster-confirm" role="alert">
            <p>Your role document has unsaved text.</p>
            <button type="button" className="button secondary" onClick={() => setLeaving(false)}>
              Keep editing document
            </button>
            <button type="button" className="button secondary" onClick={onClose}>
              Keep draft and close
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                forget();
                onClose();
              }}
            >
              Discard document draft
            </button>
          </div>
        )}
        <footer>
          <span>{dirty ? 'Unsaved project text' : 'Stored role document'}</span>
          <button
            type="button"
            className="button primary"
            disabled={!loaded || !dirty || busy}
            onClick={() => void save()}
          >
            <Save size={14} />
            Save project document
          </button>
        </footer>
      </div>
    </Modal>
  );
}
