import type { OfficialServer } from '@wrongstack/project-surfaces/lib/official-mcp-servers';
import { Check, Link2, Plug, Plus, Power, RefreshCw, Server, Trash2, X } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { McpAuthorization } from './McpAuthorization';
import { McpRecommendedPicker, recommendedExtras } from './McpRecommendedPicker';

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
  const { t } = useDesktopText();
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
      setNotice(String(reply['message'] ?? t('integrations.updated')));
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
          <h2>{t('integrations.title')}</h2>
          <p>{t('integrations.intro')}</p>
        </div>
        <button type="button" className="button primary" onClick={() => setCreating(true)}>
          <Plus size={14} />
          {t('integrations.add')}
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
          const statusLabel =
            server['status'] == null
              ? t(
                  server['enabled']
                    ? 'integrations.status.configured'
                    : 'integrations.status.disabled',
                )
              : t(`integrations.status.${status}`, { defaultValue: status });
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
                    {statusLabel}
                  </span>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t('integrations.restartLabel', { name })}
                  title={t('integrations.restartTitle')}
                  disabled={Boolean(busy)}
                  onClick={() => void action(name, 'mcp.restart')}
                >
                  <RefreshCw size={14} />
                </button>
              </header>
              <p className="integration-endpoint">
                {String(
                  server['url'] ??
                    server['command'] ??
                    server['transport'] ??
                    t('integrations.endpoint'),
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
                {t('integrations.toolCount', { n: Number(server['toolCount'] ?? tools.length) })}
              </div>
              {tools.length > 0 && (
                <details>
                  <summary>{t('integrations.tools')}</summary>
                  <div className="integration-tool-list">
                    {tools.map((tool) => (
                      <div key={String(tool['name'])}>
                        <strong>{String(tool['name'])}</strong>
                        <p>{String(tool['description'] ?? '')}</p>
                        {(() => {
                          const hint = record(
                            record(server['toolAnnotations'])[String(tool['name'])],
                          );
                          const labels = ['readOnlyHint', 'destructiveHint', 'openWorldHint']
                            .filter((key) => hint[key] === true)
                            .map((key) => t(`integrations.hint.${key}`));
                          return labels.length ? (
                            <small>{t('integrations.hints', { labels: labels.join(', ') })}</small>
                          ) : null;
                        })()}
                      </div>
                    ))}
                  </div>
                </details>
              )}
              {typeof server['url'] === 'string' && server['url'] && (
                <McpAuthorization name={name} command={command} />
              )}
              <footer>
                <button
                  type="button"
                  className="button secondary small"
                  disabled={Boolean(busy)}
                  onClick={() => setEditing(server)}
                >
                  {t('integrations.edit')}
                </button>
                <button
                  type="button"
                  className="button secondary small"
                  disabled={Boolean(busy) || server['enabled'] === false}
                  onClick={() => setBrowsing(name)}
                >
                  {t('integrations.browse')}
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
                  {server['enabled'] === false
                    ? t('integrations.enable')
                    : t('integrations.disable')}
                </button>
                {status.toLowerCase().includes('sleep') ? (
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={Boolean(busy)}
                    onClick={() => void action(name, 'mcp.wake')}
                  >
                    {t('integrations.wake')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={Boolean(busy)}
                    onClick={() => void action(name, 'mcp.sleep')}
                  >
                    {t('integrations.pause')}
                  </button>
                )}
                <button
                  type="button"
                  className="button secondary small"
                  disabled={Boolean(busy) || server['enabled'] === false}
                  title={t('integrations.discoverTitle')}
                  onClick={() => void action(name, 'mcp.discover')}
                >
                  {t('integrations.discover')}
                </button>
                <button
                  type="button"
                  className="icon-button danger"
                  aria-label={t('integrations.removeLabel', { name })}
                  disabled={Boolean(busy)}
                  onClick={() => setRemoving(name)}
                >
                  <Trash2 size={13} />
                </button>
              </footer>
              {removing === name && (
                <div className="integration-remove">
                  <p>{t('integrations.removeAsk')}</p>
                  <button
                    type="button"
                    className="button secondary danger small"
                    onClick={() => void action(name, 'mcp.remove')}
                  >
                    {t('integrations.remove')}
                  </button>
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() => setRemoving('')}
                  >
                    {t('integrations.keep')}
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
          <h3>{t('integrations.emptyTitle')}</h3>
          <p>{t('integrations.emptyBody')}</p>
          <button type="button" className="button secondary" onClick={() => setCreating(true)}>
            {t('integrations.addFirst')}
          </button>
        </div>
      )}
      {creating && (
        <IntegrationDialog
          busy={Boolean(busy)}
          added={new Set(servers.map((server) => String(server['name'])))}
          onClose={() => setCreating(false)}
          onSave={(payload) => void action(String(payload['name']), 'mcp.add', payload)}
        />
      )}
      {browsing && (
        <Suspense fallback={<p role="status">{t('integrations.openingBrowser')}</p>}>
          <McpContentBrowser
            key={browsing}
            name={browsing}
            command={command}
            onClose={() => setBrowsing('')}
          />
        </Suspense>
      )}
      {editing && (
        <Suspense fallback={<p role="status">{t('integrations.openingEditor')}</p>}>
          <McpConnectionEditor
            key={String(editing['name'])}
            server={editing}
            command={command}
            secretMaps={capabilities.includes('mcp.masked-headers')}
            onRefresh={() => void load().catch((error) => setError(String(error)))}
            onClose={() => setEditing(null)}
            onSaved={() => {
              void load().catch((error) => setError(String(error)));
              setNotice(t('integrations.savedEdits'));
            }}
          />
        </Suspense>
      )}
    </section>
  );
}
function IntegrationDialog({
  busy,
  added,
  onClose,
  onSave,
}: {
  busy: boolean;
  added: ReadonlySet<string>;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => void;
}) {
  const { t } = useDesktopText();
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
  const [preset, setPreset] = useState<OfficialServer | null>(null);
  const pick = (server: OfficialServer | null) => {
    setPreset(server);
    if (!server) return;
    setName(server.name);
    setMode(server.transport === 'stdio' ? 'local' : 'remote');
    setUrl(server.url ?? '');
    setCommand(server.command ?? '');
    setArgs((server.args ?? []).join('\n'));
  };
  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-label={t('integrations.dialog.label')}
      onCancel={onClose}
    >
      <header>
        <div>
          <span className="eyebrow">{t('integrations.dialog.eyebrow')}</span>
          <h2>{t('integrations.dialog.title')}</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={t('integrations.dialog.cancelLabel')}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            ...(preset ? recommendedExtras(preset) : {}),
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
        <McpRecommendedPicker added={added} picked={preset} onPick={pick} />
        <label>
          {t('integrations.dialog.name')}
          <input
            aria-label={t('integrations.dialog.nameLabel')}
            autoFocus
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="project-docs"
          />
        </label>
        <label>
          {t('integrations.dialog.type')}
          <select
            aria-label={t('integrations.dialog.type')}
            value={mode}
            onChange={(event) => setMode(event.target.value)}
          >
            <option value="remote">{t('integrations.dialog.remote')}</option>
            <option value="local">{t('integrations.dialog.local')}</option>
          </select>
        </label>
        {mode === 'remote' ? (
          <label>
            {t('integrations.dialog.url')}
            <input
              aria-label={t('integrations.dialog.urlLabel')}
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
              {t('integrations.dialog.executable')}
              <input
                aria-label={t('integrations.dialog.executableLabel')}
                required
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                placeholder="bun"
              />
            </label>
            <label>
              {t('integrations.dialog.arguments')}
              <textarea
                aria-label={t('integrations.dialog.argumentsLabel')}
                value={args}
                onChange={(event) => setArgs(event.target.value)}
                rows={4}
                placeholder={'run\n/path/to/server.ts'}
              />
              <small className="field-help">{t('integrations.dialog.argumentsHelp')}</small>
            </label>
          </>
        )}
        {mode === 'remote' && (
          <label className="authorization-checkbox">
            <input
              type="checkbox"
              aria-label={t('integrations.dialog.privateLabel')}
              checked={allowPrivateNetworks}
              onChange={(event) => setAllowPrivateNetworks(event.target.checked)}
            />
            {t('integrations.dialog.private')}
            <small>{t('integrations.dialog.privateHelp')}</small>
          </label>
        )}
        <p className="form-note">{t('integrations.dialog.note')}</p>
        <footer>
          <button type="button" className="button secondary" onClick={onClose}>
            {t('integrations.dialog.cancel')}
          </button>
          <button type="submit" className="button primary" disabled={busy || !name.trim()}>
            <Plus size={14} />
            {t('integrations.dialog.save')}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
