import { Trans } from 'react-i18next';
import { DiffPreview } from './DiffPreview';
import { useDesktopText } from './desktop-i18n';
import { surfaceI18n } from './surface-i18n';
import { StructuredToolValue } from './ToolApprovalCard';
import { toolInputView } from './tool-input-view';

/** A tool's input in the form that fits it: a diff, a file preview, a command, or the raw value. */
export function ToolInputView({ name, input }: { name: string; input: unknown }) {
  const { t } = useDesktopText();
  const view = toolInputView(name, input);
  if (view.kind === 'edit')
    return (
      <div className="tool-input-view">
        {view.all && <small>{t('toolInput.allReplaced')}</small>}
        <DiffPreview
          before={view.removed.join('\n')}
          after={view.added.join('\n')}
          path={view.path}
        />
      </div>
    );
  if (view.kind === 'write')
    return (
      <div className="tool-input-view">
        <code>{view.path}</code>
        <pre className="tool-diff">
          {view.lines.join('\n')}
          {view.more ? `\n${t('toolInput.moreLines', { count: view.more })}` : ''}
        </pre>
      </div>
    );
  if (view.kind === 'command')
    return (
      <div className="tool-input-view">
        {view.cwd && <small>{t('toolInput.in', { path: view.cwd })}</small>}
        <pre className="tool-command">{`$ ${view.command}`}</pre>
      </div>
    );
  if (view.kind === 'read')
    return (
      <div className="tool-input-view">
        <span>
          <code>{view.path}</code> · {view.range}
        </span>
      </div>
    );
  if (view.kind === 'search')
    return (
      <div className="tool-input-view">
        <span>
          <Trans
            i18n={surfaceI18n}
            ns="desktop"
            i18nKey={
              view.tool === 'grep'
                ? view.path
                  ? 'toolInput.searchIn'
                  : 'toolInput.search'
                : view.path
                  ? 'toolInput.findIn'
                  : 'toolInput.find'
            }
            values={{ pattern: view.pattern, path: view.path }}
            components={{ code: <code /> }}
          />
        </span>
        {view.details.length > 0 && <small>{view.details.join(' · ')}</small>}
      </div>
    );
  if (view.kind === 'replace')
    return (
      <div className="tool-input-view">
        <span>
          <Trans
            i18n={surfaceI18n}
            ns="desktop"
            i18nKey="toolInput.replace"
            values={{
              pattern: view.pattern,
              replacement: view.replacement || t('toolInput.nothing'),
            }}
            components={{ code: <code /> }}
          />
        </span>
        <small>{view.details.join(' · ')}</small>
        {view.files.length > 0 && (
          <ul className="tool-input-files">
            {view.files.slice(0, 20).map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
            {view.files.length > 20 && (
              <li>{t('toolInput.more', { count: view.files.length - 20 })}</li>
            )}
          </ul>
        )}
      </div>
    );
  return <StructuredToolValue value={input} />;
}
