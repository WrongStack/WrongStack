import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { EngineHttp } from './engine-http';
import { record } from './engine-values';

/** Comma or newline separated tags, trimmed, without blanks or repeats. */
export function vectorTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,\n]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

/** Stores a free-text entry in the vector store (`POST /api/vector-memory/store`). */
export function VectorMemoryAdd({ http, onStored }: { http: EngineHttp; onStored: () => void }) {
  const [text, setText] = useState(''),
    [tags, setTags] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const store = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = record(
        await http('/api/vector-memory/store', 'POST', {
          text: text.trim(),
          tags: vectorTags(tags),
        }),
      );
      setNotice(
        result['hasVector'] === true
          ? `Stored as ${String(result['id'])} with a ${String(result['dimensions'] ?? '?')}-dimension vector.`
          : `Stored as ${String(result['id'])}, but no vector was computed; it will not appear in semantic search until it is embedded.`,
      );
      setText('');
      setTags('');
      onStored();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="vector-memory-add">
      <summary>
        <Plus size={13} /> Add an entry
      </summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void store();
        }}
      >
        <textarea
          aria-label="Vector memory entry text"
          value={text}
          rows={4}
          maxLength={20_000}
          placeholder="A fact, decision or note to retrieve by meaning…"
          onChange={(event) => setText(event.target.value)}
        />
        <input
          aria-label="Vector memory entry tags"
          value={tags}
          placeholder="Tags, separated by commas"
          onChange={(event) => setTags(event.target.value)}
        />
        <p className="field-help">
          Stored in the vector store only. To keep durable project knowledge, record it in SAGE
          Memory instead.
        </p>
        {error && (
          <p role="alert" className="session-error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <button type="submit" className="button primary small" disabled={busy || !text.trim()}>
          {busy ? 'Storing…' : 'Store entry'}
        </button>
      </form>
    </details>
  );
}

/**
 * Removes one vector entry (`DELETE /api/vector-memory/store/:id`) after confirmation. Entries
 * mirrored from SAGE are not offered: the mirror would restore them; retire the SAGE record.
 */
export function VectorMemoryForget({
  http,
  id,
  onRemoved,
}: {
  http: EngineHttp;
  id: string;
  onRemoved: () => void;
}) {
  const [confirming, setConfirming] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const forget = async () => {
    setBusy(true);
    setError('');
    try {
      const result = record(
        await http(`/api/vector-memory/store/${encodeURIComponent(id)}`, 'DELETE'),
      );
      if (result['removed'] !== true) throw Error('The entry was already gone from the store.');
      onRemoved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="vector-memory-forget">
      {confirming ? (
        <>
          <button
            type="button"
            className="button danger small"
            disabled={busy}
            onClick={() => void forget()}
          >
            Confirm removal
          </button>
          <button
            type="button"
            className="button secondary small"
            onClick={() => setConfirming(false)}
          >
            Keep
          </button>
        </>
      ) : (
        <button
          type="button"
          className="button secondary small"
          aria-label={`Remove vector entry ${id}`}
          onClick={() => setConfirming(true)}
        >
          <Trash2 size={13} /> Remove
        </button>
      )}
      {error && (
        <small role="alert" className="session-error">
          {error}
        </small>
      )}
    </span>
  );
}
