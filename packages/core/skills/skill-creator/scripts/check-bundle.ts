import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isKnownRuntimeCapability,
  missingRequiredRuntimeTools,
  RUNTIME_CAPABILITY_MANIFEST,
  runtimeToolReferencesFromText,
} from '@wrongstack/contracts/types/runtime-capability-manifest';
import { buildProgressiveSkillManifestText } from '../../../src/core/system-prompt-skill-bodies.js';
import { DefaultSkillLoader } from '../../../src/execution/skill-loader.js';
import {
  parseSkillFrontmatter,
  stripFrontmatter,
  validateSkillDocument,
} from '../../../src/skills/frontmatter.js';
import { skillUseWhenText } from '../../../src/skills/prompt-discovery.js';
import { resolveWstackPaths } from '../../../src/utils/wstack-paths.js';

// Read-only authoring check using the same parser, capabilities and loader as runtime.
const bundle = fileURLToPath(new URL('../../', import.meta.url));
const allTools = RUNTIME_CAPABILITY_MANIFEST.flatMap((entry) => [...entry.tools]);
const entries = (await fs.readdir(bundle, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .sort((left, right) => left.name.localeCompare(right.name));
const names = new Set(entries.map((entry) => entry.name));
const errors: string[] = [];
let resources = 0;

async function markdownFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await markdownFiles(target)));
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      result.push(target);
    }
  }
  return result;
}

for (const entry of entries) {
  const root = path.join(bundle, entry.name);
  const document = path.join(root, 'SKILL.md');
  let raw: string;
  try {
    raw = await fs.readFile(document, 'utf8');
  } catch {
    errors.push(entry.name + ': missing readable SKILL.md');
    continue;
  }
  errors.push(...validateSkillDocument(raw, entry.name).map((error) => entry.name + ': ' + error));
  const metadata = parseSkillFrontmatter(raw);
  const body = stripFrontmatter(raw);
  if (
    !body.includes('## Selection card') ||
    !body.includes('- Start:') ||
    !body.includes('- Finish:')
  )
    errors.push(entry.name + ': missing actionable selection card');
  if (!metadata.metadata?.['routing-group'])
    errors.push(entry.name + ': missing routing-group metadata');
  if (!/^## (?:Before returning|Acceptance checks)\s*$/m.test(body))
    errors.push(entry.name + ': missing explicit acceptance checks');
  if (raw.split('\n').length > 200)
    errors.push(
      entry.name + ': entrypoint exceeds 200 lines; move conditional details to resources',
    );
  for (const capability of [
    ...(metadata.requiredCapabilities ?? []),
    ...(metadata.optionalCapabilities ?? []),
  ]) {
    if (!isKnownRuntimeCapability(capability)) {
      errors.push(entry.name + ': unknown capability ' + capability);
    }
  }
  const missing = missingRequiredRuntimeTools(
    [...(metadata.requiredTools ?? []), ...runtimeToolReferencesFromText(body)],
    allTools,
  );
  errors.push(...missing.map((tool) => entry.name + ': unknown required tool ' + tool));
  const referencedTools = runtimeToolReferencesFromText(raw)
    .filter((tool) => allTools.includes(tool))
    .sort();
  const declaredTools = [...new Set(metadata.requiredTools ?? [])].sort();
  if (JSON.stringify(referencedTools) !== JSON.stringify(declaredTools))
    errors.push(
      entry.name +
        ': required-tools must match canonical tool references; qualify language APIs such as globalThis.fetch() explicitly',
    );

  // Hand-offs should resolve whether the author uses inline code or plain names.
  const related = /^## (?:Skills in scope|Related skills)\s*$([\s\S]*?)(?=^## |(?![\s\S]))/im.exec(
    body,
  );
  for (const match of (related?.[1] ?? '').matchAll(/^- `?([a-z0-9-]+)`?\s*(?:—|–|:| -)/gm)) {
    if (!names.has(match[1] ?? '')) errors.push(entry.name + ': missing related skill ' + match[1]);
  }

  for (const file of await markdownFiles(root)) {
    if (file !== document) resources++;
    const text = await fs.readFile(file, 'utf8');
    if (path.basename(file) === 'SKILL.save.md') {
      const sourceVersion = /<!-- source-version: ([^\s]+) -->/.exec(text)?.[1];
      if (sourceVersion !== metadata.version)
        errors.push(entry.name + ': compact source version differs from SKILL.md');
      errors.push(
        ...missingRequiredRuntimeTools(runtimeToolReferencesFromText(text), allTools).map(
          (tool) => entry.name + ': unknown compact tool ' + tool,
        ),
      );
    }
    for (const match of text.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)) {
      const link = match[1] ?? '';
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(link) || /[<>]/.test(link)) continue;
      const relativeLink = decodeURIComponent(link.split('#')[0] ?? '');
      const target = path.resolve(path.dirname(file), relativeLink);
      const relative = path.relative(root, target);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        errors.push(entry.name + ': local resource escapes skill root: ' + link);
        continue;
      }
      try {
        if (!(await fs.stat(target)).isFile())
          errors.push(entry.name + ': resource is not a file: ' + link);
      } catch {
        errors.push(entry.name + ': missing resource ' + link);
      }
    }
  }
}

