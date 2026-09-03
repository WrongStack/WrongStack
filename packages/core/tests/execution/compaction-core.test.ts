import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildLosslessDigest,
  buildSmartDigest,
  collapseAcknowledgedToolReceipts,
  dedupStaleReads,
  eliseAcknowledgedToolResults,
  eliseOldToolResults,
  enforceHardBudget,
  extractText,
  findExchangeStart,
  findPreserveStart,
  findSafeBoundary,
  hasLargeToolResult,
  hasToolUse,
  scoreMessage,
} from '../../src/execution/compaction-core.js';
import type { Message } from '../../src/types/index.js';
import { repairToolUseAdjacency } from '../../src/utils/message-invariants.js';
import { estimateMessageTokens } from '../../src/utils/token-estimate.js';

afterEach(() => vi.restoreAllMocks());

const text = (role: Message['role'], t: string): Message =>
  ({ role, content: [{ type: 'text', text: t }] }) as Message;
const strMsg = (role: Message['role'], t: string): Message => ({ role, content: t }) as Message;
const toolUse = (role: Message['role'] = 'assistant'): Message =>
  ({ role, content: [{ type: 'tool_use', id: 'u1', name: 'bash', input: {} }] }) as Message;
const toolResult = (content: unknown, role: Message['role'] = 'user'): Message =>
  ({ role, content: [{ type: 'tool_result', tool_use_id: 'u1', content }] }) as Message;

describe('extractText / hasToolUse / hasLargeToolResult', () => {
  it('extracts text from string and block content', () => {
    expect(extractText(strMsg('user', 'hello'))).toBe('hello');
    expect(extractText(text('user', 'a'))).toBe('a');
    expect(extractText(toolUse())).toBe(''); // no text blocks
  });

  it('detects tool_use blocks', () => {
    expect(hasToolUse(strMsg('user', 'x'))).toBe(false);
    expect(hasToolUse(toolUse())).toBe(true);
    expect(hasToolUse(text('user', 'x'))).toBe(false);
  });

  it('detects large tool results (string and object content)', () => {
    expect(hasLargeToolResult(strMsg('user', 'x'))).toBe(false);
    expect(hasLargeToolResult(toolResult('a'.repeat(4000)))).toBe(true);
    expect(hasLargeToolResult(toolResult({ data: 'b'.repeat(4000) }))).toBe(true);
    expect(hasLargeToolResult(toolResult('short'))).toBe(false);
  });
});

describe('scoreMessage', () => {
  it('scores pure tool I/O as noise (0)', () => {
    expect(scoreMessage(toolUse())).toBe(0);
    expect(scoreMessage(toolResult(''))).toBe(0);
  });

  it('demotes repeated failures: 3rd-4th → 1, 5th+ → 0', () => {
    const failureCounts = new Map<string, number>();
    const fail = () => scoreMessage(text('user', 'Error: ENOENT happened'), { failureCounts });
    expect(fail()).toBe(5); // 1st (error keyword → critical) but failureCounts increments
    fail(); // 2nd
    expect(fail()).toBe(1); // 3rd
    fail(); // 4th
    expect(fail()).toBe(0); // 5th → noise
  });

  it('marks user corrections / stop signals as critical (5)', () => {
    expect(scoreMessage(text('user', 'no, stop that'))).toBe(5);
    expect(scoreMessage(text('user', 'actually revert that'))).toBe(5);
  });

  it('marks error, security, and architecture content as critical (5)', () => {
    expect(scoreMessage(text('assistant', 'a TypeError was thrown'))).toBe(5);
    expect(scoreMessage(text('assistant', 'found a SQL injection vulnerability'))).toBe(5);
    expect(scoreMessage(text('assistant', 'I will refactor the approach here'))).toBe(5);
  });

  it('marks Turkish corrections / errors / decisions as critical (5)', () => {
    // Corrections / stop signals (user role).
    expect(scoreMessage(text('user', 'hayır bu yanlış olmuş'))).toBe(5);
    expect(scoreMessage(text('user', 'dur, geri al bunu'))).toBe(5);
    expect(scoreMessage(text('user', 'yanlis, vazgec'))).toBe(5); // ascii-folded
    // Error language (any role).
    expect(scoreMessage(text('assistant', 'testler başarısız oldu'))).toBe(5);
    expect(scoreMessage(text('user', 'burada bir hata var'))).toBe(5);
    // Architecture / decision (assistant role).
    expect(scoreMessage(text('assistant', 'mimari kararı şöyle veriyorum'))).toBe(5);
    expect(scoreMessage(text('assistant', 'bu tasarim yaklasimini secelim'))).toBe(5);
  });

  it('marks large tool results and grep/list output as low (1)', () => {
    // A large tool result with accompanying text (a bare result with no text is noise).
    const bigWithText: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'here is the output' },
        { type: 'tool_result', tool_use_id: 'u1', content: 'z'.repeat(4000) },
      ],
    } as Message;
    expect(scoreMessage(bigWithText)).toBe(1);
    expect(scoreMessage(text('user', 'found 12 match in the tree'))).toBe(1);
  });

  it('defaults to medium (3) for normal exchanges', () => {
    expect(scoreMessage(text('user', 'please add a button'))).toBe(3);
    expect(scoreMessage(text('assistant', 'Sure, here is the plan for it'))).toBe(3);
  });
});

