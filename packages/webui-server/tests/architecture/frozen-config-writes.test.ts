/**
 * Nothing may write a property onto the live `Config`.
 *
 * `ConfigLoader.load()` returns `Object.freeze(cfg)` (config-loader.ts:287) and
 * `patchConfig` re-freezes (boot.ts:30). ESM modules are always strict mode, so
 * a direct property assignment on that object throws at runtime — it is not a
 * silent no-op. `applyConfigPrefs` did exactly that and every settings-save
 * failed with:
 *
 *   webui_server.message_handler_failed
 *   "Cannot assign to read only property 'features' of object '#<Object>'"
 *
 * The correct shape, already dominant on this router, is copy-on-write:
 * `state.setConfig(patchConfig(state.getConfig(), { … }))`.
 *
 * This guard enumerates CALL SITES rather than matching a hazard pattern: it
 * finds every binding derived from a `getConfig()` call and reports any
 * property assignment onto it. Sibling files that mutate a `ProviderConfig`
 * freshly parsed from disk (provider/keys.ts, provider/custom-models.ts) are
 * correctly untouched by this — their objects never came from `getConfig()`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...tsFiles(abs));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Strip comments so a hazard shown in prose is not reported, and — more
 * importantly — so a real assignment cannot hide behind one. Naive about
 * string literals on purpose: the failure direction is reporting too much,
 * which is loud, rather than too little, which is the bug being guarded.
 *
 * Block comments are replaced by their own newlines rather than removed, so
 * reported line numbers still address the real file. Collapsing them made the
 * guard's first real finding point 93 lines off its actual site — a report you
 * cannot navigate to is barely better than no report.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (block) => '\n'.repeat((block.match(/\n/gu) ?? []).length))
    .replace(/\/\/.*/gu, '');
}

export interface FrozenConfigWrite {
  readonly binding: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Find property assignments onto a binding derived from `getConfig()`.
 *
 * Scope-aware on purpose. A file-wide name scan reported
 * `config.provider = newProvider` inside `cb.updateGlobalConfig((config) => …)`
 * — a callback parameter that receives the UNFROZEN decrypted config, and which
 * sits 250 lines BEFORE the `const config = state.getConfig()` whose name it
 * borrowed. So each binding is searched only forward, and only until its block
 * closes or the name is rebound (a `const`/`let` redeclaration, or a parameter
 * list that shadows it).
 */
export function findFrozenConfigWrites(source: string): FrozenConfigWrite[] {
  const lines = withoutComments(source).split('\n');
  const found: FrozenConfigWrite[] = [];
  const declare = /\b(?:const|let|var)\s+(\w+)\s*=\s*[^;\n]*getConfig\(\)/u;

  lines.forEach((declLine, declIndex) => {
    const decl = declare.exec(declLine);
    const name = decl?.[1];
    if (!decl || !name) return;
    // Where the declaration ends on its own line — everything after it is
    // still in scope and must be searched.
    const declEnd = decl.index + decl[0].length;

    // `.prop =` or `['prop'] =`, excluding ==, ===, => and compound compares.
    const assign = new RegExp(String.raw`\b${name}(?:\.\w+|\[['"]\w+['"]\])\s*=(?!=|>)`, 'u');
    const shadow = new RegExp(
      String.raw`(?:\b(?:const|let|var)\s+${name}\b|\(\s*${name}\s*[,)]|\(\s*${name}\s*:)`,
      'u',
    );

    let depth = 0;
    for (let i = declIndex; i < lines.length; i++) {
      const text = lines[i] ?? '';
      // On the declaring line, search only what follows the declaration —
      // `const config = getConfig(); config.model = 'x'` is one line and was
      // invisible to a scan that simply started at the next one.
      const searchable = i === declIndex ? text.slice(declEnd) : text;
      if (i > declIndex && shadow.test(text)) break; // the name now means something else
      if (assign.test(searchable)) {
        found.push({ binding: name, line: i + 1, text: text.trim() });
      }
      depth += (text.match(/\{/gu) ?? []).length - (text.match(/\}/gu) ?? []).length;
      if (depth < 0) break; // the declaring block closed
    }
  });

  return found.sort((a, b) => a.line - b.line);
}

describe('no module writes onto the frozen live Config', () => {
  it('every webui-server source is clean', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      for (const hit of findFrozenConfigWrites(readFileSync(file, 'utf8'))) {
        offenders.push(`${path.relative(SRC, file)}:${hit.line}  ${hit.text}`);
      }
    }
    expect(
      offenders,
      'These assign onto a binding that came from getConfig(). That object is ' +
        'frozen, so in strict mode the write THROWS and takes the whole message ' +
        'handler with it. Use state.setConfig(patchConfig(config, { … })) ' +
        'instead. Sites:',
    ).toEqual([]);
  });

  // SECURITY.md rule 3: validate a guard by injection, never by watching it
  // pass. A source-scanning guard that reports nothing is indistinguishable
  // from one whose regex silently stopped matching, so prove it still bites.
  it('injection: the exact pre-fix code is reported', () => {
    const reintroduced = [
      'applyConfigPrefs: (payload) => {',
      '  const config = state.getConfig();',
      '  const features = (config.features ?? {}) as Record<string, unknown>;',
      "  if (typeof payload['featureMcp'] === 'boolean') features['mcp'] = payload['featureMcp'];",
      '  config.features = features as never;',
      '}',
    ].join('\n');
    const hits = findFrozenConfigWrites(reintroduced);
    expect(hits.map((h) => h.text)).toEqual(['config.features = features as never;']);
  });

  it('injection: the bracket form is reported too', () => {
    const hits = findFrozenConfigWrites("const cur = state.getConfig();\ncur['model'] = 'x';");
    expect(hits).toHaveLength(1);
  });

  it('injection: a write hidden behind a comment is still reported', () => {
    const hits = findFrozenConfigWrites(
      "const config = state.getConfig(); /* safe, honest */ config.model = 'x';",
    );
    expect(hits).toHaveLength(1);
  });

  it('does not flag comparisons, arrows, or unrelated bindings', () => {
    expect(
      findFrozenConfigWrites(
        [
          'const config = state.getConfig();',
          "if (config.model === 'x') return;",
          'const pick = () => config.model;',
          // A ProviderConfig parsed from disk is a different object entirely —
          // the provider/* modules mutate these legitimately.
          'const cfg = providers[id];',
          "cfg.baseUrl = 'https://example.test';",
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('does not flag a callback parameter that merely reuses the name', () => {
    // The real shape at routes.ts:519 — `updateGlobalConfig` hands its callback
    // the UNFROZEN decrypted config, and that parameter is legitimately
    // mutated. A file-wide name scan reported it (250 lines before the
    // `const config = state.getConfig()` whose name it borrowed) and would
    // have forced a bogus "fix" onto correct code.
    const source = [
      'await cb.updateGlobalConfig((config) => {',
      '  config.provider = newProvider;',
      '}, "model.switch");',
      'const config = state.getConfig();',
      'return config.model;',
    ].join('\n');
    expect(findFrozenConfigWrites(source)).toEqual([]);
  });

  it('stops at the end of the declaring block', () => {
    const source = [
      'function a() {',
      '  const config = state.getConfig();',
      '}',
      'function b(config) {',
      '  config.model = "x";',
      '}',
    ].join('\n');
    expect(findFrozenConfigWrites(source)).toEqual([]);
  });

  it('the scan actually reaches source (guard against an empty walk)', () => {
    // A path typo would make the clean-tree assertion vacuously true.
    const files = tsFiles(SRC);
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith(`server${path.sep}routes.ts`))).toBe(true);
  });
});
