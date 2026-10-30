import { DiffPreview } from './DiffPreview';
import { StructuredToolValue } from './ToolApprovalCard';
import { toolInputView } from './tool-input-view';

/** A tool's input in the form that fits it: a diff, a file preview, a command, or the raw value. */
export function ToolInputView({ name, input }: { name: string; input: unknown }) {
  const view = toolInputView(name, input);
  if (view.kind === 'edit')
    return (
      <div className="tool-input-view">
        {view.all && <small>Every occurrence is replaced.</small>}
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
          {view.more ? `\n… ${view.more} more lines` : ''}
        </pre>
      </div>
    );
  if (view.kind === 'command')
    return (
      <div className="tool-input-view">
        {view.cwd && <small>in {view.cwd}</small>}
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
          {view.tool === 'grep' ? 'Search for' : 'Find files'} <code>{view.pattern}</code>
          {view.path ? (
            <>
              {' '}
              in <code>{view.path}</code>
            </>
          ) : null}
        </span>
        {view.details.length > 0 && <small>{view.details.join(' · ')}</small>}
      </div>
    );
  if (view.kind === 'replace')
    return (
      <div className="tool-input-view">
        <span>
          Replace <code>{view.pattern}</code> with <code>{view.replacement || '(nothing)'}</code>
        </span>
        <small>{view.details.join(' · ')}</small>
        {view.files.length > 0 && (
          <ul className="tool-input-files">
            {view.files.slice(0, 20).map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
            {view.files.length > 20 && <li>… {view.files.length - 20} more</li>}
          </ul>
        )}
      </div>
    );
  return <StructuredToolValue value={input} />;
}
