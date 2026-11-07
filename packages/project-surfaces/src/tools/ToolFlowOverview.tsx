import {
  TOOLFLOW_LABEL,
  toolFlowInput,
  toolFlowMetricsLabel,
} from '@wrongstack/tools/tool-summary';
import { Code2 } from 'lucide-react';
import { useAppTranslation } from '../lib/i18n';
import type { ToolOverviewMessage } from './tool-overview-types';

export function ToolFlowOverview({ message }: { message: ToolOverviewMessage }) {
  const { t } = useAppTranslation();
  const input = toolFlowInput(message.toolName, message.toolInput);
  const script = typeof input?.script === 'string' ? input.script : '';
  const metrics = toolFlowMetricsLabel(message.toolResult);
  return (
    <section
      aria-label={`${TOOLFLOW_LABEL} overview`}
      data-tool-overview="toolflow"
      className="space-y-2 rounded-md border border-info/30 bg-info/[0.04] p-3"
    >
      <header className="flex items-center gap-2 font-semibold">
        <Code2 className="size-4" />
        {TOOLFLOW_LABEL}
      </header>
      <p className="text-xs text-muted-foreground">
        Compose tools. Return answers. Each tool call keeps its own permission checks.
      </p>
      {typeof input?.description === 'string' && <p className="text-sm">{input.description}</p>}
      {metrics && (
        <p
          role="status"
          className="break-words font-mono text-xs"
          aria-label={t('activity:toolOverview.toolFlowMeasuredOutput')}
        >
          {metrics}
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-xs">
          JavaScript · {script.trim() ? script.trim().split(/\r?\n/).length : 0} lines
        </summary>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-2 font-mono text-xs">
          {script}
        </pre>
      </details>
      <p className="text-[11px] text-muted-foreground">
        Byte counts measure tool results and the script return before the metrics line and executor
        previews. The activity card's output size measures the model-visible result. These counts do
        not measure tokens, cost, or speed.
      </p>
    </section>
  );
}
