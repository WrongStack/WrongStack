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

describe('VIBE production pipeline integration', () => {
  it('runs Spec-Synthesizer, Coder, and Auditor for a normal case-insensitive [VIBE] prompt', async () => {
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
    expect(prepared.text).toContain('## Coder Contract');
    expect(prepared.text).toContain('Implement core intent: butona basınca sepet artsın');
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

    expect(finalText).toContain('### 🌊 [VIBE Protocol: Spec-Synthesizer]');
    expect(finalText).toContain('### 💻 [Coder Contract]');
    expect(finalText).toContain('### 🛡️ [Auditor Verdict]');
    expect(finalText).toContain('✅ PASS');
    expect(ctx.meta[VIBE_PROTOCOL_META_KEY]).toMatchObject({
      isVibeMode: true,
      stage: 'passed',
      audit: { verdict: 'PASS' },
    });
  });

  it('waits through tool-use responses and audits only the final coder output', async () => {
    const pipelines = createDefaultPipelines();
    installVibeProtocol(pipelines);
    const ctx = { meta: {} as Record<string, unknown> };
    const original = '[VIBE] parser hatasını düzelt';

    await pipelines.userInput.run({
      text: original,
      content: [{ type: 'text', text: original }],
      ctx: ctx as never,
    });

    const intermediate = await pipelines.response.run(
      response([
        { type: 'text', text: 'I will inspect the parser.' },
        { type: 'tool_use', id: 'read-1', name: 'read', input: { path: 'parser.ts' } },
      ]),
    );
    expect(intermediate.content.some((block) => block.type === 'tool_use')).toBe(true);
    expect(
      intermediate.content.some(
        (block) => block.type === 'text' && block.text.includes('Auditor Verdict'),
      ),
    ).toBe(false);
    expect(ctx.meta[VIBE_PROTOCOL_META_KEY]).toMatchObject({ stage: 'coder' });

    const final = await pipelines.response.run(
      response([{ type: 'text', text: 'Fixed the parser error and ran its focused tests.' }]),
    );
    expect(
      final.content.some(
        (block) => block.type === 'text' && block.text.includes('Auditor Verdict'),
      ),
    ).toBe(true);
  });

  it('does not retrigger from an assistant next-steps block that mentions [VIBE]', async () => {
    const pipelines = createDefaultPipelines();
    installVibeProtocol(pipelines);
    const ctx = { meta: {} as Record<string, unknown> };
    const ordinaryPrompt = 'Summarize the completed work';

    await pipelines.userInput.run({
      text: ordinaryPrompt,
      content: [{ type: 'text', text: ordinaryPrompt }],
      ctx: ctx as never,
    });
    const nextStepsResponse = response([
      {
        type: 'text',
        text: '<nextsteps>\n1. Run the next task with [VIBE]\n</nextsteps>',
      },
    ]);

    expect(await pipelines.response.run(nextStepsResponse)).toEqual(nextStepsResponse);
    expect(ctx.meta).not.toHaveProperty(VIBE_PROTOCOL_META_KEY);
  });

  it('leaves ordinary prompts and responses unchanged', async () => {
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
    const ordinary = response([{ type: 'text', text: 'The parser handles two sections.' }]);
    expect(await pipelines.response.run(ordinary)).toEqual(ordinary);
    expect(ctx.meta).not.toHaveProperty(VIBE_PROTOCOL_META_KEY);
  });
});
