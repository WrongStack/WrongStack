/** Browser-safe presentation shared by chat and tool catalogs. */
export const TOOLFLOW_LABEL = 'WrongStack ToolFlow';

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function toolFlowInput(
  name: string | undefined,
  input: unknown,
): Record<string, unknown> | undefined {
  const obj = record(input);
  if (name === 'tool_script') return obj ?? {};
  if (name === 'tool_use' && obj?.tool === 'tool_script') return record(obj.input) ?? {};
  return undefined;
}

export function toolDisplayName(name: string, input?: unknown): string {
  return toolFlowInput(name, input) ? TOOLFLOW_LABEL : name;
}

export interface ToolFlowMetrics {
  toolResultBytes: number;
  returnedBytes: number;
  calls: number;
  failedCalls: number;
}

/** Also understands the serialized result envelope of deferred tool_use calls. */
export function toolFlowMetrics(output: unknown): ToolFlowMetrics | undefined {
  const envelope = record(output);
  const value = envelope?.tool === 'tool_script' ? envelope.result : output;
  if (typeof value !== 'string') return undefined;
  const metrics = /\n\nToolFlow bytes: (\d+) -> (\d+); calls: (\d+)(?:; failed: (\d+))?$/.exec(
    value,
  );
  if (!metrics) return undefined;
  const result = {
    toolResultBytes: Number(metrics[1]),
    returnedBytes: Number(metrics[2]),
    calls: Number(metrics[3]),
    failedCalls: Number(metrics[4] ?? 0),
  };
  return Object.values(result).every(Number.isSafeInteger) && result.failedCalls <= result.calls
    ? result
    : undefined;
}

export function toolFlowMetricsLabel(output: unknown): string | undefined {
  const metrics = toolFlowMetrics(output);
  return metrics
    ? `${metrics.calls} calls${metrics.failedCalls ? ` · ${metrics.failedCalls} failed` : ''} · ${metrics.toolResultBytes} B tool results → ${metrics.returnedBytes} B script return`
    : undefined;
}
