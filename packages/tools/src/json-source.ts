import * as path from 'node:path';
import { sanitizeJsonString } from '@wrongstack/primitives/safe-json';
import { parse as parseYaml } from 'yaml';

/** Which syntax a source was actually read as. */
export type JsonSourceFormat = 'json' | 'jsonc' | 'yaml';

const YAML_EXTENSIONS = new Set(['.yaml', '.yml']);

/**
 * Parse `json` tool input the way its contract describes it: JSON, JSON with
 * comments / trailing commas (tsconfig.json, .vscode/*.json, biome.json), and
 * YAML. Strict `JSON.parse` alone refused every commented tsconfig and every
 * workflow file while the tool told the model it reads "JSON/JSON5/YAML".
 *
 * Order matters for honesty: strict JSON first, then the JSONC repair, and
 * YAML only where it cannot turn garbage into a value — a `.yaml`/`.yml`
 * file, or a source whose YAML reading is a mapping or sequence. YAML accepts
 * almost any text as a plain scalar, so a broken JSON string would otherwise
 * "parse" into itself and hide the syntax error.
 *
 * Throws the strict-JSON error (the one the caller can act on) when nothing
 * fits.
 */
export function parseJsonSource(
  raw: string,
  file: string | undefined,
): { value: unknown; format: JsonSourceFormat } {
  const ext = file ? path.extname(file).toLowerCase() : '';
  if (YAML_EXTENSIONS.has(ext)) return { value: parseYamlStrict(raw), format: 'yaml' };
  try {
    return { value: JSON.parse(raw), format: 'json' };
  } catch (jsonError) {
    const repaired = sanitizeJsonString(raw);
    if (repaired !== null) return { value: JSON.parse(repaired), format: 'jsonc' };
    // Text that opens like JSON is meant as JSON: YAML flow syntax would read
    // the broken `{invalid}` as the mapping `{invalid: null}` and hide the error.
    if (/^\s*[[{]/.test(raw)) throw jsonError;
    let yamlValue: unknown;
    try {
      yamlValue = parseYamlStrict(raw);
    } catch {
      throw jsonError;
    }
    if (yamlValue !== null && typeof yamlValue === 'object') {
      return { value: yamlValue, format: 'yaml' };
    }
    throw jsonError;
  }
}

function parseYamlStrict(raw: string): unknown {
  // `maxAliasCount` bounds alias expansion ("billion laughs"); the library's
  // default is the same 100, pinned here so an upgrade cannot loosen it.
  return parseYaml(raw, { maxAliasCount: 100, prettyErrors: true });
}
