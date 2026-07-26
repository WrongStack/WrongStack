import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Directive guard: no adapter may invent an output-token number.
 *
 * The bug this encodes: every wire adapter used to end its cap resolution with
 * `?? 8192`. Because the provider-scoped capabilities were empty on any
 * runtime-rebuilt provider, that literal won constantly — a model advertising
 * `limit.output: 384000` on models.dev went out capped at 8192.
 *
 * The rule now: the number comes from models.dev / providers.json, or the
 * field is omitted so the backend applies the model's own ceiling. The single
 * documented exception is Anthropic's Messages API, which rejects a request
 * without `max_tokens`.
 *
 * These assertions are deliberately source-level. A behavioural test only
 * covers the paths it exercises; a re-introduced `?? 4096` in some seldom-hit
 * branch would slip through, and the failure mode (quietly truncated
 * responses) is one nobody notices for months.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Strip comments so prose describing the old bug doesn't trip the scan. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FILES = sourceFiles(SRC).map((file) => ({
  rel: path.relative(SRC, file).replace(/\\/g, '/'),
  code: stripComments(readFileSync(file, 'utf8')),
}));

describe('no hardcoded output caps', () => {
  it('scans a plausible number of provider sources', () => {
    // Guards the guard: a broken glob silently passing every assertion below.
    expect(FILES.length).toBeGreaterThan(20);
  });

  it('never falls back from a token cap to a numeric literal', () => {
    // `maxOutput ?? 8192`, `maxTokens ?? 4096`, `max_output_tokens ?? 1024`, …
    const pattern = /\b(max[A-Za-z_]*[Tt]okens|maxOutput)\b[^;\n]*\?\?\s*[0-9_]+/;
    const offenders = FILES.filter((f) => pattern.test(f.code)).map((f) => f.rel);
    expect(
      offenders,
      'resolve the cap from the catalog and omit the field when unknown — ' +
        'see model-output-limits.ts',
    ).toEqual([]);
  });

  it('keeps the required-field last resort to a single, named definition', () => {
    // Scoped to OUTPUT literals. `maxContext` defaults are a separate concern:
    // the local-runtime presets (ollama, vLLM, LM Studio) serve whatever model
    // the user loaded, and models.dev carries no entry for those providers, so
    // there is no catalog value to read. Byte-buffer bounds are unrelated too.
    const isOutputLiteral = (line: string) =>
      /\b8_?192\b/.test(line) && !/maxContext|Bytes|length|slice|buf\b/.test(line);
    const literalUsers = FILES.filter(
      (f) => f.rel !== 'model-output-limits.ts' && f.code.split('\n').some(isOutputLiteral),
    ).map((f) => f.rel);
    expect(literalUsers).toEqual([]);
  });

  it('exposes the last resort only through the Required helper', () => {
    const helper = FILES.find((f) => f.rel === 'model-output-limits.ts');
    expect(helper).toBeDefined();
    const uses = helper?.code.match(/REQUIRED_FIELD_LAST_RESORT_MAX_OUTPUT/g) ?? [];
    // Exactly two: the `export const` and the one `??` in the Required variant.
    expect(uses.length).toBe(2);

    const others = FILES.filter(
      (f) =>
        f.rel !== 'model-output-limits.ts' &&
        f.rel !== 'index.ts' &&
        f.code.includes('REQUIRED_FIELD_LAST_RESORT_MAX_OUTPUT'),
    ).map((f) => f.rel);
    expect(others, 'only Anthropic Messages requires the field').toEqual([]);
  });

  it('uses the Required variant in exactly one wire format', () => {
    const required = FILES.filter((f) => f.code.includes('resolveRequiredMaxOutputTokens')).map(
      (f) => f.rel,
    );
    expect(required.sort()).toEqual(['index.ts', 'model-output-limits.ts', 'presets/anthropic.ts']);
  });

  it('guards every optional cap behind an undefined check', () => {
    // A body builder that resolves the cap must not assign it unconditionally:
    // `field: maxOutput` would put `undefined` on the wire (or, worse, invite a
    // literal fallback later). Anthropic is exempt — its value is always a
    // number.
    const builders = FILES.filter(
      (f) => f.code.includes('resolveMaxOutputTokens(') && f.rel !== 'model-output-limits.ts',
    );
    expect(builders.length).toBeGreaterThan(0);
    for (const f of builders) {
      expect(f.code, `${f.rel} assigns the cap without an undefined check`).toMatch(
        /maxOutput !== undefined/,
      );
    }
  });
});
