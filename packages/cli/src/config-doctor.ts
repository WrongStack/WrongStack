/**
 * Config doctor — deterministic diagnosis and auto-repair for the standard
 * config files (the active profile config and the per-project config).
 *
 * Pure module: `diagnoseConfig` never touches the filesystem. The /doctor
 * slash command owns file IO, backups, and persistence so the engine stays
 * trivially testable.
 *
 * Repair philosophy: a removed key is always safe — built-in defaults (and,
 * for `extensions`, each plugin's `defaultConfig`) are merged underneath user
 * values at load time, so deleting an invalid value falls back to a known-good
 * default. Values are only rewritten when the intent is unambiguous (e.g. the
 * string "true" for a boolean field); anything ambiguous is reported as a
 * non-fixable finding instead of guessed at.
 */

import { isSecretField } from '@wrongstack/core/security';
import type { Config, JSONSchema } from '@wrongstack/core/types';
import { validateAgainstSchema } from '@wrongstack/core/utils';
import { nextCustomProviderId } from './provider-id.js';
import { MAX_TUI_THINKING_WORD_LENGTH, normalizeTuiThinkingWord } from './tui-thinking-word.js';

type DoctorSeverity = 'error' | 'warning';

export interface DoctorFinding {
  /** Dot path of the offending value, e.g. `autonomy.defaultMode`. */
  path: string;
  problem: string;
  severity: DoctorSeverity;
  /** Present when the finding is auto-fixable; describes the repair. */
  fix?: string | undefined;
}

interface DoctorReport {
  findings: DoctorFinding[];
  /** Deep copy of the input with every fixable finding repaired. */
  fixed: Record<string, unknown>;
  /** True when `fixed` differs from the input. */
  changed: boolean;
}

/** The subset of Plugin the doctor needs to validate `extensions` sections. */
export interface PluginSchemaInfo {
  name: string;
  configSchema?: JSONSchema | undefined;
}

/** Every key that may legitimately appear in a persisted config file.
 *  Mirrors the `Config` interface in @wrongstack/core types/config.ts.
 *
 *  Kept honest by `ConfigKeyCoverage` below, which is the guard this list
 *  went without for its whole life. It had drifted in BOTH directions:
 *  eight real fields — `systemPrompt`, `themePreset`, `modelTiers`,
 *  `chronicle`, `cloudSync`, `activeProfile`, `fallbackProfile`,
 *  `fallbackGateSeconds` — were reported to the user as "unknown key" even
 *  though WrongStack writes them itself (`/theme` writes `themePreset` on
 *  every theme change), and a phantom `agents` entry (that field is nested
 *  under `acp`, never top-level) waved a stray top-level `agents` block
 *  through. Add a field to `Config` and `tsc` now names it here. */
const KNOWN_TOP_LEVEL_KEYS = [
  'version',
  'activeProfile',
  'provider',
  'model',
  'apiKey',
  'baseUrl',
  'maxConcurrent',
  'uiLocale',
  'themePreset',
  'providers',
  'models',
  'modelMatrix',
  'modelTiers',
  'favoriteModels',
  'favoriteModelsOnly',
  'modelAvailabilitySchedule',
  'context',
  'tools',
  'mcpServers',
  'acp',
  'fallbackModels',
  'fallbackBridge',
  'fallbackProfiles',
  'fallbackProfile',
  'fallbackAuto',
  'fallbackMaxLastResortCandidates',
  'fallbackStickiness',
  'fallbackGateSeconds',
  'hooks',
  'plugins',
  'pluginManager',
  'log',
  'features',
  'Sage',
  'skills',
  'yolo',
  'nextPrediction',
  'cwd',
  'autonomy',
  'hints',
  'debugStream',
  'configScope',
  'indexing',
  'circuitBreaker',
  'adaptiveConcurrency',
  'launch',
  'session',
  'chronicle',
  'modelRuntime',
  'systemPrompt',
  'hq',
  'fleet',
  'brain',
  'sync',
  'cloudSync',
  'git',
  'extensions',
] as const;

