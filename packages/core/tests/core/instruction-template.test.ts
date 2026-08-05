import { describe, expect, it } from 'vitest';
import {
  type InstructionTemplateContext,
  renderInstructionLayer,
} from '../../src/core/instruction-template.js';

function ctx(
  tools: readonly string[],
  overrides: Partial<InstructionTemplateContext> = {},
): InstructionTemplateContext {
  return {
    toolNames: new Set(tools),
    tier: 'off',
    subagent: false,
    ...overrides,
  };
}

describe('renderInstructionLayer — block conditionals', () => {
  it('keeps a block whose tool is registered and drops one whose tool is not', () => {
    const text = [
      'intro',
      '',
      '<!--ws:if tool=kanban-->',
      'KANBAN DOCTRINE',
      '<!--ws:end-->',
      '',
      '<!--ws:if tool=telegram_send-->',
      'TELEGRAM DOCTRINE',
      '<!--ws:end-->',
      '',
      'outro',
    ].join('\n');

    const out = renderInstructionLayer(text, ctx(['kanban']));
    expect(out).toContain('KANBAN DOCTRINE');
    expect(out).not.toContain('TELEGRAM DOCTRINE');
    expect(out).toContain('intro');
    expect(out).toContain('outro');
    expect(out).not.toContain('ws:if');
  });

  it('treats comma-separated tool values as OR', () => {
    const text = '<!--ws:if tool=mail_send,mailbox,mail_inbox-->MAIL<!--ws:end-->';
    expect(renderInstructionLayer(text, ctx(['mailbox']))).toContain('MAIL');
    expect(renderInstructionLayer(text, ctx(['read']))).not.toContain('MAIL');
  });

  it('ANDs multiple attributes on one directive', () => {
    const text = '<!--ws:if tool=kanban tier=off-->FULL<!--ws:end-->';
    expect(renderInstructionLayer(text, ctx(['kanban'], { tier: 'off' }))).toContain('FULL');
    expect(renderInstructionLayer(text, ctx(['kanban'], { tier: 'minimal' }))).not.toContain(
      'FULL',
    );
    expect(renderInstructionLayer(text, ctx([], { tier: 'off' }))).not.toContain('FULL');
  });

  it('negates with a leading bang', () => {
    const text = '<!--ws:if !tool=codebase-search-->GREP FALLBACK<!--ws:end-->';
    expect(renderInstructionLayer(text, ctx(['grep']))).toContain('GREP FALLBACK');
    expect(renderInstructionLayer(text, ctx(['codebase-search']))).not.toContain(
      'GREP FALLBACK',
    );
  });

  it('gates on role', () => {
    const text = '<!--ws:if role=leader-->LEADER ONLY<!--ws:end-->';
    expect(renderInstructionLayer(text, ctx([], { subagent: false }))).toContain('LEADER ONLY');
    expect(renderInstructionLayer(text, ctx([], { subagent: true }))).not.toContain(
      'LEADER ONLY',
    );
  });

  it('renders the else branch when the condition fails', () => {
    const text = ['<!--ws:if tool=kanban-->', 'BOARD', '<!--ws:else-->', 'TODO', '<!--ws:end-->'].join(
      '\n',
    );
    expect(renderInstructionLayer(text, ctx(['kanban'])).trim()).toBe('BOARD');
    expect(renderInstructionLayer(text, ctx([])).trim()).toBe('TODO');
  });

  it('supports nested blocks', () => {
    const text = [
      '<!--ws:if tool=delegate-->',
      'OUTER',
      '<!--ws:if tool=quality_gate-->',
      'INNER',
      '<!--ws:end-->',
      '<!--ws:end-->',
    ].join('\n');

    const both = renderInstructionLayer(text, ctx(['delegate', 'quality_gate']));
    expect(both).toContain('OUTER');
    expect(both).toContain('INNER');

    const outerOnly = renderInstructionLayer(text, ctx(['delegate']));
    expect(outerOnly).toContain('OUTER');
    expect(outerOnly).not.toContain('INNER');

    expect(renderInstructionLayer(text, ctx(['quality_gate']))).not.toContain('OUTER');
  });

  it('tolerates whitespace inside the marker', () => {
    const text = '<!-- ws:if tool=git -->GIT<!-- ws:end -->';
    expect(renderInstructionLayer(text, ctx(['git']))).toContain('GIT');
    expect(renderInstructionLayer(text, ctx([]))).not.toContain('GIT');
  });

  it('collapses the blank lines a dropped block leaves behind', () => {
    const text = ['A', '', '<!--ws:if tool=nope-->', 'GONE', '<!--ws:end-->', '', 'B'].join('\n');
    expect(renderInstructionLayer(text, ctx([]))).toBe('A\n\nB');
  });
});

describe('renderInstructionLayer — fail-open contract', () => {
  it('treats an unknown attribute as true rather than dropping content', () => {
    const text = '<!--ws:if platform=win32-->CONTENT<!--ws:end-->';
    expect(renderInstructionLayer(text, ctx([]))).toContain('CONTENT');
  });

  it('treats a malformed condition as true', () => {
    const text = '<!--ws:if tool=-->CONTENT<!--ws:end-->';
    expect(renderInstructionLayer(text, ctx([]))).toContain('CONTENT');
  });

  it('keeps every branch of an unclosed block', () => {
    const text = ['<!--ws:if tool=nope-->', 'THEN', '<!--ws:else-->', 'ELSE'].join('\n');
    const out = renderInstructionLayer(text, ctx([]));
    expect(out).toContain('THEN');
    expect(out).toContain('ELSE');
    expect(out).not.toContain('ws:if');
  });

  it('drops a stray end marker without eating text', () => {
    const text = 'BEFORE\n<!--ws:end-->\nAFTER';
    const out = renderInstructionLayer(text, ctx([]));
    expect(out).toBe('BEFORE\nAFTER');
  });

  it('keeps the full text and strips every marker when no context is given', () => {
    const text = ['<!--ws:if tool=kanban-->', 'BOARD', '<!--ws:else-->', 'TODO', '<!--ws:end-->'].join(
      '\n',
    );
    const out = renderInstructionLayer(text);
    expect(out.trim()).toBe('BOARD');
    expect(out).not.toContain('ws:');
  });

  it('leaves text without markers byte-identical', () => {
    const text = '# Heading\n\nSome  text with  spaces.\n\n\n\nAnd a gap.\n';
    expect(renderInstructionLayer(text, ctx([]))).toBe(text);
  });
});

describe('renderInstructionLayer — placeholders', () => {
  it('filters a tool inventory list to the registered names', () => {
    const text = '{{tools:read,edit,write,patch,replace}}';
    expect(renderInstructionLayer(text, ctx(['read', 'write']))).toBe('`read`, `write`');
  });

  it('renders an empty string when no listed tool is registered', () => {
    expect(renderInstructionLayer('{{tools:browser_open,browser_click}}', ctx([]))).toBe('');
  });

  it('renders every listed name when no context is given', () => {
    expect(renderInstructionLayer('{{tools:read,edit}}')).toBe('`read`, `edit`');
  });

  it('substitutes plain vars and leaves unknown ones verbatim', () => {
    const out = renderInstructionLayer('{{roleList}} and {{missing}}', ctx([], {
      vars: { roleList: 'reviewer, tester' },
    }));
    expect(out).toBe('reviewer, tester and {{missing}}');
  });
});