describe('buildSmartDigest', () => {
  it('applies tiered treatment and collapses noise', () => {
    const longMedium =
      'First sentence here. Second sentence that should be dropped from the digest entirely.';
    const messages: Message[] = [
      text('user', 'no, stop'), // 5 → verbatim
      text('assistant', longMedium), // 3 → first sentence
      text('user', 'found 7 match in the tree'), // 1 → one-line summary
      toolUse(), // 0 → noise collapsed
      toolUse(), // 0 → noise collapsed
    ];
    const digest = buildSmartDigest(messages);
    expect(digest).toContain('[user]: no, stop');
    expect(digest).toContain('First sentence here.');
    expect(digest).not.toContain('Second sentence');
    expect(digest).toContain('found 7 match');
    expect(digest).toContain('low-importance turn(s) collapsed');
  });

  it('truncates a long single-line low-priority result to one line', () => {
    const longGrep = `found 5 match: ${'a'.repeat(140)}`; // grep → score 1, >100 chars
    const digest = buildSmartDigest([text('user', longGrep)]);
    expect(digest).toContain('…'); // truncated
    expect(digest).toContain('found 5 match');
  });

  it('renders a tool-call marker and handles short text without a sentence break', () => {
    const m: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'quick note' },
        { type: 'tool_use', id: 'u1', name: 'bash', input: {} },
      ],
    } as Message;
    const digest = buildSmartDigest([m]);
    expect(digest).toContain('[1 tool call(s)]');
    expect(digest).toContain('quick note');
  });
});

describe('buildSmartDigest empty / countToolBlocks edge', () => {
  it('skips a message whose display and tool count are both empty', () => {
    // empty string content → score 3, firstSentence('')='' , 0 tool blocks → skipped
    const digest = buildSmartDigest([strMsg('user', ''), text('user', 'real content here')]);
    expect(digest).toContain('real content here');
    expect(digest).not.toContain('[user]: \n'); // the empty one produced no line
  });
});

