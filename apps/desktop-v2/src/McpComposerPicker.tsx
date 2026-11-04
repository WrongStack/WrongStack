import { Plug, RefreshCw, Wrench } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries } from './engine-values';
import { McpContentBrowser } from './McpContentBrowser';
import { McpToolRunner } from './McpToolRunner';
import { Modal } from './Modal';

export function McpComposerPicker({
  command,
  onInsert,
  onClose,
  sessionId,
  onNotice,
}: {
  command: EngineCommand;
  onInsert: (text: string) => Promise<void>;
  onClose: () => void;
  /** With both, a connection's tools can be run as a step of this conversation. */
  sessionId?: string | undefined;
  onNotice?: ((text: string) => void) | undefined;
}) {
  const { t } = useDesktopText();
  const [servers, setServers] = useState<Record<string, unknown>[]>([]),
    [selected, setSelected] = useState(''),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0),
    [toolsOf, setToolsOf] = useState('');
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    void command('mcp.list', {}, ['mcp.list'])
      .then((result) => {
        if (alive) setServers(entries(result['servers']));
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
  }, [command, revision]);
  if (toolsOf && sessionId && onNotice)
    return (
      <McpToolRunner
        name={toolsOf}
        command={command}
        onClose={() => setToolsOf('')}
        onRun={(tool, input) => {
          // The call can wait on an approval in the conversation, which this
          // dialog would cover: close first, report the outcome in the composer.
          onClose();
          onNotice(t('mcpPicker.running', { tool, server: toolsOf }));
          void command(
            'mcp.tool.call',
            { sessionId, name: toolsOf, tool, input },
            ['mcp.tool.result'],
            { timeoutMs: 600_000 },
          )
            .then((reply) =>
              onNotice(String(reply['message'] ?? t('mcpPicker.finished', { tool }))),
            )
            .catch((error: unknown) =>
              onNotice(error instanceof Error ? error.message : String(error)),
            );
        }}
      />
    );
  if (selected)
    return (
      <McpContentBrowser
        name={selected}
        command={command}
        onClose={() => setSelected('')}
        onInsert={onInsert}
      />
    );
  return (
    <Modal title={t('mcpPicker.modalTitle')} onClose={onClose}>
      <div className="composer-dialog resource-dialog">
        <header>
          <div>
            <span className="eyebrow">{t('mcpPicker.eyebrow')}</span>
            <h2>{t('mcpPicker.title')}</h2>
          </div>
        </header>
        <p>
          {t('mcpPicker.intro')}
          {sessionId && onNotice ? t('mcpPicker.introTools') : ''}
        </p>
        <button
          type="button"
          className="button secondary"
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw size={14} />
          {t('mcpPicker.refresh')}
        </button>
        {error && (
          <p role="alert" className="session-error">
            {error}
          </p>
        )}
        {loading ? (
          <p role="status">{t('mcpPicker.reading')}</p>
        ) : servers.length ? (
          <div className="mcp-composer-connections">
            {servers.map((server) => (
              <div className="mcp-composer-connection" key={String(server['name'])}>
                <button
                  type="button"
                  className="button secondary"
                  disabled={!server['enabled']}
                  onClick={() => setSelected(String(server['name']))}
                >
                  <Plug size={14} />
                  <span>{String(server['name'])}</span>
                  <small>
                    {server['enabled']
                      ? String(server['status'] ?? t('mcpPicker.enabled'))
                      : t('mcpPicker.disabled')}
                  </small>
                </button>
                {sessionId && onNotice && (
                  <button
                    type="button"
                    className="button secondary"
                    aria-label={t('mcpPicker.runTools', { name: String(server['name']) })}
                    disabled={!server['enabled']}
                    onClick={() => setToolsOf(String(server['name']))}
                  >
                    <Wrench size={14} />
                    {t('mcpPicker.tools')}
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="quiet-state">{t('mcpPicker.none')}</p>
        )}
        <button type="button" className="button secondary" onClick={onClose}>
          {t('mcpPicker.back')}
        </button>
      </div>
    </Modal>
  );
}
