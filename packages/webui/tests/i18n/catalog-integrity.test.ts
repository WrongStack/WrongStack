/**
 * Catalog integrity guards for the 7 shipped WebUI locales.
 *
 * These three invariants are what actually break i18n in practice, and each one
 * has already regressed at least once:
 *
 *  1. KEY PARITY — every locale carries exactly the English key set. A missing
 *     key silently renders English inside an otherwise-translated screen.
 *  2. NO DANGLING REFERENCES — every `t('ns:key')` written in `src/` resolves in
 *     the English catalog. A typo'd key renders the raw key id to the user.
 *  3. HOOK WIRING — no component calls `t(...)` without obtaining it. This one
 *     is a hard crash / TS error, and a half-finished i18n pass shipped exactly
 *     that (six roster components referenced `t` with no `useAppTranslation`).
 *
 * The tests read the catalogs and sources straight off disk rather than through
 * i18next so they fail loudly at the file level, before any rendering.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SUPPORTED_LNGS } from '../../src/i18n/languages';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');
const LOCALES = path.join(SRC, 'i18n/locales');

/** Namespaces registered in src/i18n/index.ts. */
const NAMESPACES = [
  'common',
  'activity',
  'chat',
  'commandPalette',
  'settings',
  'setup',
  'toasts',
] as const;

type Catalog = Record<string, string>;

function flatten(value: unknown, prefix = ''): Catalog {
  const out: Catalog = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      Object.assign(out, flatten(child, dotted));
    } else {
      out[dotted] = String(child);
    }
  }
  return out;
}

function readCatalog(lng: string, ns: string): Catalog {
  return flatten(JSON.parse(fs.readFileSync(path.join(LOCALES, lng, `${ns}.json`), 'utf8')));
}

function sourceFiles(): string[] {
  const found: string[] = [];
  (function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'locales') walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        found.push(full);
      }
    }
  })(SRC);
  return found;
}

const english = Object.fromEntries(NAMESPACES.map((ns) => [ns, readCatalog('en', ns)])) as Record<
  string,
  Catalog
>;

describe('locale catalogs — key parity', () => {
  it.each(SUPPORTED_LNGS.filter((l) => l !== 'en'))('%s has exactly the English key set', (lng) => {
    const missing: string[] = [];
    const extra: string[] = [];
    for (const ns of NAMESPACES) {
      const translated = readCatalog(lng, ns);
      for (const key of Object.keys(english[ns])) {
        if (!(key in translated)) missing.push(`${ns}:${key}`);
      }
      for (const key of Object.keys(translated)) {
        if (!(key in english[ns])) extra.push(`${ns}:${key}`);
      }
    }
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it('ships a catalog file for every namespace in every locale', () => {
    for (const lng of SUPPORTED_LNGS) {
      for (const ns of NAMESPACES) {
        expect(fs.existsSync(path.join(LOCALES, lng, `${ns}.json`)), `${lng}/${ns}.json`).toBe(
          true,
        );
      }
    }
  });

  it('never leaves an empty string in a translated catalog', () => {
    const blanks: string[] = [];
    for (const lng of SUPPORTED_LNGS) {
      for (const ns of NAMESPACES) {
        for (const [key, value] of Object.entries(readCatalog(lng, ns))) {
          if (!value.trim()) blanks.push(`${lng}/${ns}:${key}`);
        }
      }
    }
    expect(blanks).toEqual([]);
  });
});

describe('t() references resolve', () => {
  // i18next resolves `t('x', { count })` against x_one / x_other, so a plural
  // family counts as defining its base key.
  const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

  it('every static t(ns:key) in src/ exists in the English catalog', () => {
    const dangling: string[] = [];
    const patterns = [
      /\bt\(\s*'([a-zA-Z][\w-]*):([\w.-]+)'/g,
      /\bt\(\s*"([a-zA-Z][\w-]*):([\w.-]+)"/g,
      // Hook-free constant maps carry the key in a field (`labelKey: 'ns:x.y'`)
      // and resolve it later via `t(meta.labelKey)`. The call site is dynamic,
      // so the key is only checkable here — and a typo in one of these shipped
      // an untranslated verdict badge before this pattern was added.
      /\b\w*(?:Key|KEY)\s*:\s*'([a-zA-Z][\w-]*):([\w.-]+)'/g,
      /\b\w*(?:Key|KEY)\s*:\s*"([a-zA-Z][\w-]*):([\w.-]+)"/g,
    ];
    for (const file of sourceFiles()) {
      const src = fs.readFileSync(file, 'utf8');
      for (const re of patterns) {
        for (const match of src.matchAll(re)) {
          const [, ns, key] = match;
          if (!(NAMESPACES as readonly string[]).includes(ns)) continue;
          const catalog = english[ns];
          const known =
            key in catalog ||
            Object.keys(catalog).some((k) => k.replace(PLURAL_SUFFIX, '') === key);
          if (!known) {
            const line = src.slice(0, match.index).split('\n').length;
            dangling.push(`${path.relative(SRC, file)}:${line} → ${ns}:${key}`);
          }
        }
      }
    }
    expect(dangling).toEqual([]);
  });
});

describe('translator wiring', () => {
  it('no source file calls t(...) without obtaining a translator', () => {
    // `t(` preceded by a dot (i18n.t) or word char is a different symbol.
    const CALLS_T = /(^|[^.\w])t\(\s*['"`]/;
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const src = fs.readFileSync(file, 'utf8');
      if (!CALLS_T.test(src)) continue;
      const hasTranslator =
        // The hook, in a component.
        /useAppTranslation|useTranslation/.test(src) ||
        // Class components and module-level helpers use the singleton.
        /\bi18n\.t\(/.test(src) ||
        // Pure helpers take the translator as a parameter (`t: (key: …) => string`).
        /\bt\s*:\s*\(/.test(src) ||
        /\bt\s*:\s*TFunction/.test(src);
      if (!hasTranslator) offenders.push(path.relative(SRC, file));
    }
    expect(offenders).toEqual([]);
  });
});