describe('eliseOldToolResults', () => {
  const big = (n: number): Message =>
    ({
      role: 'user',
      content: [
        { type: 'text', text: 'output below' },
        { type: 'tool_result', tool_use_id: 'u1', content: 'z'.repeat(n) },
      ],
    }) as Message;

  it('elides oversized tool results before the preserved window, keeping text blocks', () => {
    const messages: Message[] = [
      big(8000),
      text('user', 'recent 1'),
      text('assistant', 'recent 2'),
      text('user', 'recent 3'),
    ];
    const res = eliseOldToolResults(messages, { preserveK: 2, eliseThreshold: 100 });
    expect(res.changed).toBe(true);
    expect(res.saved).toBeGreaterThan(0);
    const elided = res.messages[0];
    const blocks = Array.isArray(elided?.content) ? elided.content : [];
    expect(blocks.find((b) => b.type === 'text')).toBeDefined(); // text block preserved (passthrough)
    expect(JSON.stringify(blocks)).toContain('elided');
  });

  it('keeps semantic hints in elided tool result markers', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'u1',
            name: 'grep',
            content: `packages/core/src/execution/compactor.ts:12:boom\nError: failed to parse\n${'z'.repeat(8000)}`,
            is_error: true,
          },
        ],
      } as Message,
      text('user', 'recent'),
    ];

    const res = eliseOldToolResults(messages, { preserveK: 1, eliseThreshold: 100 });

    expect(res.changed).toBe(true);
    expect(JSON.stringify(res.messages[0])).toContain('tool=grep');
    expect(JSON.stringify(res.messages[0])).toContain('packages/core/src/execution/compactor.ts');
    expect(JSON.stringify(res.messages[0])).toContain('Error: failed to parse');
  });

  it('elides oversized old tool_use inputs without breaking the pair id', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'write-1',
            name: 'write',
            input: {
              path: 'src/generated.ts',
              content: 'export const value = 1;\n'.repeat(1200),
              nested: { a: 1, b: 2 },
            },
          },
        ],
      } as Message,
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'write-1', content: 'write: ok' }],
      } as Message,
      text('user', 'recent'),
    ];

    const res = eliseOldToolResults(messages, { preserveK: 1, eliseThreshold: 100 });

    expect(res.changed).toBe(true);
    expect(res.saved).toBeGreaterThan(0);
    const first = res.messages[0];
    const block = Array.isArray(first?.content) ? first.content[0] : undefined;
    expect(block).toMatchObject({ type: 'tool_use', id: 'write-1', name: 'write' });
    expect(JSON.stringify(block)).toContain('__elided_tool_input');
    expect(JSON.stringify(block)).toContain('src/generated.ts');
    expect(JSON.stringify(block)).not.toContain(
      'export const value = 1;\\nexport const value = 1;',
    );
  });

  it('does not elide recent oversized tool_use inputs inside the preserved window', () => {
    const input = { content: 'x'.repeat(8000) };
    const messages: Message[] = [
      text('user', 'old'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'recent-use', name: 'write', input }],
      } as Message,
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'recent-use', content: 'ok' }],
      } as Message,
    ];

    const res = eliseOldToolResults(messages, { preserveK: 2, eliseThreshold: 100 });

    expect(res.changed).toBe(false);
    expect(JSON.stringify(res.messages)).toContain('x'.repeat(100));
  });

  it('returns unchanged when nothing is oversized', () => {
    const messages: Message[] = [big(10), text('user', 'a'), text('user', 'b')];
    const res = eliseOldToolResults(messages, { preserveK: 1, eliseThreshold: 100000 });
    expect(res.changed).toBe(false);
    expect(res.saved).toBe(0);
  });

  it('logs a regression warning under WRONGSTACK_DEBUG when the inner ratio is high', () => {
    const prev = process.env.WRONGSTACK_DEBUG;
    process.env.WRONGSTACK_DEBUG = '1';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // 15 tool_result blocks on one message → fullPassInner/fullPass ratio > 10
      const blocks = Array.from({ length: 15 }, (_, i) => ({
        type: 'tool_result' as const,
        tool_use_id: `u${i}`,
        content: i === 0 ? 'z'.repeat(8000) : 'small',
      }));
      const messages: Message[] = [
        { role: 'user', content: blocks } as Message,
        text('user', 'recent'),
      ];
      eliseOldToolResults(messages, { preserveK: 1, eliseThreshold: 100 });
      expect(err).toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.WRONGSTACK_DEBUG;
      else process.env.WRONGSTACK_DEBUG = prev;
    }
  });
});

