import { describe, expect, it } from 'vitest';
import { type FileNode, fileRowName } from '../src/file-model';

const t = (key: string, values: Record<string, string>) =>
  key === 'fileView.folder'
    ? 'Folder'
    : key === 'fileView.plainText'
      ? 'Plain text'
      : `${key === 'fileView.selectPath' ? 'Select' : 'Open'} ${values['path']}`;
const node = (path: string, type: 'file' | 'directory', size?: number) =>
  ({
    path,
    name: path.split('/').at(-1),
    type,
    children: [],
    ...(size === undefined ? {} : { size }),
  }) as unknown as FileNode;

describe('file manager row names', () => {
  it('starts with the action and path, then says every column the row shows', () => {
    expect(fileRowName(t, node('bulk-ops/a.txt', 'file', 2), false, false)).toBe(
      'Open bulk-ops/a.txt Plain text 2 B',
    );
    expect(fileRowName(t, node('packages', 'directory'), true, false)).toBe(
      'Select packages Folder —',
    );
  });

  it('adds the folder a search result was found in, as the row shows it', () => {
    expect(fileRowName(t, node('src/app/main.ts', 'file', 2048), false, true)).toBe(
      'Open src/app/main.ts src/app TypeScript 2.0 KB',
    );
  });
});
