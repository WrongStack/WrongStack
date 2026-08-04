/**
 * Tests for src/lib/file-icons.ts — file icon and color by extension/name.
 * Pure functions with no external dependencies.
 */

import { describe, expect, it } from 'vitest';
import { fileIconColor, fileIcon } from '../../src/lib/file-icons';
import * as Lucide from 'lucide-react';

describe('fileIconColor', () => {
  describe('directories', () => {
    it('returns primary for .git', () => {
      expect(fileIconColor('.git', true)).toContain('primary');
    });

    it('returns destructive for node_modules', () => {
      expect(fileIconColor('node_modules', true)).toContain('destructive');
    });

    it('returns warning for src', () => {
      expect(fileIconColor('src', true)).toContain('warning');
    });

    it('returns warning for lib', () => {
      expect(fileIconColor('lib', true)).toContain('warning');
    });

    it('returns warning for packages', () => {
      expect(fileIconColor('packages', true)).toContain('warning');
    });

    it('returns success for tests', () => {
      expect(fileIconColor('tests', true)).toContain('success');
    });

    it('returns success for __tests__', () => {
      expect(fileIconColor('__tests__', true)).toContain('success');
    });

    it('returns muted for dist', () => {
      expect(fileIconColor('dist', true)).toContain('muted');
    });

    it('returns warning for an unknown directory', () => {
      expect(fileIconColor('random_dir', true)).toContain('warning');
    });
  });

  describe('file extensions', () => {
    it('returns info for .ts and .tsx', () => {
      expect(fileIconColor('file.ts', false)).toContain('info');
      expect(fileIconColor('file.tsx', false)).toContain('info');
    });

    it('returns info for .js and .jsx', () => {
      expect(fileIconColor('file.js', false)).toContain('info');
      expect(fileIconColor('file.jsx', false)).toContain('info');
    });

    it('returns info for .mjs and .cjs', () => {
      expect(fileIconColor('file.mjs', false)).toContain('info');
      expect(fileIconColor('file.cjs', false)).toContain('info');
    });

    it('returns warning for .json and .lock', () => {
      expect(fileIconColor('package.json', false)).toContain('warning');
      expect(fileIconColor('pnpm.lock', false)).toContain('warning');
    });

    it('returns accent-foreground for .css and .scss', () => {
      expect(fileIconColor('style.css', false)).toContain('accent-foreground');
      expect(fileIconColor('style.scss', false)).toContain('accent-foreground');
    });

    it('returns destructive for .html and .xml', () => {
      expect(fileIconColor('index.html', false)).toContain('destructive');
      expect(fileIconColor('data.xml', false)).toContain('destructive');
    });

    it('returns primary for .md and .mdx', () => {
      expect(fileIconColor('readme.md', false)).toContain('primary');
      expect(fileIconColor('doc.mdx', false)).toContain('primary');
    });

    it('returns success for .yml, .yaml, .toml, .env', () => {
      expect(fileIconColor('config.yml', false)).toContain('success');
      expect(fileIconColor('config.yaml', false)).toContain('success');
      expect(fileIconColor('config.toml', false)).toContain('success');
      expect(fileIconColor('.env', false)).toContain('success');
    });

    it('returns brand-orange for shell scripts', () => {
      expect(fileIconColor('script.sh', false)).toContain('brand-orange');
      expect(fileIconColor('script.bash', false)).toContain('brand-orange');
      expect(fileIconColor('script.ps1', false)).toContain('brand-orange');
    });

    it('returns info for Python files', () => {
      expect(fileIconColor('main.py', false)).toContain('info');
      expect(fileIconColor('types.pyi', false)).toContain('info');
    });

    it('returns brand-orange for Rust', () => {
      expect(fileIconColor('main.rs', false)).toContain('brand-orange');
    });

    it('returns info for Go', () => {
      expect(fileIconColor('main.go', false)).toContain('info');
    });

    it('returns destructive for Ruby', () => {
      expect(fileIconColor('main.rb', false)).toContain('destructive');
    });

    it('returns muted for C/C++', () => {
      expect(fileIconColor('main.c', false)).toContain('muted');
      expect(fileIconColor('main.hpp', false)).toContain('muted');
    });

    it('returns primary for images', () => {
      expect(fileIconColor('image.png', false)).toContain('primary');
      expect(fileIconColor('image.jpg', false)).toContain('primary');
      expect(fileIconColor('image.gif', false)).toContain('primary');
    });

    it('returns muted for config files', () => {
      expect(fileIconColor('.gitignore', false)).toContain('muted');
      expect(fileIconColor('.editorconfig', false)).toContain('muted');
    });

    it('returns default muted for unknown extension', () => {
      expect(fileIconColor('file.xyz', false)).toBe('text-muted-foreground');
    });

    it('handles files without extension', () => {
      expect(fileIconColor('Makefile', false)).toBe('text-muted-foreground');
    });
  });
});

describe('fileIcon', () => {
  it('returns FileCode icon for .ts', () => {
    const Icon = fileIcon('file.ts');
    expect(Icon).toBe(Lucide.FileCode);
  });

  it('returns FileCode icon for .py', () => {
    const Icon = fileIcon('file.py');
    expect(Icon).toBe(Lucide.FileCode);
  });

  it('returns FileJson icon for .json', () => {
    const Icon = fileIcon('file.json');
    expect(Icon).toBe(Lucide.FileJson);
  });

  it('returns FileLock icon for .lock', () => {
    const Icon = fileIcon('package-lock.json.lock');
    expect(Icon).toBe(Lucide.FileLock);
  });

  it('returns FileImage icon for .png', () => {
    const Icon = fileIcon('image.png');
    expect(Icon).toBe(Lucide.FileImage);
  });

  it('returns FileType icon for .html', () => {
    const Icon = fileIcon('index.html');
    expect(Icon).toBe(Lucide.FileType);
  });

  it('returns FileCog for .toml', () => {
    const Icon = fileIcon('config.toml');
    expect(Icon).toBe(Lucide.FileCog);
  });

  it('returns default File icon for unknown extension', () => {
    const Icon = fileIcon('file.xyz');
    expect(Icon).toBe(Lucide.File);
  });

  it('returns default File icon for file without extension', () => {
    const Icon = fileIcon('Makefile');
    expect(Icon).toBe(Lucide.File);
  });
});
