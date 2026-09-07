import { createDefaultPipelines } from '@wrongstack/core/agent';
import type { Response } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { installVibeProtocol, VIBE_PROTOCOL_META_KEY } from '../src/vibe-protocol-wiring.js';

function response(content: Response['content']): Response {
  return {
    content,
    stopReason: 'end_turn',
    usage: { input: 10, output: 5 },
    model: 'test',
  };
}

describe('VIBE pipeline wiring', () => {
  it('runs Spec-Synthesizer, Coder, and Auditor for a case-insensitive [VIBE] prompt', async () => {
    const pipelines = createDefaultPipelines();
    installVibeProtocol(pipelines);
    const ctx = { meta: {} as Record<string, unknown> };
    const original = '[vIbE] butona basınca sepet artsın';

    const prepared = await pipelines.userInput.run({
      text: original,
      content: [{ type: 'text', text: original }],
      ctx: ctx as never,
    });

    expect(prepared.text).toContain('[vibe_protocol]');
    expect(prepared.text).toContain('VIBE Synthesized Specification');
    expect(ctx.meta[VIBE_PROTOCOL_META_KEY]).toMatchObject({
      isVibeMode: true,
      stage: 'coder',
    });

    const audited = await pipelines.response.run(
      response([{ type: 'text', text: 'Implemented the requested cart increment behavior.' }]),
    );
    const finalText = audited.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');

    expect(finalText).toContain('### 🛡️ [Auditor Verdict]');
    expect(finalText).toContain('✅ PASS');
    expect(ctx.meta[VIBE_PROTOCOL_META_KEY]).toMatchObject({
      isVibeMode: true,
      stage: 'passed',
      audit: { verdict: 'PASS' },
    });
  });

  it('leaves ordinary prompts unchanged and does not audit next-steps that mention [VIBE]', async () => {
    const pipelines = createDefaultPipelines();
    installVibeProtocol(pipelines);
    const ctx = { meta: {} as Record<string, unknown> };
    const original = 'Explain the parser behavior';
    const input = {
      text: original,
      content: [{ type: 'text' as const, text: original }],
      ctx: ctx as never,
    };

    expect(await pipelines.userInput.run(input)).toEqual(input);
    const nextStepsResponse = response([
      { type: 'text', text: '<nextsteps>\n1. Run the next task with [VIBE]\n</nextsteps>' },
    ]);
    expect(await pipelines.response.run(nextStepsResponse)).toEqual(nextStepsResponse);
    expect(ctx.meta).not.toHaveProperty(VIBE_PROTOCOL_META_KEY);
  });

  it('ignores tool_use and empty text, and handles rejection', async () => {
    const pipelines = createDefaultPipelines();
    installVibeProtocol(pipelines);
    const ctx = { meta: {} as Record<string, unknown> };
    const original = '[VIBE] do something';

    await pipelines.userInput.run({
      text: original,
      content: [{ type: 'text', text: original }],
      ctx: ctx as never,
    });

    // tool_use should pass through without auditing
    const toolResp = response([{ type: 'tool_use', id: 't1', name: 'read', input: {} }]);
    expect(await pipelines.response.run(toolResp)).toEqual(toolResp);

    // empty text should pass through without auditing
    const emptyResp = response([{ type: 'text', text: '   ' }]);
    expect(await pipelines.response.run(emptyResp)).toEqual(emptyResp);

    // non-empty response that violates scope
    // We add an excluded item to the active spec so it fails
    const activeSpec = (ctx.meta[VIBE_PROTOCOL_META_KEY] as { synthesizer: { scopeBoundaries: { excluded: string[] } } }).synthesizer;
    activeSpec.scopeBoundaries.excluded.push('forbidden-lib');

    const rejectResp = await pipelines.response.run(
      response([{ type: 'text', text: 'using forbidden-lib now' }]),
    );
    expect(ctx.meta[VIBE_PROTOCOL_META_KEY]).toMatchObject({
      isVibeMode: true,
      stage: 'auditor',
      audit: { verdict: 'REJECT' },
    });
    const text = rejectResp.content.map((c) => ('text' in c ? c.text : '')).join('');
    expect(text).toContain('❌ REJECT');
  });
});
