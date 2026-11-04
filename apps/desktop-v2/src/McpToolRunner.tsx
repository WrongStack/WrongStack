import { Play, Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { Modal } from './Modal';
import { parseToolInput, schemaFields, skeletonInput } from './mcp-tool-input';
import './mcp-content.css';

/**
 * One MCP server's tools, and running one of them as a step of this
 * conversation. The engine runs it through the conversation's own permission
 * and approval path and adds its result to the conversation; the dialog only
 * collects the call.
 */
export function McpToolRunner({
  name,
  command,
  onRun,
  onClose,
}: {
  name: string;
  command: EngineCommand;
  onRun: (tool: string, input: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const { t } = useDesktopText();
  const [tools, setTools] = useState<Record<string, unknown>[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [query, setQuery] = useState(''),
    [selected, setSelected] = useState(''),
    [input, setInput] = useState('{}'),
    [inputError, setInputError] = useState('');
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    void command('mcp.tools', { name }, ['mcp.tools', 'mcp.content.error'])
      .then((reply) => {
        if (alive) setTools(entries(reply['tools']));
      })
      .catch((error: unknown) => {
        if (alive) setError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [command, name]);
  const tool = tools.find((row) => row['name'] === selected);
  const choose = (row: Record<string, unknown>) => {
    setSelected(String(row['name']));
    setInput(JSON.stringify(skeletonInput(row['inputSchema']), null, 2));
    setInputError('');
  };
  const run = () => {
    const parsed = parseToolInput(input);
    if (!parsed.ok)
      return setInputError(
        parsed.reason === 'object'
          ? t('mcpTools.notObject')
          : t('mcpTools.notJson', { detail: parsed.detail ?? '' }),
      );
    onRun(selected, parsed.value);
  };
  const shown = tools.filter((row) =>
    `${row['name']} ${row['description'] ?? ''}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <Modal title={t('mcpTools.modalTitle', { name })} onClose={onClose}>
      <div className="mcp-content-browser">
        <header>
          <div>
            <span className="eyebrow">{t('mcpEditor.eyebrow', { name })}</span>
            <h2>{t('mcpTools.title')}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={t('mcpTools.close')}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <p>{t('mcpTools.intro')}</p>
        {error && (
          <p className="session-error" role="alert">
            {error}
          </p>
        )}
        <div className="mcp-content-workbench">
          <aside>
            <label className="mcp-content-search">
              <Search size={14} />
              <input
                aria-label={t('mcpTools.search')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('mcpTools.placeholder')}
              />
            </label>
            {loading && <p role="status">{t('mcpTools.reading')}</p>}
            <section>
              <h3>
                {t('mcpTools.tools')} <small>{shown.length}</small>
              </h3>
              {shown.map((row) => (
                <button
                  type="button"
                  key={String(row['name'])}
                  aria-pressed={selected === row['name']}
                  onClick={() => choose(row)}
                >
                  <strong>{String(row['name'])}</strong>
                  <p>{String(row['description'] ?? '')}</p>
                </button>
              ))}
              {!loading && !shown.length && <p className="quiet-state">{t('mcpTools.none')}</p>}
            </section>
          </aside>
          <div className="mcp-content-detail">
            {tool ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  run();
                }}
              >
                <header>
                  <span className="eyebrow">{t('mcpTools.eyebrow')}</span>
                  <h3>{selected}</h3>
                  <p>{String(tool['description'] ?? '')}</p>
                </header>
                <ToolFields schema={record(tool['inputSchema'])} />
                <label>
                  {t('mcpTools.input')}
                  <textarea
                    aria-label={t('mcpTools.inputLabel')}
                    rows={8}
                    spellCheck={false}
                    value={input}
                    onChange={(event) => {
                      setInput(event.target.value);
                      setInputError('');
                    }}
                  />
                </label>
                {inputError && (
                  <p className="session-error" role="alert">
                    {inputError}
                  </p>
                )}
                <button type="submit" className="button primary">
                  <Play size={14} />
                  {t('mcpTools.run')}
                </button>
              </form>
            ) : (
              <p className="mcp-content-empty">{t('mcpTools.choose')}</p>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ToolFields({ schema }: { schema: Record<string, unknown> }) {
  const { t } = useDesktopText();
  const fields = schemaFields(schema);
  if (!fields.length) return <p className="quiet-state">{t('mcpTools.noFields')}</p>;
  return (
    <p className="mcp-tool-fields">
      {fields.map((field) => (
        <code key={field.name}>
          {field.name}
          {field.required ? '*' : ''}: {field.type}
        </code>
      ))}
    </p>
  );
}