describe('eliseAcknowledgedToolResults', () => {
  const pair = (
    id: string,
    result: string,
    input: Record<string, unknown> = {},
    name = 'exec',
  ): Message[] => [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input }],
    } as Message,
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, name, content: result }],
    } as Message,
  ];

  it('never elides the trailing tool batch before a provider response acknowledges it', () => {
    const messages = pair('pending', 'x'.repeat(8_000), { path: 'src/pending.ts' });

    const result = eliseAcknowledgedToolResults(messages, { maxRetainedTokens: 100 });

    expect(result.changed).toBe(false);
    expect(result.messages).toBe(messages);
    expect(JSON.stringify(result.messages)).toContain('x'.repeat(100));
  });

  it('keeps the newest acknowledged raw pairs within budget and receipts older pairs', () => {
    const messages: Message[] = [
      ...pair('old', 'old payload '.repeat(500), {
        path: 'src/old.ts',
        content: 'a'.repeat(2_000),
      }),
      { role: 'assistant', content: [{ type: 'text', text: 'old result consumed' }] } as Message,
      ...pair('new', 'new payload', { path: 'src/new.ts' }),
      { role: 'assistant', content: [{ type: 'text', text: 'new result consumed' }] } as Message,
    ];

    const result = eliseAcknowledgedToolResults(messages, { maxRetainedTokens: 100 });

    expect(result.changed).toBe(true);
    expect(result.elidedResults).toBe(1);
    expect(result.saved).toBeGreaterThan(0);
    expect(JSON.stringify(result.messages)).toContain('src/old.ts');
    expect(JSON.stringify(result.messages)).toContain('__elided_tool_input');
    expect(JSON.stringify(result.messages)).not.toContain('old payload '.repeat(100));
    expect(JSON.stringify(result.messages)).toContain('new payload');
  });

  it('is idempotent and preserves tool ids, names, errors, and provider metadata', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'failed-read',
            name: 'read',
            input: { path: 'src/failure.ts' },
            providerMeta: { 'google.thoughtSignature': 'signed' },
          },
        ],
      } as Message,
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'failed-read',
            name: 'read',
            content: `src/failure.ts\nError: denied\n${'z'.repeat(8_000)}`,
            is_error: true,
          },
        ],
      } as Message,
      { role: 'assistant', content: [{ type: 'text', text: 'I saw the failure' }] } as Message,
    ];

    const first = eliseAcknowledgedToolResults(messages, { maxRetainedTokens: 50 });
    const second = eliseAcknowledgedToolResults(first.messages, { maxRetainedTokens: 50 });

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(first.messages[0]).toMatchObject({
      content: [
        {
          type: 'tool_use',
          id: 'failed-read',
          name: 'read',
          providerMeta: { 'google.thoughtSignature': 'signed' },
        },
      ],
    });
    expect(first.messages[1]).toMatchObject({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'failed-read',
          name: 'read',
          is_error: true,
        },
      ],
    });
    expect(JSON.stringify(first.messages[1])).toContain('Error: denied');
  });

  it('also bounds a raw tool input whose paired result was already elided', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'write-1',
            name: 'write',
            input: { path: 'src/large.ts', content: 'x'.repeat(8_000) },
          },
        ],
      } as Message,
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'write-1',
            name: 'write',
            content: '[elided: ~2000 tokens; tool=write; files=src/large.ts]',
          },
        ],
      } as Message,
      { role: 'assistant', content: [{ type: 'text', text: 'write consumed' }] } as Message,
    ];

    const result = eliseAcknowledgedToolResults(messages, { maxRetainedTokens: 50 });

    expect(result.changed).toBe(true);
    expect(result.elidedResults).toBe(0);
    expect(JSON.stringify(result.messages[0])).toContain('__elided_tool_input');
    expect(JSON.stringify(result.messages[0])).not.toContain('x'.repeat(200));
  });

  it('keeps bounded semantic head and tail evidence in an elided result receipt', () => {
    const messages: Message[] = [
      ...pair(
        'evidence',
        `IMPORTANT_HEAD finding=alpha\n${'middle-noise '.repeat(1_000)}\nIMPORTANT_TAIL total=42`,
        { path: 'src/evidence.ts' },
      ),
      { role: 'assistant', content: [{ type: 'text', text: 'evidence consumed' }] } as Message,
    ];

    const result = eliseAcknowledgedToolResults(messages, { maxRetainedTokens: 50 });
    const wire = JSON.stringify(result.messages);

    expect(result.changed).toBe(true);
    expect(wire).toContain('IMPORTANT_HEAD finding=alpha');
    expect(wire).toContain('IMPORTANT_TAIL total=42');
    expect(wire).not.toContain('middle-noise '.repeat(100));
    expect(wire.length).toBeLessThan(2_000);
  });

  it('keeps acknowledged active file reads verbatim even above the raw-I/O budget', () => {
    const fullRead = `ACTIVE_FILE\n${'source line\n'.repeat(1_000)}`;
    const messages: Message[] = [
      ...pair('read-active', fullRead, { file_path: '.\\src\\active.ts' }, 'read_file'),
      { role: 'assistant', content: [{ type: 'text', text: 'read consumed' }] } as Message,
    ];

    const result = eliseAcknowledgedToolResults(messages, { maxRetainedTokens: 1 });

    expect(result.changed).toBe(false);
    expect(result.messages[1]?.content).toEqual([expect.objectContaining({ content: fullRead })]);
    expect(result.retainedTokens).toBeGreaterThan(1);
  });

  it('removes an old read after a successful edit of the same normalized path', () => {
    const oldRead = `OLD_SOURCE\n${'stale line\n'.repeat(1_000)}`;
    const messages: Message[] = [
      ...pair('read-old', oldRead, { path: 'src/file.ts' }, 'read'),
      { role: 'assistant', content: [{ type: 'text', text: 'read consumed' }] } as Message,
      ...pair('edit-ok', 'updated', { path: 'D:\\repo\\src\\file.ts' }, 'edit'),
      { role: 'assistant', content: [{ type: 'text', text: 'edit consumed' }] } as Message,
    ];

    const result = eliseAcknowledgedToolResults(messages, { maxRetainedTokens: 10_000 });
    const wire = JSON.stringify(result.messages);

    expect(result.changed).toBe(true);
    expect(wire).not.toContain('OLD_SOURCE');
    expect(wire).toContain('__stale_read');
    expect(wire).toContain('invalidated by a later successful mutation');
    expect(
      eliseAcknowledgedToolResults(result.messages, { maxRetainedTokens: 10_000 }).changed,
    ).toBe(false);
  });

  it('invalidates the old read as soon as the successful edit result exists', () => {
    const messages: Message[] = [
      ...pair('read-old', 'OLD_PENDING_SOURCE', { path: 'src/pending.ts' }, 'read'),
      { role: 'assistant', content: [{ type: 'text', text: 'read consumed' }] } as Message,
      ...pair('edit-pending', 'updated', { path: 'src/pending.ts' }, 'edit'),
    ];

    const result = eliseAcknowledgedToolResults(messages, { maxRetainedTokens: 10_000 });
    const wire = JSON.stringify(result.messages);

    expect(wire).not.toContain('OLD_PENDING_SOURCE');
    expect(wire).toContain('"content":"updated"');
  });

  it('keeps the read after a failed edit or an edit of another file', () => {
    const read = `TRUSTED_SOURCE\n${'still current\n'.repeat(300)}`;
    const messages: Message[] = [
      ...pair('read-current', read, { path: 'src/current.ts' }, 'read'),
      { role: 'assistant', content: [{ type: 'text', text: 'read consumed' }] } as Message,
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'edit-failed', name: 'edit', input: { path: 'src/current.ts' } },
        ],
      } as Message,
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'edit-failed',
            name: 'edit',
            content: 'denied',
            is_error: true,
          },
        ],
      } as Message,
      { role: 'assistant', content: [{ type: 'text', text: 'failure consumed' }] } as Message,
      ...pair('edit-other', 'updated', { path: 'src/other.ts' }, 'write'),
      { role: 'assistant', content: [{ type: 'text', text: 'other write consumed' }] } as Message,
    ];

    const result = eliseAcknowledgedToolResults(messages, { maxRetainedTokens: 1 });

    expect(result.messages[1]?.content).toEqual([expect.objectContaining({ content: read })]);
  });

  it('keeps a re-read after edit while removing only the pre-edit content', () => {
    const messages: Message[] = [
      ...pair('read-before', 'BEFORE_EDIT', { path: 'src/a.ts' }, 'read'),
      { role: 'assistant', content: [{ type: 'text', text: 'before consumed' }] } as Message,
      ...pair('edit', 'updated', { path: 'src/a.ts' }, 'edit'),
      { role: 'assistant', content: [{ type: 'text', text: 'edit consumed' }] } as Message,
      ...pair('read-after', `AFTER_EDIT\n${'fresh\n'.repeat(500)}`, { path: 'src/a.ts' }, 'read'),
      { role: 'assistant', content: [{ type: 'text', text: 'after consumed' }] } as Message,
    ];

    const result = eliseAcknowledgedToolResults(messages, { maxRetainedTokens: 1 });
    const wire = JSON.stringify(result.messages);

    expect(wire).not.toContain('BEFORE_EDIT');
    expect(wire).toContain('AFTER_EDIT');
    expect(wire).toContain('fresh\\n');
  });
});