// Construct isolated paths without creating files or admitting project/user overrides.
const selectionMap = await fs.readFile(
  path.join(bundle, 'skill-router/references/selection-map.md'),
  'utf8',
);
const routedNames = new Set(
  [...selectionMap.matchAll(/\| `([a-z0-9-]+)` \|/g)].map((match) => match[1]),
);
for (const name of names) {
  if (!routedNames.has(name)) errors.push(name + ': absent from bundled selection map');
}
for (const name of routedNames) {
  if (!name || !names.has(name)) errors.push('selection map: unknown skill ' + name);
}
const unusedRoot = path.join(os.tmpdir(), 'wstack-bundle-check-' + randomUUID());
const loader = new DefaultSkillLoader({
  paths: resolveWstackPaths({
    projectRoot: path.join(unusedRoot, 'project'),
    globalRoot: path.join(unusedRoot, 'global'),
    userHome: path.join(unusedRoot, 'home'),
  }),
  foreignSources: false,
  bundledDir: bundle,
});
const manifests = await loader.list();
for (const entry of entries) {
  const manifest = manifests.find((item) => item.name === entry.name && item.source === 'bundled');
  if (!manifest) errors.push(entry.name + ': not discovered by runtime loader');
  else if (!(await loader.readBody(entry.name))?.trim()) {
    errors.push(entry.name + ': empty runtime body');
  } else if (!(await loader.readSaveBody(entry.name))?.trim()) {
    errors.push(entry.name + ': empty runtime compact body');
  }
}

// The progressive catalog is the only text the model sees before choosing a
// skill, and it cuts each description short. The first sentence must survive
// whole, so authors lead with the frameworks, files and symptoms a request names.
const catalog = await buildProgressiveSkillManifestText(loader, allTools);
const rows = new Map(
  [...catalog.matchAll(/^\| `([a-z0-9-]+)`[^|]*\| (.*) \|$/gm)].map((match) => [
    match[1] ?? '',
    (match[2] ?? '').replace(/\\\|/g, '|'),
  ]),
);
for (const manifest of manifests) {
  const row = rows.get(manifest.name);
  if (manifest.source !== 'bundled' || row === undefined) continue;
  const useWhen = skillUseWhenText(manifest.description, manifest.trigger)
    .replace(/\s+/g, ' ')
    .trim();
  const end = [...useWhen.matchAll(/[.!?](?=\s|$)/g)].find(
    (match) => !/\b(?:e\.g|i\.e|etc|vs|cf)$/i.test(useWhen.slice(0, match.index ?? 0)),
  )?.index;
  const sentence = end === undefined ? useWhen : useWhen.slice(0, end + 1);
  if (!row.startsWith(sentence))
    errors.push(
      manifest.name +
        ': catalog row cuts the first description sentence (' +
        sentence.length +
        ' chars); keep it near 135 and lead with the request vocabulary',
    );
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    'Bundle valid: ' +
      names.size +
      ' skills, ' +
      resources +
      ' Markdown resources; runtime discovery passed.',
  );
}
