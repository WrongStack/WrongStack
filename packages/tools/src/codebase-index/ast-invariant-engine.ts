/**
 * Polyglot AST Invariant Engine
 *
 * Deterministic backward-compatibility & invariant validator that checks AST
 * diffs between original code and LLM mutations before changes are written to disk.
 *
 * Rules are implemented for TypeScript/JavaScript, Python, Go and Rust:
 *   - INV-001: Export / Public Symbol Deletion or Rename
 *   - INV-002: Mandatory / Non-Default Parameter Addition
 *   - INV-003: Mandatory Interface / Trait / Model Property Addition
 *   - INV-004: Incompatible Return Type Alteration
 *   - INV-005: Positional Parameter Removal (callers still pass it)
 *
 * Any other language has no contract extractor: the result says so through
 * `supported: false` instead of reporting an empty diff as "compatible".
 */

import {
  extractTreeSitterContract,
  extractTsContract,
  type ModuleContract,
} from './ast-invariant-contracts.js';
import { detectLang } from './languages.js';
import type { SymbolLang } from './schema.js';

export type { ModuleContract } from './ast-invariant-contracts.js';

export type InvariantRuleId = 'INV-001' | 'INV-002' | 'INV-003' | 'INV-004' | 'INV-005';

export interface InvariantViolation {
  ruleId: InvariantRuleId;
  symbolName: string;
  lang: SymbolLang;
  message: string;
  severity: 'CRITICAL' | 'WARNING';
  details?:
    | {
        addedParameter?: string | undefined;
        removedParameter?: string | undefined;
        addedProperty?: string | undefined;
        expectedModifier?: string | undefined;
        originalSignature?: string | undefined;
        modifiedSignature?: string | undefined;
      }
    | undefined;
}

export interface InvariantEvaluationResult {
  valid: boolean;
  violations: InvariantViolation[];
  /** Language the rules were evaluated as. */
  lang: SymbolLang;
  /**
   * False when no contract extractor exists for `lang` (or its grammar failed
   * to load). `valid: true` then means "nothing was checked", not "compatible".
   */
  supported: boolean;
  stats: {
    originalSymbols: number;
    modifiedSymbols: number;
    durationMs: number;
  };
}

/**
 * True when every alternative of `modified` already appears in `original`'s
 * union — the function now returns a subset of what callers handle. Anything
 * else (`number` → `string`, a new `| undefined`) can reach a caller that does
 * not expect it. Only Promise/Result removal used to count, so `number` →
 * `string` passed as "compatible".
 */
function returnTypeNarrows(original: string, modified: string): boolean {
  const compactOriginal = original.replace(/\s+/g, '');
  const compactModified = modified.replace(/\s+/g, '');
  // Callers of a `void` function ignore the result, so any new type is safe.
  if (compactOriginal === 'void') return true;
  // `Promise<A | B>` → `Promise<A>` narrows the resolved value; compare inside.
  const promised = (t: string) => /^Promise<(.+)>$/.exec(t)?.[1];
  const innerOriginal = promised(compactOriginal);
  const innerModified = promised(compactModified);
  if (innerOriginal !== undefined && innerModified !== undefined) {
    return returnTypeNarrows(innerOriginal, innerModified);
  }
  const members = (t: string) =>
    new Set(
      splitTopLevelUnion(t.replace(/\s+/g, ''))
        .map((m) => m.replace(/^Array<(.+)>$/, '$1[]'))
        .filter(Boolean),
    );
  const before = members(original);
  for (const m of members(modified)) if (!before.has(m)) return false;
  return true;
}