describe('collapseAcknowledgedToolReceipts', () => {
  function acknowledgedCycles(count: number): Message[] {
    const messages: Message[] = [];
    for (let i = 0; i < count; i++) {
      messages.push({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: `private reasoning ${i}`, signature: `sig-${i}` },
          {
            type: 'tool_use',
            id: `use-${i}`,
            name: i % 2 === 0 ? 'exec' : 'grep',
            input: { path: `src/file-${i}.ts` },
          },
        ],
      } as Message);
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: `use-${i}`,
            name: i % 2 === 0 ? 'exec' : 'grep',
            content: `[elided: ~500 tokens; files=src/file-${i}.ts]`,
          },
        ],
      } as Message);
    }
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: `acknowledged ${count - 1}` }],
    } as Message);
    return messages;
  }

  it('bounds completed protocol pairs and folds older receipts into one digest', () => {
    const messages = acknowledgedCycles(10);

    const first = collapseAcknowledgedToolReceipts(messages, { maxPairs: 4 });
    const second = collapseAcknowledgedToolReceipts(first.messages, { maxPairs: 4 });

    expect(first.changed).toBe(true);
    expect(first.collapsedPairs).toBe(6);
    expect(first.saved).toBeGreaterThan(0);
    expect(second.changed).toBe(false);
    const wire = JSON.stringify(first.messages);
    expect(wire).toContain('[tool_history_digest: 6 older acknowledged exchange(s) omitted');
    expect(wire).toContain('src/file-0.ts');
    expect(wire).not.toContain('private reasoning 0');
    expect(wire).toContain('private reasoning 9');
    expect(first.messages).toHaveLength(10); // digest + 4 pairs + final assistant
    expect(
      first.messages.flatMap((message) =>
        typeof message.content === 'string'
          ? []
          : message.content.filter((block) => block.type === 'tool_result'),
      ),
    ).toHaveLength(4);
    expect(repairToolUseAdjacency(first.messages).report).toEqual({
      changed: false,
      removedToolUses: [],
      removedToolResults: [],
      removedMessages: 0,
    });
  });

  it('keeps completed protocol shells bounded across a long tool-only run', () => {
    const result = collapseAcknowledgedToolReceipts(acknowledgedCycles(250), { maxPairs: 16 });

    expect(result.collapsedPairs).toBe(234);
    expect(result.messages).toHaveLength(34); // digest + 16 pairs + final assistant
    expect(JSON.stringify(result.messages[0])).toContain(
      '[tool_history_digest: 234 older acknowledged exchange(s) omitted',
    );
    expect(repairToolUseAdjacency(result.messages).report.changed).toBe(false);
    expect(collapseAcknowledgedToolReceipts(result.messages, { maxPairs: 16 }).changed).toBe(false);
  });

  it('keeps a trailing unacknowledged result in addition to the receipt cap', () => {
    const messages = acknowledgedCycles(5);
    messages.pop(); // the pending tool-use response acknowledges the fifth result
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'pending', name: 'read', input: { path: 'pending.ts' } }],
    } as Message);
    messages.push({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'pending', name: 'read', content: 'pending raw' },
      ],
    } as Message);

    const result = collapseAcknowledgedToolReceipts(messages, { maxPairs: 2 });
    const wire = JSON.stringify(result.messages);

    expect(result.collapsedPairs).toBe(3);
    expect(wire).toContain('pending raw');
    expect(wire).toContain('"id":"pending"');
    expect(repairToolUseAdjacency(result.messages).report.changed).toBe(false);
  });

  it('does not collapse active file reads merely to satisfy the receipt-count cap', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 3; i++) {
      messages.push(
        ...[
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: `active-${i}`, name: 'read', input: { path: `src/${i}.ts` } },
            ],
          } as Message,
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: `active-${i}`,
                name: 'read',
                content: `FULL_${i}`,
              },
            ],
          } as Message,
        ],
      );
    }
    messages.push({ role: 'assistant', content: [{ type: 'text', text: 'consumed' }] } as Message);

    const result = collapseAcknowledgedToolReceipts(messages, { maxPairs: 1 });

    expect(result.changed).toBe(false);
    expect(JSON.stringify(result.messages)).toContain('FULL_0');
    expect(JSON.stringify(result.messages)).toContain('FULL_2');
  });

  it('treats non-finite pair limits as zero instead of disabling the bound', () => {
    const result = collapseAcknowledgedToolReceipts(acknowledgedCycles(2), {
      maxPairs: Number.NaN,
    });

    expect(result.collapsedPairs).toBe(2);
    expect(repairToolUseAdjacency(result.messages).report.changed).toBe(false);
  });

  it('preserves user-visible assistant text while removing completed thinking and tool protocol', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private chain', signature: 'sig' },
          { type: 'text', text: 'I will inspect the file.' },
          { type: 'tool_use', id: 'old', name: 'exec', input: { path: 'src/a.ts' } },
        ],
      } as Message,
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'old', name: 'exec', content: 'src/a.ts' }],
      } as Message,
      { role: 'assistant', content: [{ type: 'text', text: 'Inspection complete.' }] } as Message,
    ];

    const result = collapseAcknowledgedToolReceipts(messages, { maxPairs: 0 });
    const wire = JSON.stringify(result.messages);

    expect(wire).toContain('I will inspect the file.');
    expect(wire).toContain('Inspection complete.');
    expect(wire).not.toContain('private chain');
    expect(wire).not.toContain('tool_use');
    expect(wire).not.toContain('tool_result');
  });
});

