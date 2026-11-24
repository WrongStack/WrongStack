import { describe, expect, it } from 'vitest';
import {
  toolDisplayName,
  toolFlowInput,
  toolFlowMetrics,
  toolFlowMetricsLabel,
} from '../src/presentation.js';

const result = 'answer\n\n(50 tool calls: read ×50)\n\nToolFlow bytes: 550000 -> 40; calls: 50';
describe('ToolFlow shared presentation', () => {
  it('recognizes direct, deferred, and replayed inputs without renaming unrelated tools', () => {
    expect(toolDisplayName('tool_script')).toBe('WrongStack ToolFlow');
    expect(
      toolDisplayName(
        'tool_use',
        JSON.stringify({ tool: 'tool_script', input: { script: 'return 1;' } }),
      ),
    ).toBe('WrongStack ToolFlow');
    expect(
      toolFlowInput('tool_use', { tool: 'tool_script', input: { script: 'return 1;' } }),
    ).toEqual({ script: 'return 1;' });
    expect(toolDisplayName('tool_use', { tool: 'read' })).toBe('tool_use');
    expect(toolDisplayName('custom')).toBe('custom');
  });
  it('reads measured output from direct and deferred results', () => {
    const metrics = { calls: 50, failedCalls: 0, toolResultBytes: 550000, returnedBytes: 40 };
    expect(toolFlowMetrics(result)).toEqual(metrics);
    expect(toolFlowMetrics(JSON.stringify({ tool: 'tool_script', result }))).toEqual(metrics);
    expect(toolFlowMetricsLabel(result)).toContain('50 calls · 550000 B tool results');
    expect(toolFlowMetrics('nothing')).toBeUndefined();
    expect(toolFlowMetricsLabel(`${result}; failed: 2`)).toContain('50 calls · 2 failed');
    expect(
      toolFlowMetrics('answer\n\n(no tool calls)\n\nToolFlow bytes: 0 -> 28; calls: 0')?.calls,
    ).toBe(0);
  });
});
