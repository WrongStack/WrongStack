import { Copy, FileText, RefreshCw, Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { MarkdownContent } from './MarkdownContent';
import { McpBinaryBlock } from './McpBinaryBlock';
import { Modal } from './Modal';
import { mcpContentText } from './mcp-content-text';
import './mcp-content.css';
import { displayLocale } from './display-dates';

type Item = {
  key: string;
  kind: 'resource' | 'template' | 'prompt';
  value: Record<string, unknown>;
};
export function McpContentBrowser({
  name,
  command,
  onClose,
  onInsert,
}: {
  name: string;
  command: EngineCommand;
  onClose: () => void;
  onInsert?: (text: string) => Promise<void>;
}) {
  const { t } = useDesktopText();
  const [catalog, setCatalog] = useState<Item[]>([]),
    [query, setQuery] = useState(''),
    [selected, setSelected] = useState<Item | null>(null),
    [uri, setUri] = useState(''),
    [argumentsByPrompt, setArguments] = useState<Record<string, Record<string, string>>>({});
  const [content, setContent] = useState<Record<string, unknown> | null>(null),
    [error, setError] = useState(''),
    [catalogError, setCatalogError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [notice, setNotice] = useState(''),
    [leaving, setLeaving] = useState(false);
  const alive = useRef(true),
    catalogSequence = useRef(0),
    selectionSequence = useRef(0);
  const load = async (refresh = false) => {
    const version = ++catalogSequence.current;
    setLoading(true);
    setCatalogError('');
    const results = await Promise.allSettled([
      command('mcp.resources', { name, refresh }, ['mcp.resources', 'mcp.content.error']),
      command('mcp.prompts', { name, refresh }, ['mcp.prompts', 'mcp.content.error']),
    ]);
    if (!alive.current || version !== catalogSequence.current) return;
    const items: Item[] = [];
    if (results[0].status === 'fulfilled') {
      for (const value of entries(results[0].value['resources']))
        items.push({ key: `resource:${value['uri']}`, kind: 'resource', value });
      for (const value of entries(results[0].value['resourceTemplates']))
        items.push({ key: `template:${value['uriTemplate']}`, kind: 'template', value });
    }
    if (results[1].status === 'fulfilled')
      for (const value of entries(results[1].value['prompts']))
        items.push({ key: `prompt:${value['name']}`, kind: 'prompt', value });
    setCatalog(items);
    setCatalogError(
      results
        .flatMap((result) => (result.status === 'rejected' ? [String(result.reason)] : []))
        .join('\n'),
    );
    setLoading(false);
  };
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      catalogSequence.current++;
      selectionSequence.current++;
    };
  }, [name, command]);
  const choose = (item: Item) => {
    selectionSequence.current++;
    setSelected(item);
    setUri(item.kind === 'resource' ? String(item.value['uri']) : '');
    setContent(null);
    setError('');
    setNotice('');
    setBusy(false);
  };
  const args = argumentsByPrompt[selected?.key ?? ''] ?? {};
  const insert = async () => {
    if (!content || !onInsert || busy) return;
    setBusy(true);
    setError('');
    try {
      await onInsert(mcpContentText(content, name));
    } catch (error) {
      if (alive.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const read = async () => {
    if (!selected || busy) return;
    const version = ++selectionSequence.current;
    setBusy(true);
    setError('');
    setContent(null);
    setNotice('');
    try {
      const result = await command(
        selected.kind === 'prompt' ? 'mcp.prompt.get' : 'mcp.resource.read',
        {
          name,
          ...(selected.kind === 'prompt'
            ? {
                prompt: selected.value['name'],
                arguments: Object.fromEntries(
                  Object.entries(args).filter(([, value]) => value !== ''),
                ),
              }
            : { uri }),
        },
        ['mcp.content.selected', 'mcp.content.error'],
      );
      if (!alive.current || version !== selectionSequence.current) return;
      if (
        result['untrusted'] !== true ||
        record(result['provenance'])['serverName'] !== name ||
        !['resource', 'prompt'].includes(String(result['kind']))
      )
        throw Error(t('mcpContent.unrecognized'));
      setContent(result);
    } catch (error) {
      if (alive.current && version === selectionSequence.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (alive.current && version === selectionSequence.current) setBusy(false);
    }
  };
  const close = () => {
    if (
      Object.values(argumentsByPrompt).some((values) => Object.values(values).some(Boolean)) ||
      (selected?.kind === 'template' && uri)
    )
      setLeaving(true);
    else onClose();
  };
  return (
    <Modal title={t('mcpContent.modalTitle', { name })} onClose={close}>
      <div className="mcp-content-browser">
        <header>
          <div>
            <span className="eyebrow">{t('mcpEditor.eyebrow', { name })}</span>
            <h2>{t('mcpContent.title')}</h2>
          </div>
          <div className="feature-actions">
            <button
              type="button"
              className="button secondary"
              disabled={loading}
              onClick={() => void load(true)}
            >
              <RefreshCw size={14} />
              {t('mcpContent.refresh')}
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={t('mcpContent.close')}
              onClick={close}
            >
              <X size={18} />
            </button>
          </div>
        </header>
        <p>{t('mcpContent.intro')}</p>
        {catalogError && (
          <p className="session-error" role="alert">
            {catalogError}
          </p>
        )}
        <div className="mcp-content-workbench">
          <aside>
            <label className="mcp-content-search search-field">
              <Search size={14} />
              <input
                aria-label={t('mcpContent.search')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('mcpContent.placeholder')}
              />
            </label>
            {loading && <p role="status">{t('mcpContent.reading')}</p>}
            {(['resource', 'template', 'prompt'] as const).map((kind) => {
              const rows = catalog.filter(
                (item) =>
                  item.kind === kind &&
                  `${item.value['name']} ${item.value['title']} ${item.value['description']} ${item.value['uri'] ?? item.value['uriTemplate'] ?? ''}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
              );
              return (
                <section key={kind}>
                  <h3>
                    {t(`mcpContent.kind.${kind}`)} <small>{rows.length}</small>
                  </h3>
                  {rows.map((item) => (
                    <button
                      type="button"
                      key={item.key}
                      aria-pressed={selected?.key === item.key}
                      onClick={() => choose(item)}
                    >
                      <strong>{String(item.value['title'] ?? item.value['name'])}</strong>
                      {item.kind !== 'prompt' && (
                        <code>{String(item.value['uri'] ?? item.value['uriTemplate'])}</code>
                      )}
                      <p>{String(item.value['description'] ?? '')}</p>
                    </button>
                  ))}
                  {!loading && !rows.length && (
                    <p className="quiet-state">{t(`mcpContent.none.${kind}`)}</p>
                  )}
                </section>
              );
            })}
          </aside>
          <div className="mcp-content-detail">
            {selected ? (
              <>
                <header>
                  <span className="eyebrow">{t(`mcpContent.eyebrow.${selected.kind}`)}</span>
                  <h3>{String(selected.value['title'] ?? selected.value['name'])}</h3>
                  <p>{String(selected.value['description'] ?? '')}</p>
                </header>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void read();
                  }}
                >
                  <fieldset disabled={busy}>
                    {selected.kind === 'prompt' ? (
                      <>
                        {entries(selected.value['arguments']).map((argument) => {
                          const key = String(argument['name']);
                          return (
                            <label key={key}>
                              {key}
                              {argument['required'] === true
                                ? t('mcpContent.required')
                                : t('mcpContent.optional')}
                              <input
                                aria-label={t('mcpContent.argument', { name: key })}
                                required={argument['required'] === true}
                                value={args[key] ?? ''}
                                onChange={(event) => {
                                  selectionSequence.current++;
                                  setContent(null);
                                  setArguments((current) => ({
                                    ...current,
                                    [selected.key]: {
                                      ...current[selected.key],
                                      [key]: event.target.value,
                                    },
                                  }));
                                }}
                              />
                              <small>{String(argument['description'] ?? '')}</small>
                            </label>
                          );
                        })}
                        {!entries(selected.value['arguments']).length && (
                          <p>{t('mcpContent.noArguments')}</p>
                        )}
                      </>
                    ) : (
                      <label>
                        {selected.kind === 'template'
                          ? t('mcpContent.concreteUri')
                          : t('mcpContent.uri')}
                        <input
                          aria-label={t('mcpContent.uriLabel')}
                          required
                          readOnly={selected.kind === 'resource'}
                          value={uri}
                          placeholder={String(selected.value['uriTemplate'] ?? '')}
                          onChange={(event) => {
                            selectionSequence.current++;
                            setContent(null);
                            setUri(event.target.value);
                          }}
                        />
                        {selected.kind === 'template' && (
                          <small>{t('mcpContent.templateHelp')}</small>
                        )}
                      </label>
                    )}
                    <button type="submit" className="button primary">
                      {busy
                        ? t('mcpContent.readingContent')
                        : selected.kind === 'prompt'
                          ? t('mcpContent.resolve')
                          : t('mcpContent.read')}
                    </button>
                  </fieldset>
                </form>
                {error && (
                  <p className="session-error" role="alert">
                    {error}
                  </p>
                )}
                {content && (
                  <section
                    className="mcp-selected-content"
                    aria-label={t('mcpContent.selectedLabel')}
                  >
                    <header>
                      <div>
                        <h3>{t('mcpContent.selected')}</h3>
                        <p>
                          {t('mcpContent.size', {
                            bytes: Number(content['byteSize'] ?? 0).toLocaleString(displayLocale()),
                            name,
                            kind: String(content['kind']),
                          })}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => {
                          const blocks =
                            content['kind'] === 'resource'
                              ? entries(content['contents']).map((value) =>
                                  String(
                                    value['text'] ??
                                      `[Binary ${value['mimeType'] ?? 'resource'} omitted]`,
                                  ),
                                )
                              : entries(content['messages']).map(
                                  (message) =>
                                    `${message['role']}: ${String(record(message['content'])['text'] ?? '[Non-text content omitted]')}`,
                                );
                          void navigator.clipboard
                            .writeText(
                              `MCP ${content['kind']} from ${name}\n\n${blocks.join('\n\n')}`,
                            )
                            .then(() => setNotice(t('mcpContent.copied')))
                            .catch((error) => setError(String(error)));
                        }}
                      >
                        <Copy size={13} />
                        {t('mcpContent.copy')}
                      </button>
                    </header>
                    <p className="mcp-content-provenance">
                      {t('mcpContent.provenance', {
                        source: String(
                          record(content['provenance'])['resourceUri'] ??
                            record(content['provenance'])['promptName'] ??
                            '',
                        ),
                      })}
                    </p>
                    {onInsert && (
                      <div className="feature-actions">
                        <button
                          type="button"
                          className="button primary"
                          disabled={busy}
                          onClick={() => void insert()}
                        >
                          {t('mcpContent.append')}
                        </button>
                        <small>{t('mcpContent.appendHelp')}</small>
                      </div>
                    )}
                    {content['kind'] === 'resource'
                      ? entries(content['contents']).map((value, index) => (
                          <article key={index}>
                            <small>
                              {String(value['uri'])} · {String(value['mimeType'] ?? 'text/plain')}
                            </small>
                            <McpContentBlock value={value} />
                          </article>
                        ))
                      : entries(content['messages']).map((message, index) => (
                          <article key={index}>
                            <span className="eyebrow">
                              {t('mcpContent.message', { role: String(message['role']) })}
                            </span>
                            <McpContentBlock value={record(message['content'])} />
                          </article>
                        ))}
                  </section>
                )}
                {notice && <p role="status">{notice}</p>}
              </>
            ) : (
              <div className="mcp-content-empty">
                <FileText size={32} />
                <h3>{t('mcpContent.emptyTitle')}</h3>
                <p>{t('mcpContent.emptyBody')}</p>
              </div>
            )}
          </div>
        </div>
        {leaving && (
          <div className="mcp-content-leave" role="alert">
            <p>{t('mcpContent.leaveQuestion')}</p>
            <button type="button" className="button secondary" onClick={() => setLeaving(false)}>
              {t('mcpContent.keepBrowsing')}
            </button>
            <button type="button" className="button secondary" onClick={onClose}>
              {t('mcpContent.discardClose')}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function McpContentBlock({ value }: { value: Record<string, unknown> }) {
  const { t } = useDesktopText();
  if (typeof value['text'] === 'string') return <MarkdownContent text={value['text']} />;
  if (value['type'] === 'resource') return <McpContentBlock value={record(value['resource'])} />;
  if (typeof value['blob'] === 'string' || typeof value['data'] === 'string')
    return <McpBinaryBlock value={value} />;
  if (typeof value['uri'] === 'string')
    return (
      <p>
        {t('mcpContent.link')} <code>{value['uri']}</code>
      </p>
    );
  return <p className="quiet-state">{t('mcpContent.noPreview')}</p>;
}
