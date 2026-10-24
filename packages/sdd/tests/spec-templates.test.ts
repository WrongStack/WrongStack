import { describe, expect, it } from 'vitest';
import {
  getTemplate,
  listTemplates,
  SPEC_TEMPLATES,
  templateToMarkdown,
} from '../src/spec-templates.js';

describe('Spec Templates', () => {
  it('has at least 5 templates', () => {
    expect(SPEC_TEMPLATES.length).toBeGreaterThanOrEqual(5);
  });

  it('each template has required fields', () => {
    for (const t of SPEC_TEMPLATES) {
      expect(t.id).toBeTruthy();
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.sections.length).toBeGreaterThan(0);
    }
  });

  it('getTemplate returns template by id', () => {
    const t = getTemplate('feature');
    expect(t).toBeDefined();
    expect(t!.name).toBe('New Feature');
  });

  it('getTemplate returns undefined for unknown id', () => {
    const t = getTemplate('nonexistent');
    expect(t).toBeUndefined();
  });

  it('listTemplates returns all templates', () => {
    const list = listTemplates();
    expect(list.length).toBe(SPEC_TEMPLATES.length);
    expect(list.every((t) => t.id && t.name && t.description)).toBe(true);
  });

  it('templateToMarkdown generates valid markdown', () => {
    const template = getTemplate('feature')!;
    const md = templateToMarkdown(template, 'My Feature');
    expect(md).toContain('# My Feature');
    expect(md).toContain('## Overview');
    expect(md).toContain('## Requirements');
    expect(md).toContain('## Acceptance Criteria');
  });

  it('templateToMarkdown uses default title', () => {
    const template = getTemplate('feature')!;
    const md = templateToMarkdown(template);
    expect(md).toContain('# Untitled Specification');
  });
});
