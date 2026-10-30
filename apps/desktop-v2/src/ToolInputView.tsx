import { StructuredToolValue } from './ToolApprovalCard';
import { toolInputView } from './tool-input-view';

/** A tool's input in the form that fits it: a diff, a file preview, a command, or the raw value. */
export function ToolInputView({ name, input }: { name: string; input: unknown }) {
  const view = toolInputView(name, input);
  if (view.kind === 'edit')
    return (
      <div className="tool-input-view">
        <code>{view.path}</code>
        {view.all && <small> · every occurrence</small>}
        <pre className="tool-diff">
          {view.removed.map((line, index) => (
            <span key={`r${index}`} className="tool-diff-removed">
              {`- ${line}\n`}
            </span>
          ))}
          {view.added.map((line, index) => (
            <span key={`a${index}`} className="tool-diff-added">
              {`+ ${line}\n`}
            </span>
          ))}
        </pre>
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
  return <StructuredToolValue value={input} />;
}
