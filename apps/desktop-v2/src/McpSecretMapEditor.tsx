import { Plus, Save, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import {
  MCP_SECRET_MASK,
  type SecretMapAddition,
  type SecretMapKind,
  type SecretMapRow,
  secretMapChanged,
  secretMapPayload,
  secretMapRows,
} from './mcp-secret-map';

const sameShown = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  JSON.stringify(Object.entries(a)) === JSON.stringify(Object.entries(b));

/**
 * Edits one connection's environment or HTTP headers key by key. Hidden values are never
 * received: they are kept, replaced or removed. The save re-reads the connection first and
 * refuses when the stored map changed since it was shown, then reads it back.
 */
export function McpSecretMapEditor({
  kind,
  name,
  map,
  command,
  onSaved,
}: {
  kind: SecretMapKind;
  name: string;
  map: Record<string, unknown>;
  command: EngineCommand;
  onSaved: (current: Record<string, unknown>) => void;
}) {
  const [rows, setRows] = useState<SecretMapRow[]>(() => secretMapRows(map)),
    [additions, setAdditions] = useState<SecretMapAddition[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const working = useRef(false);
  const noun = kind === 'env' ? 'environment variable' : 'header';
  const update = (index: number, change: Partial<SecretMapRow>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...change } : row)));
  const save = async () => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const payload = secretMapPayload(kind, rows, additions);
      const read = async () => {
        const reply = await command('mcp.list', {}, ['mcp.list']);
        const server = entries(reply['servers']).find((row) => row['name'] === name);
        if (!server) throw Error('This connection was removed. Your edit is preserved.');
        return server;
      };
      if (!sameShown(record((await read())[kind]), map))
        throw Error(
          `The stored ${kind === 'env' ? 'environment' : 'headers'} changed since this form opened. Reload the connection; your edit is preserved.`,
        );
      await command('mcp.update', { name, [kind]: payload }, ['mcp.operation_result']);
      const after = record((await read())[kind]);
      const mismatch = Object.keys(payload).some(
        (key) =>
          !(key in after) ||
          (payload[key] !== MCP_SECRET_MASK &&
            after[key] !== MCP_SECRET_MASK &&
            after[key] !== payload[key]),
      );
      if (mismatch || Object.keys(after).length !== Object.keys(payload).length)
        throw Error(
          `The saved ${noun}s did not match readback. Reload the connection to inspect them.`,
        );
      setRows(secretMapRows(after));
      setAdditions([]);
      setNotice('Saved and read back. Hidden values stay with the engine.');
      onSaved(after);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  return (
    <fieldset className="mcp-secret-map">
      <legend>{kind === 'env' ? 'Environment' : 'HTTP headers'}</legend>
      <p className="field-help">
        Hidden values are never shown or sent to this window. Keep, replace or remove each one;
        saving may restart an enabled connection.
      </p>
      {rows.length === 0 && additions.length === 0 && <p>No {noun}s are stored.</p>}
      <ul>
        {rows.map((row, index) => (
          <li key={row.key} className={row.action === 'remove' ? 'mcp-secret-removed' : ''}>
            <code>{row.key}</code>
            {row.action === 'replace' ? (
              <input
                type="password"
                autoComplete="off"
                aria-label={`New value for ${row.key}`}
                value={row.value}
                disabled={busy}
                onChange={(event) => update(index, { value: event.target.value })}
              />
            ) : (
              <span>
                {row.action === 'remove'
                  ? 'Will be removed'
                  : row.shown === MCP_SECRET_MASK
                    ? 'Hidden value'
                    : row.shown}
              </span>
            )}
            <select
              aria-label={`Action for ${row.key}`}
              value={row.action}
              disabled={busy}
              onChange={(event) =>
                update(index, { action: event.target.value as SecretMapRow['action'], value: '' })
              }
            >
              <option value="keep">Keep</option>
              <option value="replace">Replace</option>
              <option value="remove">Remove</option>
            </select>
          </li>
        ))}
        {additions.map((addition, index) => (
          <li key={`new-${index}`}>
            <input
              aria-label={`New ${noun} name`}
              placeholder="Name"
              value={addition.key}
              disabled={busy}
              onChange={(event) =>
                setAdditions((current) =>
                  current.map((item, i) =>
                    i === index ? { ...item, key: event.target.value } : item,
                  ),
                )
              }
            />
            <input
              type="password"
              autoComplete="off"
              aria-label={`New ${noun} value`}
              placeholder="Value"
              value={addition.value}
              disabled={busy}
              onChange={(event) =>
                setAdditions((current) =>
                  current.map((item, i) =>
                    i === index ? { ...item, value: event.target.value } : item,
                  ),
                )
              }
            />
            <button
              type="button"
              className="icon-button"
              aria-label={`Discard new ${noun}`}
              disabled={busy}
              onClick={() => setAdditions((current) => current.filter((_, i) => i !== index))}
            >
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>
      <div className="mcp-secret-actions">
        <button
          type="button"
          className="button secondary small"
          disabled={busy}
          onClick={() => setAdditions((current) => [...current, { key: '', value: '' }])}
        >
          <Plus size={13} /> Add {noun}
        </button>
        <button
          type="button"
          className="button primary small"
          disabled={busy || !secretMapChanged(rows, additions)}
          onClick={() => void save()}
        >
          <Save size={13} />{' '}
          {busy ? 'Saving…' : `Save ${kind === 'env' ? 'environment' : 'headers'}`}
        </button>
      </div>
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </fieldset>
  );
}
