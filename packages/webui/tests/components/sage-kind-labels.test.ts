import { readFileSync } from 'node:fs';
import { SAGE_MEMORY_KINDS } from '@wrongstack/core/utils/sage-kinds';
import { describe, expect, it } from 'vitest';

const LANGUAGES = ['en', 'tr', 'de', 'es', 'fr', 'it', 'pt-BR'];
const MATCHED_VIA = [
  'scope_file',
  'scope_symbol',
  'anchor_file',
  'anchor_symbol',
  'anchor_directory',
  'mention',
];

function sageText(lang: string): Record<string, Record<string, string>> {
  // vitest runs with the package as cwd (browser-jsdom rewrites import.meta.url).
  const raw = readFileSync(`src/i18n/locales/${lang}/activity.json`, 'utf8');
  return JSON.parse(raw).sageText;
}

describe('SAGE memory labels in every display language', () => {
  it.each(LANGUAGES)('%s names every memory kind and match reason', (lang) => {
    const text = sageText(lang);
    for (const kind of SAGE_MEMORY_KINDS) expect(text.kind?.[kind], kind).toBeTruthy();
    for (const via of MATCHED_VIA) expect(text.matchedVia?.[via], via).toBeTruthy();
  });
});
