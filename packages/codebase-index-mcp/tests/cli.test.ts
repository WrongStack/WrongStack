import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli.js';

describe('Codebase Index MCP CLI arguments', () => {
  it('defaults to read-only stdio', () => {
    expect(parseArgs(['--project-root', '.'])).toMatchObject({
      transport: 'stdio',
      writable: false,
      httpHost: '127.0.0.1',
      httpPort: 0,
    });
  });

  it('parses HTTP, authentication, index directory, and writable options', () => {
    expect(
      parseArgs([
        '--project-root',
        '.',
        '--index-dir',
        '.index-test',
        '--http',
        '--host',
        '0.0.0.0',
        '--port',
        '8767',
        '--token',
        'secret',
        '--writable',
      ]),
    ).toMatchObject({
      transport: 'http',
      httpHost: '0.0.0.0',
      httpPort: 8767,
      httpToken: 'secret',
      writable: true,
    });
  });
});
