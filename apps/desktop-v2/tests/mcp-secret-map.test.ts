import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { McpSecretMapEditor } from '../src/McpSecretMapEditor';
import {
  MCP_SECRET_MASK,
  secretMapChanged,
  secretMapPayload,
  secretMapRows,
} from '../src/mcp-secret-map';

it('keeps hidden values by sending the mask, replaces, removes and adds by key', () => {
  const rows = secretMapRows({
    GITHUB_TOKEN: MCP_SECRET_MASK,
    NODE_ENV: 'production',
    OLD_KEY: MCP_SECRET_MASK,
  });
  expect(secretMapChanged(rows, [])).toBe(false);
  rows[1] = { ...rows[1]!, action: 'replace', value: 'development' };
  rows[2] = { ...rows[2]!, action: 'remove' };
  expect(secretMapChanged(rows, [])).toBe(true);
  expect(secretMapPayload('env', rows, [{ key: 'API_URL', value: 'https://x' }])).toEqual({
    GITHUB_TOKEN: MCP_SECRET_MASK,
    NODE_ENV: 'development',
    API_URL: 'https://x',
  });
});

it('refuses invalid names, duplicates, empty, reserved and multi-line values', () => {
  const rows = secretMapRows({ Authorization: MCP_SECRET_MASK });
  expect(() => secretMapPayload('headers', rows, [{ key: 'authorization', value: 'x' }])).toThrow(
    'appears twice',
  );
  expect(() => secretMapPayload('headers', rows, [{ key: 'Bad Header', value: 'x' }])).toThrow(
    'not a valid header name',
  );
  expect(() => secretMapPayload('env', [], [{ key: '1ABC', value: 'x' }])).toThrow(
    'not a valid environment variable name',
  );
  expect(() => secretMapPayload('headers', [], [{ key: 'X-A', value: '' }])).toThrow(
    'Enter a value',
  );
  expect(() => secretMapPayload('headers', [], [{ key: 'X-A', value: MCP_SECRET_MASK }])).toThrow(
    'reserved mask',
  );
  expect(() => secretMapPayload('headers', [], [{ key: 'X-A', value: 'a\r\nB: c' }])).toThrow(
    'line breaks',
  );
  expect(() =>
    secretMapPayload('headers', [{ ...rows[0]!, action: 'replace', value: '' }], []),
  ).toThrow('Enter a value');
});

it('never renders a hidden value', () => {
  const markup = renderToStaticMarkup(
    createElement(McpSecretMapEditor, {
      kind: 'headers',
      name: 'remote',
      map: { Authorization: MCP_SECRET_MASK },
      command: async () => ({}),
      onSaved() {},
    }),
  );
  expect(markup).toContain('Authorization');
  expect(markup).toContain('Hidden value');
  expect(markup).not.toContain(MCP_SECRET_MASK);
});