describe('buildLosslessDigest', () => {
  it('keeps text verbatim, marks tool-only messages, and skips empty ones', () => {
    const messages: Message[] = [
      text('user', 'keep this text'),
      toolUse('assistant'), // tool-only → omitted marker
      strMsg('assistant', ''), // empty + no tools → skipped
    ];
    const digest = buildLosslessDigest(messages);
    expect(digest).toContain('keep this text');
    expect(digest).toContain('tool call(s) omitted');
    expect(digest.split('\n').length).toBe(2); // only the text + tool-only lines
  });
});

describe('findPreserveStart', () => {
  it('keeps protocol-pair repair constant-bounded on a 5k-message tool history', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 2_500; i++) {
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: `u${i}`, name: 'read', input: { path: `f${i}.ts` } }],
      } as Message);
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `u${i}`, content: 'ok' }],
      } as Message);
    }

    const previousDebug = process.env['WRONGSTACK_DEBUG'];
    process.env['WRONGSTACK_DEBUG'] = '1';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(findPreserveStart(messages, 1)).toBe(4_998);
      const event = log.mock.calls
        .map(([value]) =>
          typeof value === 'string' ? (JSON.parse(value) as Record<string, unknown>) : undefined,
        )
        .find((value) => value?.['event'] === 'compaction.find_preserve_start.ended');
      expect(event).toMatchObject({
        messageCount: 5_000,
        preserveStart: 4_998,
        pairRepairIterations: 2,
        pairRepairInnerIterations: 2,
      });
    } finally {
      if (previousDebug === undefined) delete process.env['WRONGSTACK_DEBUG'];
      else process.env['WRONGSTACK_DEBUG'] = previousDebug;
    }
  });

  it('demonstrates protocol messages consume only the raw-tool retention window', () => {
    const messages: Message[] = [
      { ...text('user', 'human task'), origin: 'user_input' },
      toolUse(),
      toolResult('one'),
      toolUse(),
      toolResult('two'),
      text('assistant', 'working'),
    ];
    // Raw tool retention remains deliberately protocol-sized. Human-turn
    // continuity is carried separately by conversation_continuity evidence.
    expect(findPreserveStart(messages, 2)).toBe(3);
  });

  it('walks back K user/assistant turns', () => {
    const messages: Message[] = [
      text('user', '1'),
      text('assistant', '2'),
      text('user', '3'),
      text('assistant', '4'),
    ];
    expect(findPreserveStart(messages, 2)).toBe(2);
    expect(findPreserveStart(messages, 10)).toBe(0); // more than available
  });

  it('widens backward when the preserved window starts on a tool_result', () => {
    const messages: Message[] = [
      text('user', 'old'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'u1', name: 'read', input: { path: 'a.ts' } }],
      } as Message,
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'ok' }],
      } as Message,
    ];

    expect(findPreserveStart(messages, 1)).toBe(1);
  });
});

