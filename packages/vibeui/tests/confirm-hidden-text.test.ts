import type { ProtocolEnvelope } from '@wrongstack/webui-protocol';
import { describe, expect, it } from 'vitest';
import { initialState, reduceFrame } from '../src/lib/session';

/**
 * The approval dialog shows `confirm.input` as the tool arguments. JSON
 * escaping leaves bidi overrides (which reorder the visible command) and Tag
 * characters (invisible text) raw, so they are dropped before display.
 */
const HIDDEN = /[\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/u;

function confirmInput(input: unknown): string {
  const frame = {
    type: 'tool.confirm_needed',
    payload: { sessionId: 'one', id: 'c1', toolName: 'bash', input },
  } as unknown as ProtocolEnvelope;
  return reduceFrame(initialState() as never, frame).confirm?.input ?? '';
}

describe('approval arguments', () => {
  it('drop bidi overrides and invisible text', () => {
    const tag = String.fromCodePoint(0xe0041);
    const text = confirmInput({ command: `cat notes‮txt.hs${tag}`, [`k​y`]: 'v' });
    expect(text).toContain('cat notestxt.hs');
    expect(text).not.toMatch(HIDDEN);
  });

  it('keep ordinary text and the JSON shape', () => {
    const text = confirmInput({ command: 'echo café 日本', args: ['-n'] });
    expect(JSON.parse(text)).toEqual({ command: 'echo café 日本', args: ['-n'] });
  });
});
