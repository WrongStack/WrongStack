import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { statusProjectHashFromWatchFilename } from '@wrongstack/webui-server';

describe('setup-events status watcher filename filtering', () => {
  const projectsDir = path.join('C:', 'Users', 'dev', '.wrongstack', 'projects');

  it('extracts the project hash from relative status.json paths', () => {
    expect(
      statusProjectHashFromWatchFilename(projectsDir, path.join('abc123', 'status.json')),
    ).toBe('abc123');
    expect(statusProjectHashFromWatchFilename(projectsDir, 'abc123\\status.json')).toBe('abc123');
  });

  it('extracts the project hash from absolute status.json paths', () => {
    const file = path.join(projectsDir, 'def456', 'status.json');
    expect(statusProjectHashFromWatchFilename(projectsDir, file)).toBe('def456');
  });

  it('ignores non-status files and similarly named files', () => {
    expect(
      statusProjectHashFromWatchFilename(projectsDir, path.join('abc123', 'session.jsonl')),
    ).toBeNull();
    expect(
      statusProjectHashFromWatchFilename(projectsDir, path.join('abc123', 'my-status.json')),
    ).toBeNull();
    expect(statusProjectHashFromWatchFilename(projectsDir, 'status.json')).toBeNull();
  });
});
