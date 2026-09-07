import { describe, expect, it } from 'vitest';
import { buildTranscriptMarkdown } from '../src/lib/transcript-export.js';
import type { ChatMessage } from '../src/types.js';

/**
 * Behavior coverage for the transcript export builder: markdown shape,
 * role labels, ordering, the thinking-block leak guard, and timestamp
 * rendering. Locale-dependent time text is asserted by pattern, never by
 * exact string.
 */

function msg(
  partial: Partial<ChatMessage> & { role: ChatMessage['role']; text: string },
): ChatMessage {
  return { id: 'm1', ts: '2026-09-07T10:30:00.000Z', ...partial } as ChatMessage;
}

describe('buildTranscriptMarkdown', () => {
  it('renders a titled header and role-labelled turns in order', () => {
    const md = buildTranscriptMarkdown(
      [
        msg({ role: 'user', text: 'Fix the flaky test' }),
        msg({ role: 'assistant', text: 'On it — running the suite now.' }),
      ],
      { title: 'WrongStack' },
    );
    expect(md).toContain('# WrongStack transcript');
    expect(md).toContain('_WrongStack — exported ');
    expect(md.indexOf('**YOU**')).toBeLessThan(md.indexOf('**WRONGSTACK**'));
    expect(md).toContain('Fix the flaky test');
    expect(md).toContain('On it — running the suite now.');
  });

  it('always skips thinking blocks — reasoning must not leak into a share', () => {
    const md = buildTranscriptMarkdown([
      msg({ role: 'thinking', text: 'SECRET REASONING' }),
      msg({ role: 'assistant', text: 'Public answer' }),
    ]);
    expect(md).not.toContain('SECRET REASONING');
    expect(md).toContain('Public answer');
  });

  it('renders whitespace-only messages as an (empty) placeholder', () => {
    const md = buildTranscriptMarkdown([msg({ role: 'user', text: '   ' })]);
    expect(md).toContain('_(empty)_');
  });

  it('includes a (HH:MM) timestamp when ts is present and none when absent', () => {
    const withTime = buildTranscriptMarkdown([msg({ role: 'user', text: 'hello' })]);
    expect(withTime).toMatch(/\*\*YOU\*\* \(\d{1,2}:\d{2}\)/);
    const withoutTime = buildTranscriptMarkdown([
      msg({ role: 'user', text: 'hello', ts: undefined }),
    ]);
    expect(withoutTime).toMatch(/\*\*YOU\*\*\n/);
    expect(withoutTime).not.toMatch(/\(\d{1,2}:\d{2}\)/);
  });

  it('labels system messages and ends the document with a newline', () => {
    const md = buildTranscriptMarkdown([msg({ role: 'system', text: 'session started' })]);
    expect(md).toContain('**SYSTEM**');
    expect(md.endsWith('\n')).toBe(true);
  });
});
