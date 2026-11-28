import {
  hasToolOverview,
  ToolCallOverview,
} from '@wrongstack/project-surfaces/tools/ToolCallOverview';
import { FileCode2 } from 'lucide-react';
import { I18nextProvider } from 'react-i18next';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { GeneratedImages } from './GeneratedImages';
import type { ActivityRow } from './session-activity-model';
import { surfaceI18n } from './surface-i18n';
import { StructuredToolValue } from './ToolApprovalCard';
import { ToolInputView } from './ToolInputView';
import { ToolOutputActions } from './ToolOutputActions';

function readableOutput(value: string): unknown {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      /* Plain text remains unchanged. */
    }
  }
  return value;
}

/** The size of what the call returned (the whole result, not the preview): lines and bytes. */
function outputSize(output: string, bytes: number | undefined): { count: number; size: string } {
  const lines = output.replace(/\n$/, '').split('\n').length;
  const size = bytes ?? new TextEncoder().encode(output).length;
  const amount =
    size < 1024
      ? `${size} B`
      : size < 1024 * 1024
        ? `${(size / 1024).toFixed(1)} KiB`
        : `${(size / 1024 / 1024).toFixed(1)} MiB`;
  return { count: lines, size: amount };
}

/** What an opened activity entry shows: a known tool's overview, the call's input, progress, output and files. */
export function ActivityEntryBody({
  row,
  onOpenFile,
  command,
  overview = true,
}: {
  row: ActivityRow;
  /** The shared overview card of a known tool (the run log has it; a conversation row does not). */
  overview?: boolean | undefined;
  onOpenFile: (path: string) => void;
  command?: EngineCommand | undefined;
}) {
  const { t } = useDesktopText();
  return (
    <div className="activity-entry-body">
      {overview && row.kind === 'tool' && hasToolOverview(row.title, row.input) && (
        <I18nextProvider i18n={surfaceI18n}>
          <div className="ws-surfaces">
            <ToolCallOverview
              message={{
                toolName: row.title,
                toolInput: row.input,
                toolResult: row.output,
                toolOutputBytes: row.outputBytes,
              }}
            />
          </div>
        </I18nextProvider>
      )}
      {row.input !== undefined && (
        <section className="approval-arguments" aria-label={t('runLog.inputLabel')}>
          <strong>{t('runLog.input')}</strong>
          {row.kind === 'tool' ? (
            <ToolInputView name={row.title} input={row.input} />
          ) : (
            <StructuredToolValue value={row.input} />
          )}
        </section>
      )}
      {row.progress.length > 0 && (
        <section>
          <h4>{t('runLog.progress')}</h4>
          {row.progress.map((text, i) => (
            <pre key={i}>{text}</pre>
          ))}
        </section>
      )}
      {row.output && (
        <section>
          {/* The actions sit beside the heading, not in it: a heading is named by its
            text, so "Output" must not read as "Output exit 0 Copy Save". */}
          <div className="activity-output-heading">
            <h4>
              {row.kind === 'reasoning'
                ? t('runLog.thinking')
                : row.kind === 'retry'
                  ? t('runLog.retryDetails')
                  : row.outputBytes !== undefined &&
                      row.outputBytes > new TextEncoder().encode(row.output).length
                    ? t('runLog.outputPreview')
                    : t('runLog.output')}
            </h4>
            {row.kind === 'tool' && (
              <small className="activity-output-size">
                {t('runLog.outputSize', outputSize(row.output, row.outputBytes))}
              </small>
            )}
            {row.kind === 'tool' && <ToolOutputActions tool={row.title} output={row.output} />}
          </div>
          <div className="approval-arguments">
            <StructuredToolValue value={readableOutput(row.output)} />
          </div>
          {command && row.kind === 'tool' && row.title === 'image_generate' && (
            <GeneratedImages output={row.output} command={command} />
          )}
        </section>
      )}
      {row.files.length > 0 && (
        <section>
          <h4>{t('runLog.files')}</h4>
          <div className="activity-files">
            {row.files.map((file) => (
              <button type="button" key={file.path} onClick={() => onOpenFile(file.path)}>
                <FileCode2 size={13} />
                <span>{file.path}</span>
                <small>{file.operation}</small>
              </button>
            ))}
          </div>
        </section>
      )}
      {row.sage.length > 0 && (
        <section>
          <h4>{t('runLog.sage')}</h4>
          <ul>
            {row.sage.map((memory, i) => (
              <li key={i}>{memory}</li>
            ))}
          </ul>
        </section>
      )}
      {!row.input &&
        !row.output &&
        !row.progress.length &&
        !row.files.length &&
        !row.sage.length && <p>{t('runLog.noDetails')}</p>}
    </div>
  );
}
