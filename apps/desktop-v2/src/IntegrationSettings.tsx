import { Check, Link2, Plug, Plus, Power, RefreshCw, Server, Trash2, X } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';

const McpContentBrowser = lazy(() =>
  import('./McpContentBrowser').then((module) => ({ default: module.McpContentBrowser })),
);
const McpConnectionEditor = lazy(() =>
  import('./McpConnectionEditor').then((module) => ({ default: module.McpConnectionEditor })),
);

export function IntegrationSettings({
  command,
  capabilities = [],
}: {
  command: EngineCommand;
  /** Protocol capabilities of the connected engine. */
  capabilities?: readonly unknown[] | undefined;
}) {
  const [servers, setServers] = useState<Record<string, unknown>[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(''),
    [creating, setCreating] = useState(false),
    [removing, setRemoving] = useState(''),
    [notice, setNotice] = useState('');
  const [browsing, setBrowsing] = useState('');
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const load = useCallback(async () => {
    const result = await command('mcp.list', {}, ['mcp.list']);
    setServers(entries(result['servers']));
  }, [command]);
  useEffect(() => {
    void load().catch((error: unknown) =>
      setError(String(error instanceof Error ? error.message : error)),
    );
  }, [load]);
  const action = async (name: string, type: string, payload: Record<string, unknown> = {}) => {
    setBusy(name || 'new');
    setError('');
    setNotice('');
    try {
      const reply = await command(type, { name, ...payload }, ['mcp.operation_result']);
      await load();
      setNotice(String(reply['message'] ?? 'Integration updated.'));
      setCreating(false);
      setRemoving('');
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('');
    }
  };
  return (
    <section className="integration-settings">
      <header className="settings-section-heading">
        <div>
          <h2>Connected tools</h2>
          <p>
            Connect MCP servers to extend what WrongStack can read and do. These connections belong
            to your profile.
          </p>
        </div>
        <button type="button" className="button primary" onClick={() => setCreating(true)}>
          <Plus size={14} />
          Add connection
        </button>
      </header>
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="studio-notice" role="status">
          <Check size={13} />
          {notice}
        </p>
      )}
      <div className="integration-grid">
        {servers.map((server) => {
          const name = String(server['name']);
          const status = String(
            server['status'] ?? (server['enabled'] ? 'Configured' : 'Disabled'),
          );
          const tools = Array.isArray(server['tools'])
            ? server['tools']
                .map((tool: unknown) => (typeof tool === 'string' ? { name: tool } : record(tool)))
                .filter((tool: Record<string, unknown>) => typeof tool['name'] === 'string')
            : [];
          return (
            <article className="integration-card" key={name}>
              <header>
                <span className="integration-icon">
                  {server['url'] ? <Link2 size={22} /> : <Server size={22} />}
                </span>
                <div>
                  <h3>{name}</h3>
                  <span
                    className={`integration-status ${server['enabled'] === false ? 'disabled' : ''}`}
                  >
                    {status}
                  </span>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Restart ${name}`}
                  title="Restart server connection"
                  disabled={Boolean(busy)}
                  onClick={() => void action(name, 'mcp.restart')}
                >
                  <RefreshCw size={14} />
                </button>
              </header>
              <p className="integration-endpoint">
                {String(
                  server['url'] ?? server['command'] ?? server['transport'] ?? 'MCP connection',
                )}
              </p>
              {typeof server['description'] === 'string' && server['description'] && (
                <p>{server['description']}</p>
              )}
              {typeof server['error'] === 'string' && server['error'] && (
                <p className="session-error" role="alert">
                  {server['error']}
                </p>
              )}
              <div className="integration-tools-summary">
                <Plug size={14} />
                {Number(server['toolCount'] ?? tools.length)} tools available
              </div>
              {tools.length > 0 && (
                <details>
                  <summary>Available tools</summary>
                  <div className="integration-tool-list">
                    {tools.map((tool) => (
                      <div key={String(tool['name'])}>
                        <strong>{String(tool['name'])}</strong>
                        <p>{String(tool['description'] ?? '')}</p>
                        {(() => {
                          const hint = record(
                            record(server['toolAnnotations'])[String(tool['name'])],
                          );
                          const labels = [
                            ['readOnlyHint', 'read-only'],
                            ['destructiveHint', 'destructive'],
                            ['openWorldHint', 'open-world'],
                          ]
                            .filter(([key]) => hint[key!] === true)
                            .map(([, label]) => label);
                          return labels.length ? (
                            <small>
                              Server-reported hints: {labels.join(', ')}. Execution permissions are
                              evaluated separately.
                            </small>
                          ) : null;
                        })()}
                      </div>
                    ))}
                  </div>
                </details>
              )}
              <footer>
                <button
                  type="button"
                  className="button secondary small"
                  disabled={Boolean(busy)}
                  onClick={() => setEditing(server)}
                >
                  Edit connection
                </button>
                <button
                  type="button"
                  className="button secondary small"
                  disabled={Boolean(busy) || server['enabled'] === false}
                  onClick={() => setBrowsing(name)}
                >
                  Browse resources & prompts
                </button>
                <button
                  type="button"
                  className="button secondary small"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void action(name, server['enabled'] === false ? 'mcp.enable' : 'mcp.disable')
                  }
                >
                  <Power size={12} />
                  {server['enabled'] === false ? 'Enable' : 'Disable'}
                </button>
                {status.toLowerCase().includes('sleep') ? (
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={Boolean(busy)}
                    onClick={() => void action(name, 'mcp.wake')}
                  >
                    Wake
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={Boolean(busy)}
                    onClick={() => void action(name, 'mcp.sleep')}
                  >
                    Pause
                  </button>
                )}
                <button
                  type="button"
                  className="icon-button danger"
                  aria-label={`Remove ${name}`}
                  disabled={Boolean(busy)}
                  onClick={() => setRemoving(name)}
                >
                  <Trash2 size={13} />
                </button>
              </footer>
              {removing === name && (
                <div className="integration-remove">
                  <p>Remove this connection from your profile?</p>
                  <button
                    type="button"
                    className="button secondary danger small"
                    onClick={() => void action(name, 'mcp.remove')}
                  >
                    Remove connection
                  </button>
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() => setRemoving('')}
                  >
                    Keep connection
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {!servers.length && (
        <div className="integration-empty">
          <Plug size={35} />
          <h3>Bring your tools into the workspace.</h3>
          <p>
            Add a remote endpoint or a local MCP server. Configure it first, then enable it when you
            are ready.
          </p>
          <button type="button" className="button secondary" onClick={() => setCreating(true)}>
            Add your first connection
          </button>
        </div>
      )}
      {creating && (
        <IntegrationDialog
          busy={Boolean(busy)}
          onClose={() => setCreating(false)}
          onSave={(payload) => void action(String(payload['name']), 'mcp.add', payload)}
        />
      )}
      {browsing && (
        <Suspense fallback={<p role="status">Opening MCP content browser…</p>}>
          <McpContentBrowser
            key={browsing}
            name={browsing}
            command={command}
            onClose={() => setBrowsing('')}
          />
        </Suspense>
      )}
      {editing && (
        <Suspense fallback={<p role="status">Opening connection editor…</p>}>
          <McpConnectionEditor
            key={String(editing['name'])}
            server={editing}
            command={command}
            secretMaps={capabilities.includes('mcp.masked-headers')}
            onRefresh={() => void load().catch((error) => setError(String(error)))}
            onClose={() => setEditing(null)}
            onSaved={() => {
              void load().catch((error) => setError(String(error)));
              setNotice('Changed connection fields saved and read back.');
            }}
          />
        </Suspense>
      )}
    </section>
  );
}
function IntegrationDialog({
  busy,
  onClose,
  onSave,
}: {
  busy: boolean;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const [name, setName] = useState(''),
    [mode, setMode] = useState('remote'),
    [url, setUrl] = useState(''),
    [command, setCommand] = useState(''),
    [args, setArgs] = useState('');
  const [allowPrivateNetworks, setAllowPrivateNetworks] = useState(false);
  return (
    <dialog ref={dialog} className="modal" aria-label="Add MCP connection" onCancel={onClose}>
      <header>
        <div>
          <span className="eyebrow">MCP CONNECTION</span>
          <h2>Make your tools available.</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Cancel connection"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            name: name.trim(),
            enabled: false,
            ...(mode === 'remote'
              ? { transport: 'streamable-http', url: url.trim(), allowPrivateNetworks }
              : {
                  transport: 'stdio',
                  command: command.trim(),
                  args: args
                    .split('\n')
                    .map((arg) => arg.trim())
                    .filter(Boolean),
                }),
          });
        }}
      >
        <label>
          Name
          <input
            aria-label="Connection name"
            autoFocus
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="project-docs"
          />
        </label>
        <label>
          Connection type
          <select
            aria-label="Connection type"
            value={mode}
            onChange={(event) => setMode(event.target.value)}
          >
            <option value="remote">Remote endpoint</option>
            <option value="local">Local process</option>
          </select>
        </label>
        {mode === 'remote' ? (
          <label>
            Server URL
            <input
              aria-label="MCP server URL"
              type="url"
              required
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/mcp"
            />
          </label>
        ) : (
          <>
            <label>
              Executable
              <input
                aria-label="MCP executable"
                required
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                placeholder="bun"
              />
            </label>
            <label>
              Arguments
              <textarea
                aria-label="MCP arguments"
                value={args}
                onChange={(event) => setArgs(event.target.value)}
                rows={4}
                placeholder={'run\n/path/to/server.ts'}
              />
              <small className="field-help">
                One argument per line. The executable is launched directly.
              </small>
            </label>
          </>
        )}
        {mode === 'remote' && (
          <label className="authorization-checkbox">
            <input
              type="checkbox"
              aria-label="Allow private MCP network addresses"
              checked={allowPrivateNetworks}
              onChange={(event) => setAllowPrivateNetworks(event.target.checked)}
            />
            Allow private network addresses for this connection
            <small>Use for a trusted loopback or private-network MCP endpoint.</small>
          </label>
        )}
        <p className="form-note">
          The connection will be saved disabled. Enable it from its card to connect.
        </p>
        <footer>
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy || !name.trim()}>
            <Plus size={14} />
            Save connection
          </button>
        </footer>
      </form>
    </dialog>
  );
}