describe('findSafeBoundary / findExchangeStart', () => {
  it('finds the exchange start for the nearest user-with-text message', () => {
    const messages: Message[] = [
      text('user', 'first task'),
      toolUse('assistant'),
      text('assistant', 'done thinking'), // assistant, no tool use → boundary after it
      text('user', 'second task'),
      toolUse('assistant'),
    ];
    const b = findSafeBoundary(messages, 0, 4);
    expect(b).toBe(3); // start of the 'second task' exchange (after the no-tool assistant)
  });

  it('returns -1 when no user-with-text message exists in range', () => {
    expect(findSafeBoundary([toolUse(), toolUse()], 0, 1)).toBe(-1);
  });

  it('findExchangeStart stops at a prior user message and falls back to 0', () => {
    const messages: Message[] = [text('user', 'a'), text('user', 'b')];
    expect(findExchangeStart(messages, 1)).toBe(0); // prior user at index 0
    // only tool-use assistants before the user index → walk falls through to 0
    expect(findExchangeStart([toolUse('assistant'), toolUse('assistant')], 1)).toBe(0);
  });
});

// ── enforceHardBudget: the no-overflow guarantee ───────────────────────────

describe('enforceHardBudget', () => {
  const bigText = (role: Message['role'], n: number): Message =>
    ({ role, content: [{ type: 'text', text: 'x'.repeat(n) }] }) as Message;

  it('is a no-op when already within budget', () => {
    const msgs = [text('user', 'hello'), text('assistant', 'hi')];
    const before = estimateMessageTokens(msgs);
    const res = enforceHardBudget(msgs, before + 1000, { preserveK: 5 });
    expect(res.changed).toBe(false);
    expect(res.messages).toBe(msgs); // same reference
    expect(res.withinBudget).toBe(true);
  });

  it('trims a single oversized message to fit the budget', () => {
    // One giant message far larger than the budget — no elision target,
    // preserveK protects it, yet the request MUST end up under budget.
    const msgs = [bigText('user', 200_000)];
    const budget = 2_000;
    const res = enforceHardBudget(msgs, budget, { preserveK: 5 });
    expect(res.changed).toBe(true);
    expect(estimateMessageTokens(res.messages)).toBeLessThanOrEqual(budget);
    expect(res.withinBudget).toBe(true);
  });

  it('elides old tool results before truncating text', () => {
    const msgs: Message[] = [
      toolUse('assistant'),
      toolResult('R'.repeat(40_000)),
      text('user', 'recent turn 1'),
      text('assistant', 'recent turn 2'),
      text('user', 'recent turn 3'),
    ];
    const budget = 1_500;
    const res = enforceHardBudget(msgs, budget, { preserveK: 2 });
    expect(res.changed).toBe(true);
    expect(estimateMessageTokens(res.messages)).toBeLessThanOrEqual(budget);
    // The big tool_result payload is gone (elided marker or dropped).
    const serialized = JSON.stringify(res.messages);
    expect(serialized).not.toContain('R'.repeat(1_000));
  });

  it('keeps tool_use/tool_result adjacency intact after dropping messages', () => {
    // Force Pass 4 (whole-message drops) with a tiny budget, then verify no
    // orphaned protocol blocks survive.
    const msgs: Message[] = [];
    for (let i = 0; i < 8; i++) {
      msgs.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: `u${i}`, name: 'read', input: { path: `f${i}` } }],
      } as Message);
      msgs.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `u${i}`, content: 'y'.repeat(5_000) }],
      } as Message);
    }
    const res = enforceHardBudget(msgs, 500, { preserveK: 1 });
    expect(estimateMessageTokens(res.messages)).toBeLessThanOrEqual(500);
    // Every surviving tool_result must have its tool_use in the prior assistant msg.
    const useIds = new Set<string>();
    for (const m of res.messages) {
      if (typeof m.content === 'string') continue;
      for (const b of m.content) {
        if (b.type === 'tool_use') useIds.add(b.id);
        if (b.type === 'tool_result') expect(useIds.has(b.tool_use_id)).toBe(true);
      }
    }
  });
});

