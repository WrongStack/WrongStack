import { Plus, Save, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
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
  const { t } = useDesktopText();
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
        if (!server) throw Error(t('mcpSecrets.removed'));
        return server;
      };
      if (!sameShown(record((await read())[kind]), map))
        throw Error(t(`mcpSecrets.${kind}.changed`));
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
        throw Error(t(`mcpSecrets.${kind}.mismatch`));
      setRows(secretMapRows(after));
      setAdditions([]);
      setNotice(t('mcpSecrets.saved'));
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
      <legend>{t(`mcpSecrets.${kind}.legend`)}</legend>
      <p className="field-help">{t('mcpSecrets.help')}</p>
      {rows.length === 0 && additions.length === 0 && <p>{t(`mcpSecrets.${kind}.none`)}</p>}
      <ul>
        {rows.map((row, index) => (
          <li key={row.key} className={row.action === 'remove' ? 'mcp-secret-removed' : ''}>
            <code>{row.key}</code>
            {row.action === 'replace' ? (
              <input
                type="password"
                autoComplete="off"
                aria-label={t('mcpSecrets.newValueFor', { key: row.key })}
                value={row.value}
                disabled={busy}
                onChange={(event) => update(index, { value: event.target.value })}
              />
            ) : (
              <span>
                {row.action === 'remove'
                  ? t('mcpSecrets.willRemove')
                  : row.shown === MCP_SECRET_MASK
                    ? t('mcpSecrets.hidden')
                    : row.shown}
              </span>
            )}
            <select
              aria-label={t('mcpSecrets.actionFor', { key: row.key })}
              value={row.action}
              disabled={busy}
              onChange={(event) =>
                update(index, { action: event.target.value as SecretMapRow['action'], value: '' })
              }
            >
              <option value="keep">{t('mcpSecrets.keep')}</option>
              <option value="replace">{t('mcpSecrets.replace')}</option>
              <option value="remove">{t('mcpSecrets.remove')}</option>
            </select>
          </li>
        ))}
        {additions.map((addition, index) => (
          <li key={`new-${index}`}>
            <input
              aria-label={t(`mcpSecrets.${kind}.newName`)}
              placeholder={t('mcpSecrets.namePlaceholder')}
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
              aria-label={t(`mcpSecrets.${kind}.newValue`)}
              placeholder={t('mcpSecrets.valuePlaceholder')}
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
              aria-label={t(`mcpSecrets.${kind}.discardNew`)}
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
          <Plus size={13} /> {t(`mcpSecrets.${kind}.add`)}
        </button>
        <button
          type="button"
          className="button primary small"
          disabled={busy || !secretMapChanged(rows, additions)}
          onClick={() => void save()}
        >
          <Save size={13} /> {busy ? t('mcpSecrets.saving') : t(`mcpSecrets.${kind}.save`)}
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
