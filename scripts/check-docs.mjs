#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'archive' || entry.name.startsWith('competitive-')) return [];
    const file = join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : file.endsWith('.md') ? [file] : [];
  });
}
const files = [
  ...walk(join(root, 'docs')),
  ...['README.md', 'SECURITY.md', 'CHANGELOG.md'].map((file) => join(root, file)),
];
const errors = [];
let links = 0;
const directoryEntries = new Map();
const headingCache = new Map();
function headingIds(file) {
  if (headingCache.has(file)) return headingCache.get(file);
  const ids = new Set();
  const occurrences = new Map();
  let fence;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?$/);
    if (heading) {
      const slug = heading[1]
        .replace(/(`+)(.*?)\1/g, (_match, _ticks, body) => body.replace(/[<>]/g, ''))
        .replace(/<[^>]+>/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
        .replace(/ /g, '-');
      const count = occurrences.get(slug) ?? 0;
      occurrences.set(slug, count + 1);
      ids.add(slug + (count ? `-${count}` : ''));
    }
    for (const anchor of line.matchAll(/<a\s+(?:name|id)=["']([^"']+)["']/g)) ids.add(anchor[1]);
  }
  headingCache.set(file, ids);
  return ids;
}
function hasExactCase(file) {
  const parts = relative(root, file).split(/[\\/]/);
  let current = root;
  for (const part of parts) {
    if (!part) continue;
    if (part === '..') {
      current = dirname(current);
      continue;
    }
    if (!directoryEntries.has(current)) directoryEntries.set(current, readdirSync(current));
    if (!directoryEntries.get(current).includes(part)) return false;
    current = join(current, part);
  }
  return true;
}
for (const file of files) {
  // Code examples can intentionally contain hypothetical Markdown paths.
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  let fence;
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const prose = lines[i].replace(/(`+)(.*?)\1/g, '');
    for (const match of prose.matchAll(/\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1].replace(/^<|>$/g, '');
      if (/^(?:https?:|mailto:|app:)/.test(target)) continue;
      const at = `${relative(root, file).replaceAll('\\', '/')}:${i + 1}`;
      if (target.startsWith('file:')) {
        errors.push(`${at}: machine-specific link ${target}`);
        continue;
      }
      links++;
      const pathname = decodeURIComponent(target.split(/[?#]/)[0]);
      const resolved = pathname ? resolve(dirname(file), pathname) : file;
      if (!existsSync(resolved)) errors.push(`${at}: missing ${target}`);
      else if (!hasExactCase(resolved))
        errors.push(`${at}: path casing differs from disk: ${target}`);
      else if (
        resolved.endsWith('.md') &&
        !relative(root, resolved).replaceAll('\\', '/').startsWith('docs/archive/') &&
        target.includes('#') &&
        !headingIds(resolved).has(decodeURIComponent(target.split('#').slice(1).join('#')))
      )
        errors.push(`${at}: missing heading ${target}`);
    }
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  console.error(`Documentation links: ${errors.length} failure(s).`);
  process.exitCode = 1;
} else {
  console.log(
    `Documentation links: ${files.length} maintained Markdown files, ${links} local links, 0 missing targets. Historical archive and local competitive research are excluded.`,
  );
}