function splitTopLevelUnion(type: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of type) {
    if ('<([{'.includes(ch)) depth++;
    else if ('>)]}'.includes(ch)) depth--;
    if (ch === '|' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/**
 * Universal AST Invariant Engine for deterministic backward compatibility validation.
 */
export class PolyglotInvariantEngine {
  /**
   * Evaluate whether a code mutation respects backward compatibility invariants.
   */
  public async evaluate(opts: {
    originalCode: string;
    modifiedCode: string;
    lang?: SymbolLang | undefined;
    filePath?: string | undefined;
  }): Promise<InvariantEvaluationResult> {
    const startMs = Date.now();
    const detected = opts.filePath ? detectLang(opts.filePath) : null;
    const lang: SymbolLang = opts.lang ?? detected ?? 'ts';

    const [origContract, modContract] = await Promise.all([
      this.extractContract(opts.originalCode, lang),
      this.extractContract(opts.modifiedCode, lang),
    ]);

    const violations: InvariantViolation[] = [];

    // RULE 1: INV-001 (Export / Public Symbol Deletion or Rename)
    for (const exp of origContract.exports) {
      if (!modContract.exports.has(exp)) {
        violations.push({
          ruleId: 'INV-001',
          symbolName: exp,
          lang,
          severity: 'CRITICAL',
          message: `Public/exported symbol '${exp}' was deleted or renamed in ${lang.toUpperCase()}. Dependent modules or consumers will break.`,
        });
      }
    }

    // RULE 2: INV-002 (Mandatory Parameter Addition)
    for (const [name, origFunc] of origContract.functions) {
      const modFunc = modContract.functions.get(name);
      if (!modFunc) continue; // Deleted function is caught by INV-001 if exported

      const origRequired = origFunc.params.filter(
        (p) => !p.isOptional && !p.hasDefault && !p.isRest,
      );
      const modRequired = modFunc.params.filter((p) => !p.isOptional && !p.hasDefault && !p.isRest);

      // In Go or Rust, any new parameter to an existing signature is breaking
      if (lang === 'go' || lang === 'rs') {
        if (modFunc.params.length > origFunc.params.length) {
          const addedParam = modFunc.params[origFunc.params.length];
          violations.push({
            ruleId: 'INV-002',
            symbolName: name,
            lang,
            severity: 'CRITICAL',
            message: `Function/method '${name}' in ${lang.toUpperCase()} had new parameter ('${addedParam?.name ?? 'param'}') added. In ${lang.toUpperCase()}, signatures cannot take optional parameters without breaking all existing callers. Introduce a new function or options struct instead.`,
            details: {
              addedParameter: addedParam?.name,
            },
          });
        }
      } else if (modRequired.length > origRequired.length) {
        const addedReq =
          modFunc.params.find(
            (p, i) => !p.isOptional && !p.hasDefault && !p.isRest && i >= origRequired.length,
          ) ?? modRequired[modRequired.length - 1];

        violations.push({
          ruleId: 'INV-002',
          symbolName: name,
          lang,
          severity: 'CRITICAL',
          message: `Function '${name}' had new mandatory parameter ('${addedReq?.name}') added. For backward compatibility, make it optional (e.g. '?', default value '= value', or '*args/**kwargs').`,
          details: {
            addedParameter: addedReq?.name,
          },
        });
      }

      // RULE 5: INV-005 (Positional parameter removal). A caller that passes
      // the dropped argument stops compiling (TS: "Expected 1 arguments, but
      // got 2"; Go/Rust/Java/C#) or raises (Python TypeError). Plain JS ignores
      // extra arguments, so it is exempt. A rest parameter still accepts them.
      // Exported API only: a private helper's callers are in this file, where
      // the type checker reports them, and ast-replace refuses on violations.
      const removed = origFunc.params.slice(modFunc.params.length);
      if (
        origFunc.isExported &&
        lang !== 'js' &&
        lang !== 'jsx' &&
        removed.length > 0 &&
        !removed.every((p) => p.isRest) &&
        !modFunc.params.some((p) => p.isRest)
      ) {
        violations.push({
          ruleId: 'INV-005',
          symbolName: name,
          lang,
          severity: 'CRITICAL',
          message: `Function '${name}' dropped parameter(s) ${removed.map((p) => `'${p.name}'`).join(', ')}. Callers that still pass them will fail; keep the parameter (unused, or optional) or update every call site.`,
          details: { removedParameter: removed.map((p) => p.name).join(', ') },
        });
      }

      // RULE 4: INV-004 (Return Type Alteration / Breaking change)
      if (origFunc.returnType && modFunc.returnType && origFunc.returnType !== modFunc.returnType) {
        // Breaking if Promise<T> changed to non-promise or Result<T> altered
        const isBreakingAsync =
          origFunc.returnType.includes('Promise<') && !modFunc.returnType.includes('Promise<');
        const isBreakingResult =
          origFunc.returnType.includes('Result<') && !modFunc.returnType.includes('Result<');

        if (
          isBreakingAsync ||
          isBreakingResult ||
          (origFunc.isExported && !returnTypeNarrows(origFunc.returnType, modFunc.returnType))
        ) {
          violations.push({
            ruleId: 'INV-004',
            symbolName: name,
            lang,
            severity: 'CRITICAL',
            message: `Return type of '${name}' changed incompatibly from '${origFunc.returnType}' to '${modFunc.returnType}'. Callers awaiting or unpacking results will fail.`,
            details: {
              originalSignature: origFunc.returnType,
              modifiedSignature: modFunc.returnType,
            },
          });
        }
      }
    }

    // RULE 3: INV-003 (Mandatory Interface / Trait / Model Property Addition)
    for (const [name, origIface] of origContract.interfaces) {
      const modIface = modContract.interfaces.get(name);
      if (!modIface) continue;

      const origPropNames = new Set(origIface.properties.map((p) => p.name));

      for (const prop of modIface.properties) {
        if (!origPropNames.has(prop.name) && !prop.isOptional && !prop.hasDefault) {
          violations.push({
            ruleId: 'INV-003',
            symbolName: `${name}.${prop.name}`,
            lang,
            severity: 'CRITICAL',
            message: `Interface/model '${name}' had new mandatory property ('${prop.name}') added. All implementations and mock objects will break. Mark it optional ('${prop.name}?') or provide a default value.`,
            details: {
              addedProperty: prop.name,
            },
          });
        }
      }

      // Check interface methods (e.g. in Go/Rust/Java/TS)
      const origMethodNames = new Set(origIface.methods.map((m) => m.name));
      for (const method of modIface.methods) {
        if (!origMethodNames.has(method.name) && !method.isOptional) {
          violations.push({
            ruleId: 'INV-003',
            symbolName: `${name}.${method.name}()`,
            lang,
            severity: 'CRITICAL',
            message: `Interface/trait '${name}' had new mandatory method ('${method.name}') added. Existing implementors will fail to compile.`,
            details: {
              addedProperty: method.name,
            },
          });
        }
      }
    }

    const durationMs = Date.now() - startMs;
    return {
      valid: violations.length === 0,
      violations,
      lang,
      supported: origContract.supported && modContract.supported,
      stats: {
        originalSymbols: origContract.functions.size + origContract.interfaces.size,
        modifiedSymbols: modContract.functions.size + modContract.interfaces.size,
        durationMs,
      },
    };
  }

  /**
   * Extract high-level contract signatures from source code.
   */
  public async extractContract(code: string, lang: SymbolLang): Promise<ModuleContract> {
    if (['ts', 'tsx', 'js', 'jsx'].includes(lang)) {
      try {
        return await extractTsContract(code, lang);
      } catch {
        // Fallback to Tree-sitter if TS compiler API fails
      }
    }

    return await extractTreeSitterContract(code, lang);
  }
}

/** Singleton instance ready for use across WrongStack */
export const polyglotInvariantEngine = new PolyglotInvariantEngine();
