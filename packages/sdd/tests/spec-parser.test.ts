import { describe, expect, it } from 'vitest';
import { SpecParser } from '../src/spec-parser.js';

function makeSpec(
  overrides: Partial<import('@wrongstack/contracts/types/spec').Specification> = {},
): import('@wrongstack/contracts/types/spec').Specification {
  return {
    id: 'test-id',
    title: 'Test Spec',
    version: '1.0.0',
    status: 'draft',
    overview: 'Test overview',
    sections: [],
    requirements: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeReq(
  overrides: Partial<import('@wrongstack/contracts/types/spec').SpecRequirement> = {},
): import('@wrongstack/contracts/types/spec').SpecRequirement {
  return {
    id: 'REQ-1',
    type: 'functional',
    priority: 'medium',
    description: 'Test requirement',
    acceptanceCriteria: [],
    ...overrides,
  };
}

describe('SpecParser', () => {
  describe('parse', () => {
    it('extracts title from markdown heading', () => {
      const parser = new SpecParser();
      const spec = parser.parse('# My Specification\n\nSome content here.');
      expect(spec.title).toBe('My Specification');
    });

    it('falls back to "Untitled Specification" when no heading', () => {
      const parser = new SpecParser();
      const spec = parser.parse('No heading here');
      expect(spec.title).toBe('Untitled Specification');
    });

    it('extracts version from version line', () => {
      const parser = new SpecParser();
      const spec = parser.parse('# Title\nVersion: 2.3.4\n\n## Overview\nContent');
      expect(spec.version).toBe('2.3.4');
    });

    it('falls back to 0.0.1 when no version found', () => {
      const parser = new SpecParser();
      const spec = parser.parse('# Title\nNo version line');
      expect(spec.version).toBe('0.0.1');
    });

    it('extracts overview content between ## Overview and next heading', () => {
      const parser = new SpecParser();
      const spec = parser.parse(`# Title

## Overview

This is the overview text.
It spans multiple lines.

## Requirements

Some requirements`);
      expect(spec.overview).toBe('This is the overview text.\nIt spans multiple lines.');
    });

    it('uses "No overview provided" when no overview section', () => {
      const parser = new SpecParser();
      const spec = parser.parse('# Title\n\n## Requirements\nContent');
      expect(spec.overview).toBe('No overview provided');
    });

    it('extracts h2 sections with correct type mapping', () => {
      const parser = new SpecParser();
      const spec = parser.parse(`# Title

## Architecture

Architecture content here.

## API Endpoints

API content here.

## Security

Security content here.`);
      expect(spec.sections).toHaveLength(3);
      expect(spec.sections[0].type).toBe('architecture');
      expect(spec.sections[1].type).toBe('api');
      expect(spec.sections[2].type).toBe('security');
    });

    it('maps unknown section titles to overview type', () => {
      const parser = new SpecParser();
      const spec = parser.parse('# Title\n\n## Miscellaneous\nSome content.');
      expect(spec.sections[0].type).toBe('overview');
    });

    it('extracts requirements with type from tags', () => {
      const parser = new SpecParser();
      const spec = parser.parse(`# Title

## Requirements

[functional] Must do something
[security] Must be secure
[performance] Must be fast`);
      expect(spec.requirements).toHaveLength(3);
      expect(spec.requirements[0].type).toBe('functional');
      expect(spec.requirements[1].type).toBe('security');
      expect(spec.requirements[2].type).toBe('performance');
    });

    it('extracts requirements with priority from tags', () => {
      const parser = new SpecParser();
      const spec = parser.parse(`# Title

## Requirements

[critical] Critical thing
[high] High thing
[low] Low thing
[prio:high] Also high`);
      expect(spec.requirements[0].priority).toBe('critical');
      expect(spec.requirements[1].priority).toBe('high');
      expect(spec.requirements[2].priority).toBe('low');
      expect(spec.requirements[3].priority).toBe('critical');
    });

    it('skips empty lines and comment lines in requirements', () => {
      const parser = new SpecParser();
      const spec = parser.parse(`# Title

## Requirements

Some requirement

# A comment

Another requirement`);
      expect(spec.requirements).toHaveLength(2);
    });

    it('skips HTML comment lines in requirements', () => {
      const parser = new SpecParser();
      const spec = parser.parse(`# Title

## Requirements

<!-- TODO: clarify the refresh-token rules -->

[functional] Users can log in`);

      expect(spec.requirements.map((r) => r.description)).toEqual(['Users can log in']);
    });

    it('skips the HTML comment placeholder the spec template emits', () => {
      // `templateToMarkdown` writes `_<!-- <type> section content -->_` as the
      // body of every generated section (packages/sdd/src/spec-templates.ts:182).
      const parser = new SpecParser();
      const spec = parser.parse(`# Title

## Requirements

_<!-- requirements section content -->_

[functional] Users can log in`);

      expect(spec.requirements.map((r) => r.description)).toEqual(['Users can log in']);
    });

    it('skips a multi-line HTML comment in requirements', () => {
      const parser = new SpecParser();
      const spec = parser.parse(`# Title

## Requirements

<!--
TODO: clarify the refresh-token rules
-->

[functional] Users can log in`);

      expect(spec.requirements.map((r) => r.description)).toEqual(['Users can log in']);
    });

    it('keeps the requirement text of a line that also carries an HTML comment', () => {
      const parser = new SpecParser();
      const spec = parser.parse(`# Title

## Requirements

[functional] Users can log in <!-- TODO: rename the field -->`);

      expect(spec.requirements.map((r) => r.description)).toEqual(['Users can log in']);
    });

    it('generates sequential IDs for requirements', () => {
      const parser = new SpecParser();
      const spec = parser.parse(`# Title

## Requirements

Req 1
Req 2
Req 3`);
      expect(spec.requirements).toHaveLength(3);
      // IDs should be sequential and start with REQ- prefix
      expect(spec.requirements.every((r) => r.id.startsWith('REQ-'))).toBe(true);
      // Extract numbers and verify they increase
      const nums = spec.requirements.map((r) => Number.parseInt(r.id.split('-')[1], 10));
      expect(nums[1] > nums[0]).toBe(true);
      expect(nums[2] > nums[1]).toBe(true);
    });

    it('removes all tag brackets from requirement description', () => {
      const parser = new SpecParser();
      const spec = parser.parse(
        '# Title\n\n## Requirements\n\n[functional][critical] Do something amazing',
      );
      expect(spec.requirements[0].description).toBe('Do something amazing');
    });

    it('sets status to draft', () => {
      const parser = new SpecParser();
      const spec = parser.parse('# Title\n\n## Overview\nContent');
      expect(spec.status).toBe('draft');
    });

    it('generates UUID for spec id', () => {
      const parser = new SpecParser();
      const spec = parser.parse('# Title\n\n## Overview\nContent');
      expect(spec.id).toBeTruthy();
      expect(spec.id.length).toBeGreaterThan(10);
    });
  });

  describe('analyze', () => {
    it('detects missing overview section', () => {
      const parser = new SpecParser();
      const spec = makeSpec({
        sections: [{ type: 'requirements', title: 'Requirements', level: 2, content: '' }],
      });
      const analysis = parser.analyze(spec);
      expect(analysis.gaps).toContain('Missing Overview section');
    });

    it('detects missing requirements section', () => {
      const parser = new SpecParser();
      const spec = makeSpec({
        sections: [{ type: 'overview', title: 'Overview', level: 2, content: '' }],
      });
      const analysis = parser.analyze(spec);
      expect(analysis.gaps).toContain('Missing Requirements section');
    });

    it('detects missing acceptance section', () => {
      const parser = new SpecParser();
      const spec = makeSpec({
        sections: [
          { type: 'overview', title: 'Overview', level: 2, content: '' },
          { type: 'requirements', title: 'Requirements', level: 2, content: '' },
        ],
      });
      const analysis = parser.analyze(spec);
      expect(analysis.gaps).toContain('Missing Acceptance Criteria section');
    });

    it('detects no requirements defined', () => {
      const parser = new SpecParser();
      const spec = makeSpec({
        sections: [
          { type: 'overview', title: 'Overview', level: 2, content: '' },
          { type: 'requirements', title: 'Requirements', level: 2, content: '' },
        ],
        requirements: [],
      });
      const analysis = parser.analyze(spec);
      expect(analysis.gaps).toContain('No requirements defined');
    });

    it('detects requirements without acceptance criteria', () => {
      const parser = new SpecParser();
      const spec = makeSpec({
        sections: [
          { type: 'overview', title: 'Overview', level: 2, content: '' },
          { type: 'requirements', title: 'Requirements', level: 2, content: '' },
          { type: 'acceptance', title: 'Acceptance', level: 2, content: '' },
        ],
        requirements: [
          makeReq({ id: 'REQ-1', acceptanceCriteria: [] }),
          makeReq({ id: 'REQ-2', acceptanceCriteria: ['crit1'] }),
        ],
      });
      const analysis = parser.analyze(spec);
      expect(analysis.gaps).toContain('1 requirements without acceptance criteria');
    });

    it('detects critical blocked requirements as risks', () => {
      const parser = new SpecParser();
      const spec = makeSpec({
        sections: [
          { type: 'overview', title: 'Overview', level: 2, content: '' },
          { type: 'requirements', title: 'Requirements', level: 2, content: '' },
          { type: 'acceptance', title: 'Acceptance', level: 2, content: '' },
        ],
        requirements: [
          makeReq({ id: 'REQ-1', priority: 'critical', blockedBy: ['REQ-999'] }),
          makeReq({ id: 'REQ-2', priority: 'medium' }),
        ],
      });
      const analysis = parser.analyze(spec);
      expect(analysis.risks).toHaveLength(1);
      expect(analysis.risks[0].requirement).toBe('REQ-1');
      expect(analysis.risks[0].severity).toBe('high');
    });

    it('calculates completeness score correctly', () => {
      const parser = new SpecParser();
      const spec = makeSpec({
        sections: [
          { type: 'overview', title: 'Overview', level: 2, content: '' },
          { type: 'requirements', title: 'Requirements', level: 2, content: '' },
          { type: 'acceptance', title: 'Acceptance', level: 2, content: '' },
        ],
        requirements: [makeReq({ acceptanceCriteria: ['ac1'] })],
      });
      const analysis = parser.analyze(spec);
      // 5 criteria met: overview + requirements + acceptance + has requirements + 4+ sections
      expect(analysis.completeness).toBe(80); // 4/5 * 100
    });

    it('reports suggestions when requirements missing', () => {
      const parser = new SpecParser();
      const spec = makeSpec({ sections: [], requirements: [] });
      const analysis = parser.analyze(spec);
      expect(analysis.suggestions.length).toBeGreaterThan(0);
    });
  });

  describe('validate', () => {
    it('returns valid=true when spec is valid', () => {
      const parser = new SpecParser();
      const spec = makeSpec({
        title: 'Valid Title',
        version: '1.0.0',
        requirements: [makeReq({ description: 'Has content', acceptanceCriteria: ['ac1'] })],
      });
      const result = parser.validate(spec);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('returns error when title is empty', () => {
      const parser = new SpecParser();
      const spec = makeSpec({ title: '   ' });
      const result = parser.validate(spec);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.path === 'title')).toBe(true);
    });

    it('returns error when version is empty', () => {
      const parser = new SpecParser();
      const spec = makeSpec({ title: 'Title', version: '  ' });
      const result = parser.validate(spec);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.path === 'version')).toBe(true);
    });

    it('returns error when requirement description is empty', () => {
      const parser = new SpecParser();
      const spec = makeSpec({
        title: 'Title',
        version: '1.0.0',
        requirements: [makeReq({ description: '   ' })],
      });
      const result = parser.validate(spec);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.path.includes('requirement'))).toBe(true);
    });

    it('warns when requirement has no acceptance criteria', () => {
      const parser = new SpecParser();
      const spec = makeSpec({
        title: 'Title',
        version: '1.0.0',
        requirements: [makeReq({ description: 'Some req', acceptanceCriteria: [] })],
      });
      const result = parser.validate(spec);
      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.path.includes('requirement'))).toBe(true);
    });

    it('returns error when blockedBy references non-existent requirement', () => {
      const parser = new SpecParser();
      const spec = makeSpec({
        title: 'Title',
        version: '1.0.0',
        requirements: [
          makeReq({ id: 'REQ-1', blockedBy: ['NONEXISTENT'] }),
          makeReq({ id: 'REQ-2' }),
        ],
      });
      const result = parser.validate(spec);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('NONEXISTENT'))).toBe(true);
    });

    it('returns valid when blockedBy references existing requirement', () => {
      const parser = new SpecParser();
      const spec = makeSpec({
        title: 'Title',
        version: '1.0.0',
        requirements: [makeReq({ id: 'REQ-1', blockedBy: ['REQ-2'] }), makeReq({ id: 'REQ-2' })],
      });
      const result = parser.validate(spec);
      expect(result.valid).toBe(true);
    });
  });

  describe('constructor', () => {
    it('accepts empty constructor', () => {
      const parser = new SpecParser();
      expect(parser).toBeDefined();
    });

    it('accepts strict option', () => {
      const parser = new SpecParser({ strict: true });
      expect(parser).toBeDefined();
    });
  });

  describe('fenced code and line endings', () => {
    const spec = [
      '# Payments',
      '',
      '## Overview',
      'Card payments.',
      '',
      '## Requirements',
      '- [functional] [high] Charge a saved card',
      '```ts',
      'const charge = await stripe.charges.create({ amount });',
      '## not a heading',
      '```',
      '- [security] Never log the card number',
      '',
      '## Acceptance Criteria',
      'Charges succeed.',
      '',
    ].join('\n');
    const requirements = (text: string) =>
      new SpecParser()
        .parse(text)
        .requirements.map((r) => ({ type: r.type, priority: r.priority, text: r.description }));

    it('does not parse fenced code inside Requirements as requirements', () => {
      expect(requirements(spec)).toEqual([
        { type: 'functional', priority: 'high', text: '-   Charge a saved card' },
        { type: 'security', priority: 'medium', text: '-  Never log the card number' },
      ]);
    });

    it.each([
      ['CRLF', '\r\n'],
      ['bare CR', '\r'],
    ])('reads a %s spec exactly like the LF one', (_label, eol) => {
      const converted = spec.replaceAll('\n', eol);
      expect(requirements(converted)).toEqual(requirements(spec));
      const parsed = new SpecParser().parse(converted);
      expect(parsed.title).toBe('Payments');
      expect(parsed.overview).toBe('Card payments.');
      expect(parsed.sections.map((s) => s.title)).toEqual([
        'Overview',
        'Requirements',
        'Acceptance Criteria',
      ]);
      for (const section of parsed.sections) expect(section.content).not.toContain('\r');
    });

    it('ignores a heading inside a fenced code block when reading the title', () => {
      const parser = new SpecParser();
      const parsed = parser.parse(
        [
          '```bash',
          '# Install dependencies',
          'npm install',
          '```',
          '',
          '# Real Title',
          '',
          '## Overview',
          'Some overview.',
        ].join('\n'),
      );
      expect(parsed.title).toBe('Real Title');
    });

    it('ignores a Version line inside a fenced code block when reading the version', () => {
      const parser = new SpecParser();
      const parsed = parser.parse(
        ['```txt', 'Version: 9.9.9', '```', '', '# Real Title', '', 'Version: 2.0.0'].join('\n'),
      );
      expect(parsed.version).toBe('2.0.0');
    });

    it('still reads the title and version from outside a fenced code block', () => {
      const parser = new SpecParser();
      const parsed = parser.parse(
        [
          '# Real Title',
          '',
          'Version: 2.0.0',
          '',
          '## Overview',
          '```ts',
          '# install step',
          '```',
        ].join('\n'),
      );
      expect(parsed.title).toBe('Real Title');
      expect(parsed.version).toBe('2.0.0');
    });
  });
});
