import { Save, X } from 'lucide-react';
import { useRef, useState } from 'react';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { McpSecretMapEditor } from './McpSecretMapEditor';
import { Modal } from './Modal';
import { prepareSettingsPatch, sameSetting } from './settings-save-model';
import './mcp-connection.css';

function editable(server: Record<string, unknown>) {
  return {
    description: String(server['description'] ?? ''),
    transport: String(server['transport'] ?? (server['url'] ? 'streamable-http' : 'stdio')),
    url: String(server['url'] ?? ''),
    command: String(server['command'] ?? ''),
    argsText: Array.isArray(server['args']) ? server['args'].map(String).join('\n') : '',
    lazy: server['lazy'] === true,
  };
}
export function McpConnectionEditor({
  server,
  command,
  onClose,
  onSaved,
  onRefresh,
  secretMaps = false,
}: {
  server: Record<string, unknown>;
  command: EngineCommand;
  onClose: () => void;
  onSaved: () => void;
  onRefresh: () => void;
  /** The engine keeps masked env and header values on update (`mcp.masked-headers`). */
  secretMaps?: boolean | undefined;
}) {
  const [snapshot, setSnapshot] = useState(server),
    [base, setBase] = useState(() => editable(server)),
    [draft, setDraft] = useState(() => editable(server));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [review, setReview] = useState<'close' | 'reload' | null>(null);
  const working = useRef(false),
    name = String(server['name']);
  const dirty = !sameSetting(base, draft);
  const close = () => {
    if (busy) return;
    if (dirty) setReview('close');
    else onClose();
  };
  const read = async () => {
    const reply = await command('mcp.list', {}, ['mcp.list']);
    const current = entries(reply['servers']).find((row) => row['name'] === name);
    if (!current) throw Error('This connection was removed. Your local edit is preserved.');
    return current;
  };
  const reload = async () => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const current = await read();
      setSnapshot(current);
      setBase(editable(current));
      setDraft(editable(current));
      setReview(null);
      onRefresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  const save = async () => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const current = editable(await read());
      const patch = prepareSettingsPatch(base, draft, current);
      const payload = { ...patch };
      if (typeof payload['argsText'] === 'string') {
        payload['args'] = payload['argsText']
          .split('\n')
          .map((arg) => arg.trim())
          .filter(Boolean);
        delete payload['argsText'];
      }
      if (typeof payload['url'] === 'string') payload['url'] = payload['url'].trim();
      if (typeof payload['command'] === 'string') payload['command'] = payload['command'].trim();
      await command('mcp.update', { name, ...payload }, ['mcp.operation_result']);
      const actual = editable(await read());
      const expected = {
        ...current,
        ...patch,
        ...(Array.isArray(payload['args']) ? { argsText: payload['args'].join('\n') } : {}),
        ...(typeof payload['url'] === 'string' ? { url: payload['url'] } : {}),
        ...(typeof payload['command'] === 'string' ? { command: payload['command'] } : {}),
      };
      if (
        !Object.keys(patch).every((key) => sameSetting(record(actual)[key], record(expected)[key]))
      )
        throw Error(
          'The changed connection fields did not match readback. Your form is preserved.',
        );
      onSaved();
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  return (
    <Modal title={`Edit MCP connection ${name}`} onClose={close}>
      <form
        className="mcp-connection-editor"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <header>
          <div>
            <span className="eyebrow">PROFILE CONNECTION · {name}</span>
            <h2>Edit connection</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close MCP connection editor"
            disabled={busy}
            onClick={close}
          >
            <X size={18} />
          </button>
        </header>
        <p>
          Save applies only changed fields and may restart an enabled connection. Stored
          credentials, headers, private-network policy and other hidden settings are retained.
        </p>
        {error && (
          <p className="session-error" role="alert">
            {error}
          </p>
        )}
        <fieldset disabled={busy}>
          <label>
            Description
            <input
              aria-label="MCP connection description"
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>
          <label>
            Transport
            <select
              aria-label="MCP connection transport"
              value={draft.transport}
              onChange={(event) => setDraft({ ...draft, transport: event.target.value })}
            >
              <option value="stdio">Local process · stdio</option>
              <option value="streamable-http">Remote · Streamable HTTP</option>
              <option value="sse">Remote · SSE</option>
            </select>
          </label>
          {draft.transport === 'stdio' ? (
            <>
              <label>
                Executable
                <input
                  aria-label="MCP connection executable"
                  required
                  value={draft.command}
                  onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                />
              </label>
              <label>
                Arguments
                <textarea
                  aria-label="MCP connection arguments"
                  rows={4}
                  value={draft.argsText}
                  onChange={(event) => setDraft({ ...draft, argsText: event.target.value })}
                />
                <small>
                  One argument per line. Blank lines are ignored when edited; execution is direct.
                </small>
              </label>
            </>
          ) : (
            <label>
              Endpoint URL
              <input
                aria-label="MCP connection endpoint"
                required
                type="url"
                value={draft.url}
                onChange={(event) => setDraft({ ...draft, url: event.target.value })}
              />
            </label>
          )}
          <label className="authorization-checkbox">
            <input
              aria-label="MCP connection lazy startup"
              type="checkbox"
              checked={draft.lazy}
              onChange={(event) => setDraft({ ...draft, lazy: event.target.checked })}
            />
            Start lazily when a capability is needed
          </label>
        </fieldset>
        {secretMaps &&
          (['env', 'headers'] as const)
            .filter(
              (kind) =>
                kind === 'env' ||
                draft.transport !== 'stdio' ||
                Object.keys(record(snapshot[kind])).length > 0,
            )
            .map((kind) => (
              <McpSecretMapEditor
                key={`${kind}:${JSON.stringify(Object.entries(record(snapshot[kind])))}`}
                kind={kind}
                name={name}
                map={record(snapshot[kind])}
                command={command}
                onSaved={(after) => {
                  setSnapshot((current) => ({ ...current, [kind]: after }));
                  onRefresh();
                }}
              />
            ))}
        {!secretMaps && Object.keys(record(snapshot['env'])).length > 0 && (
          <details>
            <summary>Stored environment names</summary>
            <p>
              Values remain managed by the engine. This form leaves the environment map unchanged.
            </p>
            <ul>
              {Object.keys(record(snapshot['env'])).map((key) => (
                <li key={key}>
                  <code>{key}</code>
                </li>
              ))}
            </ul>
          </details>
        )}
        {review && (
          <div className="mcp-connection-review" role="alert">
            <p>
              {review === 'close'
                ? 'Discard the unsaved connection edit?'
                : 'Discard local changes and load the current saved connection?'}
            </p>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setReview(null)}
            >
              Keep editing connection
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => (review === 'close' ? onClose() : void reload())}
            >
              {review === 'close'
                ? 'Discard connection edit'
                : 'Discard edits and reload connection'}
            </button>
          </div>
        )}
        <footer>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => (dirty ? setReview('reload') : void reload())}
          >
            Reload stored connection
          </button>
          <button type="submit" className="button primary" disabled={busy || !dirty}>
            <Save size={14} />
            {busy ? 'Saving…' : 'Save connection changes'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
