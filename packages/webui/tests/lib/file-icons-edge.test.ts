/**
 * Edge-case tests for src/lib/file-icons.ts — dotfile with no extension,
 * empty name, and branch coverage for lines 101 and 154.
 */
import { describe, expect, it } from 'vitest';
import { fileIconColor, fileIcon } from '../../src/lib/file-icons';
import * as Lucide from 'lucide-react';

describe('fileIconColor — branch coverage (line 101)', () => {
  it('handles dotfiles that look extensionless (pop returns undefined branch)', () => {
    // A file named ".gitignore" has split('.') → ["", "gitignore"] → pop() → "gitignore"
    // This matches the config file regex for "gitignore" → returns muted
    expect(fileIconColor('.gitignore', false)).toContain('muted');
  });

  it('handles file starting with a dot but having an extension', () => {
    // ".env" → split('.') → ["", "env"] → pop() → "env"
    // This hits the semantic success token for env extensions.
    expect(fileIconColor('.env', false)).toContain('success');
  });

  it('handles file with just a dot and no name part', () => {
    // "." → split('.') → ["", ""] → pop() → "" → ?? '' → ''
    // Returns default muted
    expect(fileIconColor('.', false)).toBe('text-muted-foreground');
  });

  it('handles empty name string', () => {
    // "" → split('.') → [""] → pop() → "" → ?? '' → ''
    expect(fileIconColor('', false)).toBe('text-muted-foreground');
  });
});

describe('fileIcon — branch coverage (line 154)', () => {
  it('uses fallback File icon for dot-only name', () => {
    // "." → split('.') → ["", ""] → pop() → "" → ?? '' → ''
    const Icon = fileIcon('.');
    expect(Icon).toBe(Lucide.File);
  });

  it('uses fallback File icon for empty name', () => {
    const Icon = fileIcon('');
    expect(Icon).toBe(Lucide.File);
  });

  it('returns FileCode for ts extension', () => {
    const Icon = fileIcon('file.ts');
    expect(Icon).toBe(Lucide.FileCode);
  });

  it('returns FileImage for svg extension', () => {
    const Icon = fileIcon('image.svg');
    expect(Icon).toBe(Lucide.FileImage);
  });

  it('returns FileCog for gitignore extension', () => {
    // ".gitignore" → split('.') → ["", "gitignore"] → pop() → "gitignore"
    // EXT_ICONS["gitignore"] → FileCog
    const Icon = fileIcon('.gitignore');
    expect(Icon).toBe(Lucide.FileCog);
  });
});