/** Compile-time `never` assertion: instantiating it with a non-empty union
 *  fails and the TS error text spells out the offending key names. */
type AssertNever<T extends never> = T;

/** `Config` fields the doctor would report as unknown. Must be `never`. */
type UncoveredConfigKey = Exclude<keyof Config, (typeof KNOWN_TOP_LEVEL_KEYS)[number]>;

/** Keys the list invents that `Config` does not have. Must be `never`. */
type PhantomDoctorKey = Exclude<(typeof KNOWN_TOP_LEVEL_KEYS)[number], keyof Config>;

/**
 * The drift gate. Exported so `noUnusedVariables` keeps it, and because the
 * name is what a future reader greps for when `tsc` points here.
 *
 * A runtime test cannot do this job: `keyof Config` does not survive to
 * runtime, so the previous safety net was a hand-written list of keys inside
 * `slash-doctor.test.ts` — which drifted alongside the list it was meant to
 * pin. This resolves to `never` only while both directions are clean.
 */
export type ConfigKeyCoverage = AssertNever<UncoveredConfigKey> | AssertNever<PhantomDoctorKey>;

const BOOLEAN_FIELDS = ['hints', 'debugStream', 'yolo', 'nextPrediction'] as const;
const AUTONOMY_ENUMS: Record<string, readonly string[]> = {
  // Parity with `AutonomyMode` (cli/src/services/autonomy-mode.ts) and the
  // TUI settings picker; the persist layer (`pref-helpers.ts`) now
  // round-trips all five modes instead of silently dropping 'eternal' /
  // 'eternal-parallel', and the doctor must accept them too or it would
  // flag a config that the rest of the system happily writes.
  defaultMode: ['off', 'suggest', 'auto', 'eternal', 'eternal-parallel'],
  enhanceLanguage: ['original', 'english'],
};
const AUTONOMY_BOOLEANS = ['enhance'] as const;
const AUTONOMY_DELAYS = ['autoProceedDelayMs', 'enhanceDelayMs'] as const;

// Mirrors ENCRYPTED_PREFIX in core types/secret-vault.ts — vault-encrypted
// values carry this marker; anything else in a secret-named field is plaintext.
const ENC_PREFIX = 'enc:v1:';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function coerceBoolean(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 'on' || v === 1) return true;
  if (v === 'false' || v === 'off' || v === 0) return false;
  return undefined;
}

function coerceNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && !Number.isNaN(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}

