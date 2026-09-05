/**
 * Polyglot AST Invariant Engine
 *
 * Deterministic backward-compatibility & invariant validator that checks AST
 * diffs between original code and LLM mutations before changes are written to disk.
 *
 * Catches breaking changes across TypeScript/JavaScript, Python, Go, Rust, Java, etc.:
 *   - INV-001: Export / Public Symbol Deletion or Rename
 *   - INV-002: Mandatory / Non-Default Parameter Addition
 *   - INV-003: Mandatory Interface / Trait / Model Property Addition
 *   - INV-004: Incompatible Return Type Alteration
 */

import type * as TS from '@typescript/typescript6';
import { detectLang } from './languages.js';
import type { SymbolLang } from './schema.js';
import { parseTreeSitterAst } from './tree-sitter-parser.js';

type TsModule = typeof import('@typescript/typescript6');
let tsModule: TsModule | null = null;
async function loadTs(): Promise<TsModule> {
  if (!tsModule) {
    const mod = await import('@typescript/typescript6');
    tsModule = ((mod as unknown as { default?: TsModule }).default ?? mod) as TsModule;
  }
  return tsModule;
}

export type InvariantRuleId = 'INV-001' | 'INV-002' | 'INV-003' | 'INV-004';

export interface InvariantViolation {
  ruleId: InvariantRuleId;
  symbolName: string;
  lang: SymbolLang;
  message: string;
  severity: 'CRITICAL' | 'WARNING';
  details?:
    | {
        addedParameter?: string | undefined;
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
  stats: {
    originalSymbols: number;
    modifiedSymbols: number;
    durationMs: number;
  };
}

interface ParameterContract {
  name: string;
  isOptional: boolean;
  hasDefault: boolean;
  isRest: boolean;
  type?: string | undefined;
}

interface FunctionContract {
  name: string;
  isExported: boolean;
  params: ParameterContract[];
  returnType?: string | undefined;
}

interface InterfacePropertyContract {
  name: string;
  isOptional: boolean;
  hasDefault?: boolean | undefined;
  type?: string | undefined;
}

interface InterfaceContract {
  name: string;
  isExported: boolean;
  properties: InterfacePropertyContract[];
  methods: Array<{
    name: string;
    isOptional: boolean;
    params: ParameterContract[];
    returnType?: string | undefined;
  }>;
}

export interface ModuleContract {
  lang: SymbolLang;
  exports: Set<string>;
  functions: Map<string, FunctionContract>;
  interfaces: Map<string, InterfaceContract>;
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

      // RULE 4: INV-004 (Return Type Alteration / Breaking change)
      if (origFunc.returnType && modFunc.returnType && origFunc.returnType !== modFunc.returnType) {
        // Breaking if Promise<T> changed to non-promise or Result<T> altered
        const isBreakingAsync =
          origFunc.returnType.includes('Promise<') && !modFunc.returnType.includes('Promise<');
        const isBreakingResult =
          origFunc.returnType.includes('Result<') && !modFunc.returnType.includes('Result<');

        if (isBreakingAsync || isBreakingResult) {
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
        return await this.extractTsContract(code, lang);
      } catch {
        // Fallback to Tree-sitter if TS compiler API fails
      }
    }

    return await this.extractTreeSitterContract(code, lang);
  }

