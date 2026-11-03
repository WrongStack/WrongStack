import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { surfaceI18n } from '../src/surface-i18n';

const root = resolve(import.meta.dirname, '../../..');
const surfaces = join(root, 'packages/project-surfaces/src');
const webuiEnglish = join(root, 'packages/webui/src/i18n/locales/en');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The WebUI namespaces the shared surfaces name in their translation keys (`ns:key`). */
function namespacesInUse(): string[] {
  const found = new Set<string>();
  const key = /(?:\bt\(\s*|Key:\s*|i18nKey=)['"`]([a-z][a-zA-Z]*):[\w.]/g;
  for (const file of sources(surfaces))
    for (const match of readFileSync(file, 'utf8').matchAll(key))
      if (existsSync(join(webuiEnglish, `${match[1]}.json`))) found.add(match[1]!);
  return [...found].sort();
}

describe('surface translations in the desktop', () => {
  it('loads every WebUI namespace the shared surfaces translate with, English bundled', () => {
    const used = namespacesInUse();
    expect(used).toContain('activity');
    const loaded = [surfaceI18n.options.ns ?? []].flat();
    for (const namespace of used) {
      expect(loaded).toContain(namespace);
      expect(surfaceI18n.hasResourceBundle('en', namespace)).toBe(true);
    }
  });

  it('renders the setup screen strings instead of their keys', () => {
    expect(surfaceI18n.t('setup:screen.start.startSession')).toBe('Start Session');
  });
});
