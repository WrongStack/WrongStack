import { describe, expect, it } from 'vitest';
import {
  summarizeToolUsage,
  type ToolUsageEvent,
} from '../../src/observability/tool-usage-report.js';

describe('tool usage evidence report', () => {
  const ts = '2026-10-31T10:00:00.000Z';
  const catalog = [{ name: 'read', aliases: ['old_read'] }, { name: 'write' }];
  const journal: ToolUsageEvent[] = [
    { type: 'tool_use', id: '1', name: 'old_read', ts },
    { type: 'tool_result', id: '1', ts, isError: false },
    { type: 'tool_result', id: '1', ts, isError: false },
    { type: 'tool_use', id: '2', name: 'read', ts },
    { type: 'tool_result', id: '2', ts, isError: true },
    { type: 'tool_use', id: 'pending', name: 'read', ts },
  ];
  it('counts settled calls once, joins aliases and isolates IDs by session', () => {
    const report = summarizeToolUsage(catalog, [journal, journal]);
    expect(report.tools.find((t) => t.name === 'read')).toMatchObject({
      invocations: 4,
      failures: 2,
      sessions: 2,
    });
    expect(report.tools.find((t) => t.name === 'write')).toMatchObject({
      invocations: 0,
      observation: 'not-observed',
    });
    expect(report.unsettledCalls).toBe(2);
  });
  it('recovers core-audit calls from assistant messages and deduplicates journal copies', () => {
    const coreAudit = [
      {
        type: 'llm_response',
        ts,
        content: [
          { type: 'tool_use', id: 'core-1', name: 'read', input: { secret: 'input-secret' } },
        ],
      },
      {
        type: 'message_appended',
        ts,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'core-1', name: 'read' }] },
      },
      { type: 'tool_result', id: 'core-1', ts, isError: false, content: 'output-secret' },
      {
        type: 'message_appended',
        ts,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'core-1', is_error: false }],
        },
      },
      { type: 'user_input', ts, content: [{ type: 'tool_use', id: 'fake', name: 'write' }] },
    ] as unknown as ToolUsageEvent[];
    const report = summarizeToolUsage(catalog, [coreAudit]);
    expect(report.tools.find((t) => t.name === 'read')?.invocations).toBe(1);
    expect(report.tools.find((t) => t.name === 'write')?.invocations).toBe(0);
    expect(report.unrecognizedCalls).toBe(0);
    expect(JSON.stringify(report)).not.toMatch(/input-secret|output-secret/);
  });
  it('bounds observations to the requested window without treating missing observations as removal evidence', () => {
    expect(
      summarizeToolUsage(catalog, [journal], { from: '2026-11-01' }).tools.every(
        (t) => t.observation === 'not-observed',
      ),
    ).toBe(true);
    expect(() => summarizeToolUsage(catalog, [journal], { from: 'invalid' })).toThrow(/window/);
    expect(
      summarizeToolUsage(catalog, [[{ type: 'tool_result', id: 'orphan', ts }]]).unrecognizedCalls,
    ).toBe(1);
  });

  it('attributes settled calls to their invocation timestamp at window boundaries', () => {
    const insideCall = '2026-10-31T23:59:59.000Z';
    const report = summarizeToolUsage(
      catalog,
      [
        [
          { type: 'tool_use', id: 'control', name: 'read', ts: '2026-10-15T10:00:00.000Z' },
          { type: 'tool_result', id: 'control', ts: '2026-10-15T10:00:01.000Z' },
          { type: 'tool_use', id: 'inside-call', name: 'read', ts: insideCall },
          { type: 'tool_result', id: 'inside-call', ts: '2026-11-01T00:00:01.000Z' },
          { type: 'tool_use', id: 'before-call', name: 'write', ts: '2026-09-30T23:59:59.000Z' },
          { type: 'tool_result', id: 'before-call', ts: '2026-10-01T00:00:01.000Z' },
        ],
      ],
      { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z' },
    );
    expect(report.tools.find((tool) => tool.name === 'read')).toMatchObject({
      invocations: 2,
      lastInvokedAt: insideCall,
    });
    expect(report.tools.find((tool) => tool.name === 'write')).toMatchObject({
      invocations: 0,
      observation: 'not-observed',
    });
  });
});