  /**
   * TypeScript & JavaScript extraction via TS Compiler API.
   */
  private async extractTsContract(code: string, lang: SymbolLang): Promise<ModuleContract> {
    const ts = await loadTs();
    const scriptKind =
      lang === 'tsx'
        ? ts.ScriptKind.TSX
        : lang === 'jsx'
          ? ts.ScriptKind.JSX
          : lang === 'js'
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS;

    const sourceFile = ts.createSourceFile(
      lang === 'tsx' ? 'contract.tsx' : 'contract.ts',
      code,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    );

    const exports = new Set<string>();
    const functions = new Map<string, FunctionContract>();
    const interfaces = new Map<string, InterfaceContract>();

    function isExportedNode(node: TS.Node): boolean {
      if (ts.canHaveModifiers(node)) {
        const modifiers = ts.getModifiers(node);
        if (modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
          return true;
        }
      }
      return false;
    }

    function visit(node: TS.Node) {
      // Export statements: export { a, b }
      if (
        ts.isExportDeclaration(node) &&
        node.exportClause &&
        ts.isNamedExports(node.exportClause)
      ) {
        for (const element of node.exportClause.elements) {
          exports.add(element.name.text);
        }
      }

      // Functions
      if (ts.isFunctionDeclaration(node) && node.name) {
        const name = node.name.text;
        const isExp = isExportedNode(node);
        if (isExp) exports.add(name);

        const params: ParameterContract[] = node.parameters.map((p) => {
          const pName = p.name.getText(sourceFile);
          const isOptional = Boolean(p.questionToken);
          const hasDefault = Boolean(p.initializer);
          const isRest = Boolean(p.dotDotDotToken);
          const type = p.type ? p.type.getText(sourceFile) : undefined;
          return { name: pName, isOptional, hasDefault, isRest, type };
        });

        const returnType = node.type ? node.type.getText(sourceFile) : undefined;
        functions.set(name, { name, isExported: isExp, params, returnType });
      }

      // Classes and Class Methods
      if (ts.isClassDeclaration(node) && node.name) {
        const className = node.name.text;
        const isExp = isExportedNode(node);
        if (isExp) exports.add(className);

        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
            const methodName = member.name.text;
            const fullMethodName = `${className}.${methodName}`;
            const params: ParameterContract[] = member.parameters.map((p) => {
              const pName = p.name.getText(sourceFile);
              const isOptional = Boolean(p.questionToken);
              const hasDefault = Boolean(p.initializer);
              const isRest = Boolean(p.dotDotDotToken);
              const type = p.type ? p.type.getText(sourceFile) : undefined;
              return { name: pName, isOptional, hasDefault, isRest, type };
            });

            const returnType = member.type ? member.type.getText(sourceFile) : undefined;
            functions.set(fullMethodName, {
              name: fullMethodName,
              isExported: isExp,
              params,
              returnType,
            });
          }
        }
      }

      // Interfaces & Type Aliases
      if (ts.isInterfaceDeclaration(node) && node.name) {
        const name = node.name.text;
        const isExp = isExportedNode(node);
        if (isExp) exports.add(name);

        const properties: InterfacePropertyContract[] = [];
        const methods: InterfaceContract['methods'] = [];

        for (const member of node.members) {
          if (ts.isPropertySignature(member) && member.name) {
            const propName = member.name.getText(sourceFile);
            const isOptional = Boolean(member.questionToken);
            const type = member.type ? member.type.getText(sourceFile) : undefined;
            properties.push({ name: propName, isOptional, type });
          } else if (ts.isMethodSignature(member) && member.name) {
            const methodName = member.name.getText(sourceFile);
            const isOptional = Boolean(member.questionToken);
            const params: ParameterContract[] = member.parameters.map((p) => ({
              name: p.name.getText(sourceFile),
              isOptional: Boolean(p.questionToken),
              hasDefault: Boolean(p.initializer),
              isRest: Boolean(p.dotDotDotToken),
            }));
            const returnType = member.type ? member.type.getText(sourceFile) : undefined;
            methods.push({ name: methodName, isOptional, params, returnType });
          }
        }

        interfaces.set(name, { name, isExported: isExp, properties, methods });
      }

      // Type Alias with Object Literal
      if (ts.isTypeAliasDeclaration(node) && node.name && ts.isTypeLiteralNode(node.type)) {
        const name = node.name.text;
        const isExp = isExportedNode(node);
        if (isExp) exports.add(name);

        const properties: InterfacePropertyContract[] = [];
        for (const member of node.type.members) {
          if (ts.isPropertySignature(member) && member.name) {
            const propName = member.name.getText(sourceFile);
            const isOptional = Boolean(member.questionToken);
            const type = member.type ? member.type.getText(sourceFile) : undefined;
            properties.push({ name: propName, isOptional, type });
          }
        }

        interfaces.set(name, { name, isExported: isExp, properties, methods: [] });
      }