// ── dedupStaleReads: superseded repeated reads ─────────────────────────────

describe('dedupStaleReads', () => {
  const readUse = (id: string, path: string): Message =>
    ({
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'read', input: { path } }],
    }) as Message;
  const readResult = (id: string, content: string): Message =>
    ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }) as Message;

  it('marks the stale (older) read of a repeated file and keeps the newest', () => {
    const msgs: Message[] = [
      readUse('u1', 'src/a.ts'),
      readResult('u1', 'OLD content of a.ts '.repeat(200)),
      text('user', 'turn 1'),
      text('assistant', 'turn 2'),
      text('user', 'turn 3'),
      text('assistant', 'turn 4'),
      readUse('u2', 'src/a.ts'),
      readResult('u2', 'NEW content of a.ts '.repeat(200)),
      text('user', 'turn 5'),
      text('assistant', 'turn 6'),
    ];
    const res = dedupStaleReads(msgs, [{ file: 'src/a.ts', count: 2 }], { preserveK: 2 });
    expect(res.changed).toBe(true);
    expect(res.deduped).toBe(1);
    const serialized = JSON.stringify(res.messages);
    expect(serialized).toContain('stale read of');
    expect(serialized).toContain('NEW content'); // newest kept verbatim
    expect(serialized).not.toContain('OLD content'); // oldest collapsed
  });

  it('deduplicates across read_file and view_file tool variants', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'u1', name: 'read_file', input: { path: 'src/config.ts' } }],
      } as Message,
      readResult('u1', 'OLD config '.repeat(200)),
      text('user', 'turn 1'),
      text('assistant', 'turn 2'),
      text('user', 'turn 3'),
      text('assistant', 'turn 4'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'u2', name: 'view_file', input: { path: 'src/config.ts' } }],
      } as Message,
      readResult('u2', 'NEW config '.repeat(200)),
      text('user', 'turn 5'),
      text('assistant', 'turn 6'),
    ];
    const res = dedupStaleReads(msgs, [{ file: 'src/config.ts', count: 2 }], { preserveK: 2 });
    expect(res.changed).toBe(true);
    expect(res.deduped).toBe(1);
    const serialized = JSON.stringify(res.messages);
    expect(serialized).toContain('stale read of');
    expect(serialized).toContain('NEW config');
    expect(serialized).not.toContain('OLD config');
  });

  it('is a no-op when there is no repeated-read pressure', () => {
    const msgs: Message[] = [readUse('u1', 'src/a.ts'), readResult('u1', 'content'.repeat(100))];
    const res = dedupStaleReads(msgs, [], { preserveK: 2 });
    expect(res.changed).toBe(false);
    expect(res.messages).toBe(msgs);
  });
});
