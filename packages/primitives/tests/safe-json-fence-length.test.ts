import { describe, expect, it } from 'vitest';
import { stripCodeFences } from '../src/safe-json.js';

const body = '{"ok":true}';

describe('Markdown fence delimiter length', () => {
  it.each([3, 4, 5])('unwraps a whole payload fenced with %i backticks', (length) => {
    const fence = '`'.repeat(length);
    expect(stripCodeFences(`${fence}json\n${body}\n${fence}`)).toBe(body);
  });

  it.each([3, 4, 5])('unwraps an embedded payload fenced with %i backticks', (length) => {
    const fence = '`'.repeat(length);
    expect(stripCodeFences(`Result:\n${fence}json\n${body}\n${fence}\nDone.`)).toBe(body);
  });

  it('supports longer fences with Windows line endings', () => {
    expect(stripCodeFences(`\`\`\`\`json\r\n${body}\r\n\`\`\`\``)).toBe(body);
  });

  it('keeps the existing whole-payload single-line extension for longer fences', () => {
    expect(stripCodeFences(`\`\`\`\`json ${body} \`\`\`\``)).toBe(body);
  });

  it('keeps the existing embedded single-line extension for longer fences', () => {
    expect(stripCodeFences(`Result: \`\`\`\`json ${body} \`\`\`\` Done.`)).toBe(body);
  });

  it('unwraps a truncated longer fence without requiring a closer', () => {
    expect(stripCodeFences(`\`\`\`\`json\n${body}`)).toBe(body);
  });

  it('accepts a closing fence longer than its opening fence', () => {
    expect(stripCodeFences(`\`\`\`json\n${body}\n\`\`\`\``)).toBe(body);
  });

  it('does not treat shorter backtick runs inside a payload as its closer', () => {
    const inner = 'before\n```\nafter';
    expect(stripCodeFences('````text\n' + inner + '\n````')).toBe(inner);
  });

  it('does not end an embedded longer fence at a shorter run inside its payload', () => {
    const inner = 'before\n```\nafter';
    expect(stripCodeFences('Result:\n````text\n' + inner + '\n````\nDone.')).toBe(inner);
  });

  it('requires a complete matching-length fence when embedded in prose', () => {
    expect(stripCodeFences('Result:\n````json\n' + body + '\n```\nDone.')).toBeNull();
  });

  it('does not unwrap a two-backtick inline span', () => {
    expect(stripCodeFences('``json ' + body + '``')).toBeNull();
  });
});