export function diagnoseConfig(
  cfg: Record<string, unknown>,
  plugins: PluginSchemaInfo[] = [],
): DoctorReport {
  const fixed = structuredClone(cfg);
  const findings: DoctorFinding[] = [];

  // ── 1. Unknown top-level keys ─────────────────────────────────────────
  // Runs first so a case-typo'd key (e.g. "debugstream") is renamed before
  // the field checks below validate its value.
  for (const key of Object.keys(fixed)) {
    if ((KNOWN_TOP_LEVEL_KEYS as readonly string[]).includes(key)) continue;
    const match = KNOWN_TOP_LEVEL_KEYS.find((k) => k.toLowerCase() === key.toLowerCase());
    if (match && !(match in fixed)) {
      fixed[match] = fixed[key];
      delete fixed[key];
      findings.push({
        path: key,
        problem: `unknown key (did you mean "${match}"?)`,
        severity: 'error',
        fix: `renamed to "${match}"`,
      });
    } else {
      findings.push({
        path: key,
        problem: 'unknown key — left untouched (delete it manually if unwanted)',
        severity: 'warning',
      });
    }
  }

  // ── 2. version ────────────────────────────────────────────────────────
  if ('version' in fixed && fixed['version'] !== 1) {
    findings.push({
      path: 'version',
      problem: `expected 1, got ${JSON.stringify(fixed['version'])}`,
      severity: 'error',
      fix: 'set to 1',
    });
    fixed['version'] = 1;
  }

  // ── 3. Top-level booleans ─────────────────────────────────────────────
  for (const key of BOOLEAN_FIELDS) {
    if (!(key in fixed)) continue;
    const v = fixed[key];
    if (typeof v === 'boolean') continue;
    const coerced = coerceBoolean(v);
    if (coerced !== undefined) {
      fixed[key] = coerced;
      findings.push({
        path: key,
        problem: `expected boolean, got ${JSON.stringify(v)}`,
        severity: 'error',
        fix: `coerced to ${coerced}`,
      });
    } else {
      delete fixed[key];
      findings.push({
        path: key,
        problem: `expected boolean, got ${JSON.stringify(v)}`,
        severity: 'error',
        fix: 'removed (built-in default applies)',
      });
    }
  }

  // ── 4. configScope enum ───────────────────────────────────────────────
  if (
    'configScope' in fixed &&
    fixed['configScope'] !== 'global' &&
    fixed['configScope'] !== 'project'
  ) {
    findings.push({
      path: 'configScope',
      problem: `expected "global" or "project", got ${JSON.stringify(fixed['configScope'])}`,
      severity: 'error',
      fix: 'removed (defaults to global)',
    });
    delete fixed['configScope'];
  }

  // ── 5. maxConcurrent ──────────────────────────────────────────────────
  if ('maxConcurrent' in fixed) {
    const v = fixed['maxConcurrent'];
    const n = coerceNumber(v);
    if (n === undefined) {
      delete fixed['maxConcurrent'];
      findings.push({
        path: 'maxConcurrent',
        problem: `expected a non-negative integer, got ${JSON.stringify(v)}`,
        severity: 'error',
        fix: 'removed (built-in default applies)',
      });
    } else {
      const clamped = Math.max(0, Math.floor(n));
      if (clamped !== v) {
        fixed['maxConcurrent'] = clamped;
        findings.push({
          path: 'maxConcurrent',
          problem: `expected a non-negative integer, got ${JSON.stringify(v)}`,
          severity: 'error',
          fix: `set to ${clamped}`,
        });
      }
    }
  }

  // ── 5b. fallbackMaxLastResortCandidates ──────────────────────────────
  if ('fallbackMaxLastResortCandidates' in fixed) {
    const v = fixed['fallbackMaxLastResortCandidates'];
    const n = coerceNumber(v);
    if (n === undefined) {
      delete fixed['fallbackMaxLastResortCandidates'];
      findings.push({
        path: 'fallbackMaxLastResortCandidates',
        problem: `expected a non-negative number, got ${JSON.stringify(v)}`,
        severity: 'error',
        fix: 'removed (built-in default of 12 applies)',
      });
    } else {
      const clamped = Math.max(0, Math.floor(n));
      if (clamped !== v) {
        fixed['fallbackMaxLastResortCandidates'] = clamped;
        findings.push({
          path: 'fallbackMaxLastResortCandidates',
          problem: `expected a non-negative integer, got ${JSON.stringify(v)}`,
          severity: 'error',
          fix: `set to ${clamped}`,
        });
      } else if (clamped === 0) {
        findings.push({
          path: 'fallbackMaxLastResortCandidates',
          problem: 'is 0 — last-resort auto-discovery append is disabled',
          severity: 'warning',
          fix: 'no change (explicit user choice)',
        });
      }
    }
  }

  // ── 6. fleet.budget numeric ceilings ──────────────────────────────────
  if ('fleet' in fixed) {
    if (!isPlainObject(fixed['fleet'])) {
      findings.push({
        path: 'fleet',
        problem: `expected object, got ${JSON.stringify(fixed['fleet'])}`,
        severity: 'error',
        fix: 'removed (built-in defaults apply)',
      });
      delete fixed['fleet'];
    } else {
      const fleet = fixed['fleet'] as Record<string, unknown>;
      if ('budget' in fleet) {
        if (!isPlainObject(fleet['budget'])) {
          findings.push({
            path: 'fleet.budget',
            problem: `expected object, got ${JSON.stringify(fleet['budget'])}`,
            severity: 'error',
            fix: 'removed (built-in defaults apply)',
          });
          delete fleet['budget'];
        } else {
          const budget = fleet['budget'] as Record<string, unknown>;
          for (const key of ['maxSpawns', 'maxTokens', 'maxCostUsd'] as const) {
            if (!(key in budget)) continue;
            const v = budget[key];
            const n = coerceNumber(v);
            if (n === undefined) {
              delete budget[key];
              findings.push({
                path: `fleet.budget.${key}`,
                problem: `expected a non-negative number, got ${JSON.stringify(v)}`,
                severity: 'error',
                fix: 'removed (built-in default applies)',
              });
            } else {
              const clamped = Math.max(0, n);
              // maxSpawns / maxTokens should be integers; maxCostUsd may be fractional.
              const next = key === 'maxCostUsd' ? clamped : Math.floor(clamped);
              if (next !== v) {
                budget[key] = next;
                findings.push({
                  path: `fleet.budget.${key}`,
                  problem: `expected a non-negative ${key === 'maxCostUsd' ? 'number' : 'integer'}, got ${JSON.stringify(v)}`,
                  severity: 'error',
                  fix: `set to ${next}`,
                });
              }
            }
          }
        }
      }
    }
  }

  // ── 7. provider / model must be strings (no safe auto-fix) ───────────
  for (const key of ['provider', 'model'] as const) {
    if (key in fixed && typeof fixed[key] !== 'string') {
      findings.push({
        path: key,
        problem: `expected string, got ${JSON.stringify(fixed[key])} — set it manually (e.g. /models)`,
        severity: 'error',
      });
    }
  }

  // ── 8. autonomy block ─────────────────────────────────────────────────
  if ('autonomy' in fixed) {
    if (!isPlainObject(fixed['autonomy'])) {
      findings.push({
        path: 'autonomy',
        problem: `expected object, got ${JSON.stringify(fixed['autonomy'])}`,
        severity: 'error',
        fix: 'removed (built-in defaults apply)',
      });
      delete fixed['autonomy'];
    } else {
      const autonomy = fixed['autonomy'];
      for (const [key, allowed] of Object.entries(AUTONOMY_ENUMS)) {
        if (key in autonomy && !allowed.includes(autonomy[key] as string)) {
          findings.push({
            path: `autonomy.${key}`,
            problem: `expected one of ${allowed.join('|')}, got ${JSON.stringify(autonomy[key])}`,
            severity: 'error',
            fix: 'removed (built-in default applies)',
          });
          delete autonomy[key];
        }
      }
      for (const key of AUTONOMY_BOOLEANS) {
        if (!(key in autonomy) || typeof autonomy[key] === 'boolean') continue;
        const coerced = coerceBoolean(autonomy[key]);
        findings.push({
          path: `autonomy.${key}`,
          problem: `expected boolean, got ${JSON.stringify(autonomy[key])}`,
          severity: 'error',
          fix:
            coerced !== undefined ? `coerced to ${coerced}` : 'removed (built-in default applies)',
        });
        if (coerced !== undefined) autonomy[key] = coerced;
        else delete autonomy[key];
      }
      for (const key of AUTONOMY_DELAYS) {
        if (!(key in autonomy)) continue;
        const v = autonomy[key];
        const n = coerceNumber(v);
        if (n === undefined) {
          findings.push({
            path: `autonomy.${key}`,
            problem: `expected a non-negative number (ms), got ${JSON.stringify(v)}`,
            severity: 'error',
            fix: 'removed (built-in default applies)',
          });
          delete autonomy[key];
        } else if (n < 0 || n !== v) {
          const repaired = Math.max(0, Math.round(n));
          findings.push({
            path: `autonomy.${key}`,
            problem: `expected a non-negative number (ms), got ${JSON.stringify(v)}`,
            severity: 'error',
            fix: `set to ${repaired}`,
          });
          autonomy[key] = repaired;
        }
      }
      if ('thinkingWord' in autonomy) {
        const normalized = normalizeTuiThinkingWord(autonomy.thinkingWord);
        if (autonomy.thinkingWord !== normalized) {
          findings.push({
            path: 'autonomy.thinkingWord',
            problem: `expected a single word up to ${MAX_TUI_THINKING_WORD_LENGTH} characters, got ${JSON.stringify(autonomy.thinkingWord)}`,
            severity: 'error',
            fix: 'removed (built-in default applies)',
          });
          delete autonomy.thinkingWord;
        }
      }
    }
  }

  // ── 8. plugins array ──────────────────────────────────────────────────
  if ('plugins' in fixed) {
    if (!Array.isArray(fixed['plugins'])) {
      findings.push({
        path: 'plugins',
        problem: `expected an array, got ${JSON.stringify(fixed['plugins'])}`,
        severity: 'error',
        fix: 'removed',
      });
      delete fixed['plugins'];
    } else {
      const entries = fixed['plugins'] as unknown[];
      const kept: unknown[] = [];
      entries.forEach((entry, i) => {
        if (typeof entry === 'string') {
          kept.push(entry);
          return;
        }
        if (isPlainObject(entry) && typeof entry['name'] === 'string') {
          if ('enabled' in entry && typeof entry['enabled'] !== 'boolean') {
            const coerced = coerceBoolean(entry['enabled']);
            findings.push({
              path: `plugins[${i}].enabled`,
              problem: `expected boolean, got ${JSON.stringify(entry['enabled'])}`,
              severity: 'error',
              fix: coerced !== undefined ? `coerced to ${coerced}` : 'removed',
            });
            if (coerced !== undefined) entry['enabled'] = coerced;
            else delete entry['enabled'];
          }
          if ('options' in entry && !isPlainObject(entry['options'])) {
            findings.push({
              path: `plugins[${i}].options`,
              problem: `expected object, got ${JSON.stringify(entry['options'])}`,
              severity: 'error',
              fix: 'removed',
            });
            delete entry['options'];
          }
          kept.push(entry);
          return;
        }
        findings.push({
          path: `plugins[${i}]`,
          problem: `expected a plugin name or { name, enabled?, options? }, got ${JSON.stringify(entry)}`,
          severity: 'error',
          fix: 'entry removed',
        });
      });
      if (kept.length !== entries.length) fixed['plugins'] = kept;
    }
  }

  // ── 9. pluginManager (human-owned LLM control policy) ────────────────
  if ('pluginManager' in fixed) {
    if (!isPlainObject(fixed['pluginManager'])) {
      findings.push({
        path: 'pluginManager',
        problem: `expected object, got ${JSON.stringify(fixed['pluginManager'])}`,
        severity: 'error',
        fix: 'removed',
      });
      delete fixed['pluginManager'];
    } else {
      const manager = fixed['pluginManager'];
      if ('locked' in manager && !Array.isArray(manager['locked'])) {
        findings.push({
          path: 'pluginManager.locked',
          problem: `expected an array of plugin names, got ${JSON.stringify(manager['locked'])}`,
          severity: 'error',
          fix: 'removed',
        });
        delete manager['locked'];
      } else if (Array.isArray(manager['locked'])) {
        const locked = manager['locked'];
        const cleaned = [
          ...new Set(
            locked
              .filter((entry): entry is string => typeof entry === 'string')
              .map((entry) => entry.trim())
              .filter(Boolean),
          ),
        ];
        if (cleaned.length !== locked.length || cleaned.some((entry, i) => entry !== locked[i])) {
          findings.push({
            path: 'pluginManager.locked',
            problem: 'expected unique, non-empty plugin-name strings',
            severity: 'error',
            fix: 'removed invalid and duplicate entries',
          });
          manager['locked'] = cleaned;
        }
      }
    }
  }

  // ── 10. extensions (plugin config sections) ──────────────────────────
  if ('extensions' in fixed) {
    if (!isPlainObject(fixed['extensions'])) {
      findings.push({
        path: 'extensions',
        problem: `expected an object of per-plugin sections, got ${JSON.stringify(fixed['extensions'])}`,
        severity: 'error',
        fix: 'removed',
      });
      delete fixed['extensions'];
    } else {
      const extensions = fixed['extensions'];
      for (const [name, value] of Object.entries(extensions)) {
        if (!isPlainObject(value)) {
          findings.push({
            path: `extensions.${name}`,
            problem: `expected object, got ${JSON.stringify(value)}`,
            severity: 'error',
            fix: 'removed',
          });
          delete extensions[name];
        }
      }
      // Validate each remaining section against its plugin's configSchema —
      // the exact validation the plugin loader runs before setup(). Invalid
      // options are removed; the plugin's defaultConfig fills the gap at load.
      for (const plugin of plugins) {
        const section = extensions[plugin.name];
        if (!plugin.configSchema || !isPlainObject(section)) continue;
        const result = validateAgainstSchema(section, plugin.configSchema);
        for (const err of result.errors) {
          const prop = err.path.split('.')[0]?.replace(/\[\d+\]$/, '');
          if (prop && prop !== '<root>' && prop in section) {
            findings.push({
              path: `extensions.${plugin.name}.${err.path}`,
              problem: err.message,
              severity: 'error',
              fix: `removed "${prop}" (plugin default applies)`,
            });
            delete section[prop];
          } else {
            findings.push({
              path: `extensions.${plugin.name}${err.path === '<root>' ? '' : `.${err.path}`}`,
              problem: err.message,
              severity: 'error',
            });
          }
        }
      }
    }
  }

  // ── 10. providers — blank ids get a generated custom-N name ──────────
  // JSON object keys are unique, so true duplicates can't survive a parse; a
  // blank or whitespace-only id can (e.g. a custom provider saved before the
  // `/auth` guard existed). Rename it to a non-colliding custom-N so it stops
  // shadowing the "no id" slot and can be selected with --provider. The value
  // (keys, family, baseUrl, …) is preserved — a provider entry may hold
  // credentials, so we rename rather than drop it.
  if ('providers' in fixed) {
    if (!isPlainObject(fixed['providers'])) {
      findings.push({
        path: 'providers',
        problem: `expected an object of provider entries, got ${JSON.stringify(fixed['providers'])} — set it manually`,
        severity: 'error',
      });
    } else {
      const providers = fixed['providers'];
      const blanks = Object.keys(providers).filter((k) => k.trim() === '');
      if (blanks.length > 0) {
        const taken = new Set(Object.keys(providers).filter((k) => k.trim() !== ''));
        for (const blank of blanks) {
          const name = nextCustomProviderId(taken);
          taken.add(name);
          providers[name] = providers[blank];
          delete providers[blank];
          findings.push({
            path: `providers.${blank === '' ? '(empty)' : JSON.stringify(blank)}`,
            problem: 'provider id is blank',
            severity: 'error',
            fix: `renamed to "${name}"`,
          });
        }
      }
    }
  }

  // ── 11. Plaintext secret scan (warning only — never rewrites values) ──
  scanPlaintextSecrets(fixed, '', findings);

  const changed = JSON.stringify(fixed) !== JSON.stringify(cfg);
  return { findings, fixed, changed };
}

function scanPlaintextSecrets(node: unknown, prefix: string, findings: DoctorFinding[]): void {
  if (!isPlainObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      if (value.length > 0 && isSecretField(key) && !value.startsWith(ENC_PREFIX)) {
        findings.push({
          path,
          problem:
            'looks like a plaintext secret (not vault-encrypted) — it will be encrypted on next boot',
          severity: 'warning',
        });
      }
    } else if (isPlainObject(value)) {
      scanPlaintextSecrets(value, path, findings);
    }
  }
}
