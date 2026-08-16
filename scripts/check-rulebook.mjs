#!/usr/bin/env node
/**
 * TechStack — rulebook contract check (CI gate).
 *
 * Verifies the project rulebook at `<repoRoot>/.wrongstack/techstack.rulebook.json`
 * (when present) against the canonical `RULEBOOK_JSON_SCHEMA` exported by
 * `packages/techstack/src/policy/rulebook.ts`.
 *
 * The rulebook is OPTIONAL — absence is not an error. A present-but-invalid
 * rulebook (unparseable JSON or schema violation) is a hard failure with a
 * dedicated exit code so release automation can route it distinctly.
 *
 * Exit codes:
 *   0 — rulebook absent or schema-valid
 *   5 — rulebook present but unparseable or schema-invalid (RC5)
 *
 * Run: node --experimental-strip-types scripts/check-rulebook.mjs [--path <file>]
 *      (--path overrides the default location; used by tests)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULEBOOK_JSON_SCHEMA } from '../packages/techstack/src/policy/rulebook.ts';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const DEFAULT_PATH = join(ROOT, '.wrongstack', 'techstack.rulebook.json');
const EXIT_OK = 0;
const EXIT_INVALID = 5;

// ── Minimal JSON Schema subset validator ────────────────────────────────
//
// Deliberately NOT a full JSON Schema implementation: this script only needs
// the keywords used by RULEBOOK_JSON_SCHEMA (type, required, properties,
// additionalProperties, items, const, $ref/$defs, minLength, maxLength,
// format). If the schema grows a new keyword, extend this switch — the
// validator fails closed on unknown keywords so drift is loud.

/**
 * Validate `value` against `schemaNode`. Errors are appended to `errors`
 * with a JSON-path-ish prefix. `defs` carries the top-level `$defs` map so
 * `$ref` can resolve.
 */
function validateNode(value, schemaNode, defs, path, errors) {
  if (schemaNode.$ref) {
    const defName = schemaNode.$ref.split('/').pop();
    const def = defs[defName];
    if (!def) {
      errors.push(`${path}: unresolvable $ref ${schemaNode.$ref}`);
      return;
    }
    validateNode(value, def, defs, path, errors);
    return;
  }

  if (schemaNode.const !== undefined) {
    if (value !== schemaNode.const) {
      errors.push(
        `${path}: expected const ${JSON.stringify(schemaNode.const)}, got ${JSON.stringify(value)}`,
      );
    }
    return;
  }

  switch (schemaNode.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`${path}: expected object`);
        return;
      }
      for (const required of schemaNode.required ?? []) {
        if (!(required in value)) {
          errors.push(`${path}: missing required property '${required}'`);
        }
      }
      const properties = schemaNode.properties ?? {};
      for (const [key, subSchema] of Object.entries(properties)) {
        if (key in value) validateNode(value[key], subSchema, defs, `${path}.${key}`, errors);
      }
      if (schemaNode.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in properties)) {
            errors.push(`${path}: unexpected property '${key}'`);
          }
        }
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array`);
        return;
      }
      if (schemaNode.items) {
        for (const [index, item] of value.entries()) {
          validateNode(item, schemaNode.items, defs, `${path}[${index}]`, errors);
        }
      }
      return;
    }
    case 'string': {
      if (typeof value !== 'string') {
        errors.push(`${path}: expected string`);
        return;
      }
      if (schemaNode.minLength !== undefined && value.length < schemaNode.minLength) {
        errors.push(`${path}: shorter than minLength ${schemaNode.minLength}`);
      }
      if (schemaNode.maxLength !== undefined && value.length > schemaNode.maxLength) {
        errors.push(`${path}: longer than maxLength ${schemaNode.maxLength}`);
      }
      if (schemaNode.format === 'date-time' && Number.isNaN(Date.parse(value))) {
        errors.push(`${path}: invalid date-time '${value}'`);
      }
      return;
    }
    default:
      errors.push(`${path}: unsupported schema type ${String(schemaNode.type)}`);
  }
}

function validateAgainstSchema(doc, schema) {
  const errors = [];
  validateNode(doc, schema, schema.$defs ?? {}, 'rulebook', errors);
  return errors;
}

// ── Entry point ──────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  const pathFlagIndex = argv.indexOf('--path');
  const rulebookPath =
    pathFlagIndex !== -1 && argv[pathFlagIndex + 1]
      ? resolve(argv[pathFlagIndex + 1])
      : DEFAULT_PATH;

  if (!existsSync(rulebookPath)) {
    console.log(`[check-rulebook] OK — rulebook absent (optional): ${rulebookPath}`);
    process.exit(EXIT_OK);
  }

  let raw;
  try {
    raw = readFileSync(rulebookPath, 'utf8');
  } catch (error) {
    console.error(`[check-rulebook] FAIL — cannot read rulebook: ${error.message}`);
    process.exit(EXIT_INVALID);
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    console.error(`[check-rulebook] FAIL — invalid JSON in rulebook: ${error.message}`);
    process.exit(EXIT_INVALID);
  }

  let schema;
  try {
    schema = JSON.parse(RULEBOOK_JSON_SCHEMA);
  } catch (error) {
    console.error(
      `[check-rulebook] FAIL — RULEBOOK_JSON_SCHEMA itself is not valid JSON: ${error.message}`,
    );
    process.exit(EXIT_INVALID);
  }

  const errors = validateAgainstSchema(doc, schema);
  if (errors.length > 0) {
    console.error(`[check-rulebook] FAIL — rulebook violates the schema (${rulebookPath}):`);
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(EXIT_INVALID);
  }

  console.log(`[check-rulebook] OK — rulebook satisfies the schema: ${rulebookPath}`);
  process.exit(EXIT_OK);
}

main();
