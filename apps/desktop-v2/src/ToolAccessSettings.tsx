import { Check, Power, RefreshCw, Search, Wrench } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Trans } from 'react-i18next';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries } from './engine-values';
import { surfaceI18n } from './surface-i18n';

export function ToolAccessSettings({ command }: { command: EngineCommand }) {
  const { t } = useDesktopText();
  const [tools, setTools] = useState<Record<string, unknown>[]>([]),
    [query, setQuery] = useState(''),
    [status, setStatus] = useState('all'),
    [owner, setOwner] = useState('all'),
    [busy, setBusy] = useState(''),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    const result = await command('tools.list', {}, ['tools.list']);
    const rows = entries(result['tools']);
    setTools(rows);
    return rows;
  }, [command]);
  useEffect(() => {
    let active = true;
    void load()
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load]);
  const toggle = async (tool: Record<string, unknown>) => {
    const name = String(tool['name']),
      disabled = tool['disabled'] !== true;
    setBusy(name);
    setError('');
    setNotice('');
    try {
      await command(disabled ? 'tool.disable' : 'tool.enable', { name }, [
        disabled ? 'tool.disabled' : 'tool.enabled',
      ]);
      const actual = (await load()).find((row) => row['name'] === name);
      if (!actual || actual['disabled'] !== disabled) throw Error(t('toolAccess.notConfirmed'));
      setNotice(
        t(disabled ? 'toolAccess.disabledVerified' : 'toolAccess.enabledVerified', { name }),
      );
    } catch (e) {
      setError(
        t('toolAccess.couldNotUpdate', {
          name,
          error: String(e instanceof Error ? e.message : e),
        }),
      );
    } finally {
      setBusy('');
    }
  };
  const filtered = tools.filter(
    (tool) =>
      (status === 'all' || (status === 'disabled') === (tool['disabled'] === true)) &&
      (owner === 'all' || tool['owner'] === owner) &&
      [tool['name'], tool['owner'], tool['description']]
        .join(' ')
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const disabled = tools.filter((tool) => tool['disabled'] === true).length,
    direct = tools.filter((tool) => tool['disabled'] !== true && tool['direct'] === true).length;
  return (
    <section className="tool-access-settings" aria-label={t('toolAccess.label')}>
      <header className="settings-section-heading">
        <div>
          <span className="eyebrow">{t('toolAccess.eyebrow')}</span>
          <h2>{t('toolAccess.title')}</h2>
          <p>{t('toolAccess.intro')}</p>
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={!!busy || loading}
          onClick={() => {
            setLoading(true);
            void load()
              .then(() => setError(''))
              .catch((e) => setError(String(e)))
              .finally(() => setLoading(false));
          }}
        >
          <RefreshCw size={14} />
          {t('toolAccess.refresh')}
        </button>
      </header>
      <p className="settings-defaults-note">{t('toolAccess.note')}</p>
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="studio-notice" role="status">
          <Check size={14} />
          {notice}
        </p>
      )}
      <div className="tool-access-counts">
        <Trans
          i18n={surfaceI18n}
          ns="desktop"
          i18nKey="toolAccess.counts"
          values={{
            total: tools.length,
            direct,
            onDemand: tools.length - disabled - direct,
            disabled,
          }}
          components={{ strong: <strong /> }}
        />
      </div>
      <div className="tool-access-filters">
        <label>
          <Search size={14} />
          <input
            aria-label={t('toolAccess.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('toolAccess.searchPlaceholder')}
          />
        </label>
        <select
          aria-label={t('toolAccess.statusFilter')}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="all">{t('toolAccess.allTools')}</option>
          <option value="enabled">{t('toolAccess.enabled')}</option>
          <option value="disabled">{t('toolAccess.disabled')}</option>
        </select>
        <select
          aria-label={t('toolAccess.ownerFilter')}
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
        >
          <option value="all">{t('toolAccess.allOwners')}</option>
          {[...new Set(tools.map((tool) => String(tool['owner'] ?? 'core')))]
            .sort()
            .map((value) => (
              <option key={value}>{value}</option>
            ))}
        </select>
      </div>
      {loading && !tools.length ? (
        <p className="quiet-state">{t('toolAccess.loading')}</p>
      ) : (
        <section className="tool-access-list" aria-label={t('toolAccess.list')}>
          {filtered.map((tool) => (
            <article className="tool-access-card" key={String(tool['name'])}>
              <header>
                <Wrench size={16} />
                <div>
                  <strong>{String(tool['name'])}</strong>
                  <span>
                    {String(tool['owner'] ?? 'core')} ·{' '}
                    {tool['disabled'] === true
                      ? t('toolAccess.kind.disabled')
                      : tool['direct'] === true
                        ? t('toolAccess.kind.direct')
                        : t('toolAccess.kind.onDemand')}
                  </span>
                </div>
                <button
                  type="button"
                  className="button secondary small"
                  aria-label={t(
                    tool['disabled'] === true ? 'toolAccess.enableTool' : 'toolAccess.disableTool',
                    { name: String(tool['name']) },
                  )}
                  disabled={!!busy}
                  onClick={() => void toggle(tool)}
                >
                  <Power size={13} />
                  {busy === tool['name']
                    ? t('toolAccess.updating')
                    : tool['disabled'] === true
                      ? t('toolAccess.enable')
                      : t('toolAccess.disable')}
                </button>
              </header>
              <div className="tool-access-badges">
                <span>
                  {tool['mutating'] === true ? t('toolAccess.mutating') : t('toolAccess.readOnly')}
                </span>
                <span>
                  {t('toolAccess.permission', {
                    permission: t(`toolAccess.permission_${String(tool['permission'] ?? 'auto')}`, {
                      defaultValue: String(tool['permission'] ?? 'auto'),
                    }),
                  })}
                </span>
              </div>
              <details>
                <summary>{t('toolAccess.details')}</summary>
                <p>{String(tool['description'] ?? t('toolAccess.noDescription'))}</p>
                {Array.isArray(tool['params']) && tool['params'].length > 0 && (
                  <div className="tool-input-names">
                    <span>{t('toolAccess.inputs')}</span>
                    {tool['params'].map((param) => (
                      <code key={String(param)}>{String(param)}</code>
                    ))}
                  </div>
                )}
              </details>
            </article>
          ))}
        </section>
      )}
      {!loading && !filtered.length && <p className="quiet-state">{t('toolAccess.noMatch')}</p>}
    </section>
  );
}
