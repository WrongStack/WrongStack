import { describe, expect, it } from 'vitest';
import { publishAcpLiveProgress } from '../src/acp-live-progress.js';

const ROCKET = '\u{1F680}';

function progress(rawOutput: unknown): unknown {
  const emitted: Array<{ payload?: { output?: unknown } }> = [];
  publishAcpLiveProgress({
    event: {
      type: 'tool_call_update',
      toolCall: {
        toolCallId: 'call-1',
        title: 'bash',
        kind: 'execute',
        status: 'completed',
        rawOutput: rawOutput as Record<string, unknown> | undefined,
      },
    },
    subagentId: 'a1',
    agentName: 'agent',
    fleet: { emit: (event: { payload?: { output?: unknown } }) => emitted.push(event) } as never,
  });
  return emitted[0]?.payload?.output;
}

/**
 * F2656: `safeJson` caps the JSON-rendered ACP tool output at 4095 UTF-16 units
 * with a plain `.slice`. The emitted `output` is rendered by the fleet panel,
 * WebUI Agents panel and HQ timeline, so a split astral character is visible
 * there and travels in the host event.
 */
describe('ACP live progress output keeps valid UTF-16 (F2656)', () => {
  it('drops the orphaned half in the JSON output', () => {
    const out = progress({ text: `${'x'.repeat(4085)}${ROCKET}tail` });

    expect(typeof out).toBe('string');
    expect((out as string).isWellFormed()).toBe(true);
  });

  it('keeps a short output unchanged (control)', () => {
    expect(progress('plain output')).toBe('"plain output"');
  });
});
