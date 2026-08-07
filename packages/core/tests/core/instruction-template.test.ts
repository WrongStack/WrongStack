import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RUNTIME_CAPABILITY_MANIFEST } from '../../src/coordination/agents/capability-manifest.js';
import {
  type InstructionTemplateContext,
  renderInstructionLayer,
} from '../../src/core/instruction-template.js';
import {
  isDeprecatedRuntimeToolAlias,
  normalizeRuntimeToolName,
} from '../../src/types/runtime-capability-manifest.js';

function ctx(
  tools: readonly string[],
  overrides: Partial<InstructionTemplateContext> = {},
): InstructionTemplateContext {
  return {
    toolNames: new Set(tools),
    tier: 'off',
    subagent: false,
    strictToolReferences: true,
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
    expect(renderInstructionLayer(text, ctx(['codebase-search']))).not.toContain('GREP FALLBACK');
  });

  it('gates on role', () => {
    const text = '<!--ws:if role=leader-->LEADER ONLY<!--ws:end-->';
    expect(renderInstructionLayer(text, ctx([], { subagent: false }))).toContain('LEADER ONLY');
    expect(renderInstructionLayer(text, ctx([], { subagent: true }))).not.toContain('LEADER ONLY');
  });

  it('renders the else branch when the condition fails', () => {
    const text = [
      '<!--ws:if tool=kanban-->',
      'BOARD',
      '<!--ws:else-->',
      'TODO',
      '<!--ws:end-->',
    ].join('\n');
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
    const text = [
      '<!--ws:if tool=kanban-->',
      'BOARD',
      '<!--ws:else-->',
      'TODO',
      '<!--ws:end-->',
    ].join('\n');
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
    const out = renderInstructionLayer(
      '{{roleList}} and {{missing}}',
      ctx([], {
        vars: { roleList: 'reviewer, tester' },
      }),
    );
    expect(out).toBe('reviewer, tester and {{missing}}');
  });
});

describe('bundled instruction tool-reference integrity', () => {
  it('keeps every bundled instruction free of unknown callable names and deprecated aliases', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const root = path.resolve(here, '..', '..', 'instructions');
    const pending = [root];
    const files: string[] = [];
    while (pending.length > 0) {
      const dir = pending.pop();
      if (!dir) break;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) pending.push(full);
        else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
      }
    }

    const known = new Set<string>(RUNTIME_CAPABILITY_MANIFEST.flatMap((entry) => entry.tools));
    for (const file of files) {
      const raw = await fs.readFile(file, 'utf8');
      const declared = [...raw.matchAll(/!?tool=([a-zA-Z0-9_,.-]+?)(?=\s|--)/g)].flatMap((match) =>
        (match[1] ?? '').split(','),
      );
      const imperative = [
        ...raw.matchAll(/\b(?:call|use|invoke|run)\s+`([a-z][a-z0-9_-]+)`/gi),
      ].map((match) => normalizeRuntimeToolName(match[1] ?? ''));
      expect(
        declared.filter((tool) => !known.has(tool)),
        `${path.relative(root, file)} declares an unknown tool`,
      ).toEqual([]);
      expect(
        imperative.filter((tool) => !known.has(tool)),
        `${path.relative(root, file)} has an ambiguous unknown callable reference`,
      ).toEqual([]);
      const identifiers = [...raw.matchAll(/`([a-z][a-z0-9_-]+)`/gi)].map(
        (match) => match[1] ?? '',
      );
      expect(
        identifiers.filter(isDeprecatedRuntimeToolAlias),
        `${path.relative(root, file)} uses a deprecated tool alias`,
      ).toEqual([]);
    }
  });

  it('does not render a referenced tool name outside the exposed surface', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const instructions = path.resolve(here, '..', '..', 'instructions');
    const exposed = [
      'read',
      'write',
      'edit',
      'codebase-stats',
      'codebase-search',
      'codebase-incoming-calls',
      'codebase-outgoing-calls',
      'codebase-index',
      'bash',
      'grep',
      'glob',
      'diff',
      'patch',
      'json',
      'search',
      'tool_search',
      'tool_use',
      'tool_help',
    ];
    const surfaces = [
      { tools: exposed, tier: 'aggressive' as const },
      { tools: ['read', 'grep', 'glob', 'search'], tier: 'medium' as const },
    ];
    for (const name of ['system.md', 'system-lite.md', 'system-pro.md']) {
      const raw = await fs.readFile(path.join(instructions, name), 'utf8');
      const referenced = new Set<string>(
        RUNTIME_CAPABILITY_MANIFEST.flatMap((entry) => [...entry.tools]),
      );
      const declared = new Set<string>();
      for (const match of raw.matchAll(/!?tool=([a-zA-Z0-9_,.-]+?)(?=\s|--)/g)) {
        for (const tool of (match[1] ?? '').split(',')) referenced.add(tool);
        for (const tool of (match[1] ?? '').split(',')) declared.add(tool);
      }
      for (const match of raw.matchAll(/\{\{tools:([^}]+)}}/g)) {
        for (const tool of (match[1] ?? '').split(',')) referenced.add(tool.trim());
        for (const tool of (match[1] ?? '').split(',')) declared.add(tool.trim());
      }
      const known = new Set<string>(RUNTIME_CAPABILITY_MANIFEST.flatMap((entry) => entry.tools));
      expect(
        [...declared].filter((tool) => !known.has(tool)),
        `${name} declares tools outside the canonical capability catalog`,
      ).toEqual([]);
      const imperativeUnknown = [
        ...new Set(
          [...raw.matchAll(/\b(?:call|use|invoke|run)\s+`([a-z][a-z0-9_-]+)`/gi)]
            .map((match) => match[1] ?? '')
            .filter((tool) => !known.has(tool)),
        ),
      ];
      expect(
        imperativeUnknown,
        `${name} has an imperative reference that is neither a canonical tool nor qualified as an action`,
      ).toEqual([]);
      for (const surface of surfaces) {
        const rendered = renderInstructionLayer(raw, ctx(surface.tools, { tier: surface.tier }));
        const renderedIdentifiers = new Set(
          [...rendered.matchAll(/`([a-zA-Z][a-zA-Z0-9_-]*)`/g)].map((match) => match[1] ?? ''),
        );
        const leaked = [...renderedIdentifiers].filter(
          (tool) => referenced.has(tool) && !surface.tools.includes(tool),
        );
        expect(leaked, `${name}/${surface.tier} rendered hidden tool references`).toEqual([]);
      }
    }
  });
});