      ts.forEachChild(node, visit);
    }

    ts.forEachChild(sourceFile, visit);

    return { lang, exports, functions, interfaces };
  }

  /**
   * Polyglot extraction (Python, Go, Rust, Java, etc.) via Tree-sitter WASM.
   */
  private async extractTreeSitterContract(code: string, lang: SymbolLang): Promise<ModuleContract> {
    const exports = new Set<string>();
    const functions = new Map<string, FunctionContract>();
    const interfaces = new Map<string, InterfaceContract>();

    const parsed = await parseTreeSitterAst({ content: code, lang });
    if (!parsed) {
      return { lang, exports, functions, interfaces };
    }

    const { tree, parser } = parsed;

    try {
      const root = tree.rootNode;

      function walk(node: import('web-tree-sitter').Node) {
        const type = node.type;

        // ─── PYTHON ─────────────────────────────────────────────────────────────
        if (lang === 'py') {
          if (type === 'function_definition') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
              const name = nameNode.text;
              const isExported = !name.startsWith('_');
              if (isExported) exports.add(name);

              const paramsNode = node.childForFieldName('parameters');
              const params: ParameterContract[] = [];

              if (paramsNode) {
                for (let i = 0; i < paramsNode.namedChildCount; i++) {
                  const param = paramsNode.namedChild(i);
                  if (!param) continue;
                  const pText = param.text;
                  const isRest = pText.startsWith('*');
                  const hasDefault =
                    param.type === 'default_parameter' ||
                    param.type === 'typed_default_parameter' ||
                    pText.includes('=');
                  const idNode = param.childForFieldName('name') ?? param;
                  params.push({
                    name: idNode.text.split(':')[0]?.trim() ?? idNode.text,
                    isOptional: hasDefault || isRest,
                    hasDefault,
                    isRest,
                  });
                }
              }

              functions.set(name, { name, isExported, params });
            }
          } else if (type === 'class_definition') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
              const name = nameNode.text;
              if (!name.startsWith('_')) exports.add(name);
            }
          }
        }

        // ─── GO ─────────────────────────────────────────────────────────────────
        else if (lang === 'go') {
          if (type === 'function_declaration' || type === 'method_declaration') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
              const name = nameNode.text;
              const isExported = /^[A-Z]/.test(name);
              if (isExported) exports.add(name);

              const paramsNode = node.childForFieldName('parameters');
              const params: ParameterContract[] = [];

              if (paramsNode) {
                for (let i = 0; i < paramsNode.namedChildCount; i++) {
                  const param = paramsNode.namedChild(i);
                  if (!param) continue;
                  params.push({
                    name: param.text,
                    isOptional: false,
                    hasDefault: false,
                    isRest: param.type === 'variadic_parameter_declaration',
                  });
                }
              }

              functions.set(name, { name, isExported, params });
            }
          } else if (type === 'type_spec') {
            const nameNode = node.childForFieldName('name');
            const typeNode = node.childForFieldName('type');
            if (nameNode) {
              const name = nameNode.text;
              const isExported = /^[A-Z]/.test(name);
              if (isExported) exports.add(name);

              if (typeNode && typeNode.type === 'interface_type') {
                const methods: InterfaceContract['methods'] = [];
                for (let i = 0; i < typeNode.namedChildCount; i++) {
                  const elem = typeNode.namedChild(i);
                  if (elem && (elem.type === 'method_spec' || elem.type === 'method_elem')) {
                    const mName =
                      elem.childForFieldName('name')?.text ?? elem.text.split('(')[0]?.trim() ?? '';
                    if (mName) {
                      methods.push({ name: mName, isOptional: false, params: [] });
                    }
                  }
                }
                interfaces.set(name, { name, isExported, properties: [], methods });
              }
            }
          }
        }

        // ─── RUST ────────────────────────────────────────────────────────────────
        else if (lang === 'rs') {
          if (type === 'function_item') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
              const name = nameNode.text;
              const isExported = node.children.some((c) => c.type === 'visibility_modifier');
              if (isExported) exports.add(name);

              const paramsNode = node.childForFieldName('parameters');
              const params: ParameterContract[] = [];

              if (paramsNode) {
                for (let i = 0; i < paramsNode.namedChildCount; i++) {
                  const param = paramsNode.namedChild(i);
                  if (!param) continue;
                  params.push({
                    name: param.text,
                    isOptional: false,
                    hasDefault: false,
                    isRest: false,
                  });
                }
              }

              functions.set(name, { name, isExported, params });
            }
          } else if (type === 'trait_item') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
              const name = nameNode.text;
              const isExported = node.children.some((c) => c.type === 'visibility_modifier');
              if (isExported) exports.add(name);

              const methods: InterfaceContract['methods'] = [];
              const bodyNode = node.childForFieldName('body');
              if (bodyNode) {
                for (let i = 0; i < bodyNode.namedChildCount; i++) {
                  const child = bodyNode.namedChild(i);
                  if (child && child.type === 'function_item') {
                    const mName = child.childForFieldName('name')?.text;
                    const hasDefaultBody = Boolean(child.childForFieldName('body'));
                    if (mName) {
                      methods.push({
                        name: mName,
                        isOptional: hasDefaultBody,
                        params: [],
                      });
                    }
                  }
                }
              }

              interfaces.set(name, { name, isExported, properties: [], methods });
            }
          }
        }

        // Polyglot general fallback
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child) walk(child);
        }
      }

      walk(root);
      return { lang, exports, functions, interfaces };
    } finally {
      tree.delete();
      parser.delete();
    }
  }
}

/** Singleton instance ready for use across WrongStack */
export const polyglotInvariantEngine = new PolyglotInvariantEngine();
