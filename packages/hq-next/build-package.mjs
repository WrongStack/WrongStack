import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanBuildOutput } from '../../scripts/lib/build-output-cleanup.mjs';
import { externalizeDirectory } from './scripts/externalize-inline-scripts.mjs';

// The HQ server serves `dist/`; Next itself is only needed at build time.
const packageRoot = dirname(fileURLToPath(import.meta.url));
const output = resolve(packageRoot, 'dist');
if (process.cwd() !== packageRoot || dirname(output) !== packageRoot) {
  throw new Error('HQ must be built from its package directory.');
}
cleanBuildOutput(output);
mkdirSync('dist', { recursive: true });
cpSync('out', 'dist', { recursive: true });

// HQ's CSP admits no inline script at all; move Next's payload scripts out.
const { pages, scripts } = externalizeDirectory(output);
console.log(`HQ: externalized inline scripts in ${pages} pages into ${scripts} files.`);
