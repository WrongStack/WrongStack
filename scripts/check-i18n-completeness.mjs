#!/usr/bin/env bun
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const LOCALES_ROOT = path.resolve('packages/webui/src/i18n/locales');
const REFERENCE_LOCALE = 'en';

function flattenLeafKeys(value, prefix = '', keys = new Set()) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flattenLeafKeys(child, prefix ? `${prefix}.${key}` : key, keys);
    }
  } else {
    keys.add(prefix);
  }
  return keys;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

const localeEntries = await readdir(LOCALES_ROOT, { withFileTypes: true });
const locales = localeEntries
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (!locales.includes(REFERENCE_LOCALE)) {
  throw new Error(`reference locale "${REFERENCE_LOCALE}" was not found in ${LOCALES_ROOT}`);
}

const referenceDir = path.join(LOCALES_ROOT, REFERENCE_LOCALE);
const referenceFiles = (await readdir(referenceDir))
  .filter((file) => file.endsWith('.json'))
  .sort();
const referenceFileSet = new Set(referenceFiles);
const findings = [];

for (const locale of locales) {
  if (locale === REFERENCE_LOCALE) continue;
  const localeDir = path.join(LOCALES_ROOT, locale);
  const localeFiles = (await readdir(localeDir)).filter((file) => file.endsWith('.json')).sort();
  const localeFileSet = new Set(localeFiles);

  for (const file of referenceFiles) {
    if (!localeFileSet.has(file)) {
      findings.push(`${locale}/${file}: missing file`);
      continue;
    }

    const referenceKeys = flattenLeafKeys(await readJson(path.join(referenceDir, file)));
    const localeKeys = flattenLeafKeys(await readJson(path.join(localeDir, file)));
    const missing = [...referenceKeys].filter((key) => !localeKeys.has(key));
    const extra = [...localeKeys].filter((key) => !referenceKeys.has(key));
    if (missing.length > 0) findings.push(`${locale}/${file}: missing ${missing.join(', ')}`);
    if (extra.length > 0) findings.push(`${locale}/${file}: extra ${extra.join(', ')}`);
  }

  for (const file of localeFiles) {
    if (!referenceFileSet.has(file)) findings.push(`${locale}/${file}: extra file`);
  }
}

if (findings.length > 0) {
  console.error(`[i18n] ${findings.length} locale completeness problem(s):`);
  for (const finding of findings) console.error(`  ${finding}`);
  process.exit(1);
}

console.log(`[i18n] ${locales.length} locales match ${referenceFiles.length} English namespaces.`);
