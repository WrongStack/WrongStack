import { expect, it } from 'vitest';
import { renderMarkdownTables, strWidth } from '../src/markdown-table.js';

const header = '| Name | Flag |';
const separator = '|------|---------|';

it.each([14, 15])('preserves a header-only table between paragraphs at width %i', (width) => {
  const output = renderMarkdownTables(
    ['Before', '', header, separator, '', 'After'].join('\n'),
    width,
  );
  const table = output.split('\n').slice(2, -2);
  expect(table.join('\n')).toContain('Name');
  expect(table.join('\n')).toContain('Flag');
  expect(table.every((line) => strWidth(line) <= width)).toBe(true);
  expect(output.startsWith('Before\n\n')).toBe(true);
  expect(output.endsWith('\n\nAfter')).toBe(true);
});

it('still renders populated narrow tables as key/value rows', () => {
  const output = renderMarkdownTables([header, separator, '| Ada | Done |'].join('\n'), 14);
  expect(output).toBe('Name: Ada\nFlag: Done');
});
