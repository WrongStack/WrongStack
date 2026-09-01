import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as TS from '@typescript/typescript6';
import { atomicWrite } from '@wrongstack/core/utils';
import { type InvariantViolation, polyglotInvariantEngine } from './ast-invariant-engine.js';
import { enqueueReindex } from './background-indexer.js';
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

export interface MutateSymbolOptions {
  file: string;
  symbol: string;
  newBody: string;
  target?: 'body' | 'full' | undefined;
  checkInvariants?: boolean | undefined;
  allowBreakingChanges?: boolean | undefined;
}

export interface MutateSymbolResult {
  file: string;
  symbol: string;
  originalRange: { startLine: number; endLine: number };
  newRange: { startLine: number; endLine: number };
  updatedContent: string;
  violations?: InvariantViolation[] | undefined;
}

/**
 * Replace a symbol's body or full declaration using TypeScript Compiler AST.
 */
async function mutateTsSymbol(
  content: string,
  lang: SymbolLang,
  symbolName: string,
  newBody: string,
  target: 'body' | 'full' = 'body',
): Promise<MutateSymbolResult | null> {
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
    lang === 'tsx' ? 'temp.tsx' : 'temp.ts',
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );

  let targetNode: TS.Node | null = null;
  let bodyNode: TS.Node | null = null;

  function visit(node: TS.Node) {
    if (targetNode) return;

    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessor(node) ||
      ts.isSetAccessor(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node)
    ) {
      let name: string | undefined;
      if ('name' in node && node.name && ts.isIdentifier(node.name as TS.Node)) {
        name = (node.name as TS.Identifier).text;
      }

      if (name === symbolName) {
        targetNode = node;
        if ('body' in node && node.body) {
          bodyNode = node.body as TS.Node;
        }
        return;
      }
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === symbolName) {
          targetNode = decl;
          if (
            decl.initializer &&
            (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
          ) {
            bodyNode = decl.initializer.body;
          }
          return;
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);

  if (!targetNode) return null;

  const replaceTarget: TS.Node = target === 'full' || !bodyNode ? targetNode : bodyNode;
  const startPos = replaceTarget.getStart(sourceFile);
  const endPos = replaceTarget.getEnd();

  const startLine = sourceFile.getLineAndCharacterOfPosition(startPos).line + 1;
  const endLine = sourceFile.getLineAndCharacterOfPosition(endPos).line + 1;

  // Format new body
  let formattedReplacement = newBody.trim();
  if (target === 'body' && bodyNode && ts.isBlock(bodyNode)) {
    if (!formattedReplacement.startsWith('{')) {
      formattedReplacement = `{\n  ${formattedReplacement.split('\n').join('\n  ')}\n}`;
    }
  }

  const updatedContent = content.slice(0, startPos) + formattedReplacement + content.slice(endPos);
  const newEndLine = startLine + formattedReplacement.split('\n').length - 1;

  return {
    file: '',
    symbol: symbolName,
    originalRange: { startLine, endLine },
    newRange: { startLine, endLine: newEndLine },
    updatedContent,
  };
}

/**
 * Replace a symbol's body or full declaration using Tree-Sitter AST.
 */
async function mutateTreeSitterSymbol(
  content: string,
  lang: SymbolLang,
  symbolName: string,
  newBody: string,
  target: 'body' | 'full' = 'body',
): Promise<MutateSymbolResult | null> {
  const parsed = await parseTreeSitterAst({ content, lang });
  if (!parsed) return null;

  const { tree, parser } = parsed;

  try {
    const root = tree.rootNode;
    let targetNode: import('web-tree-sitter').Node | null = null;
    let bodyNode: import('web-tree-sitter').Node | null = null;

    function walk(node: import('web-tree-sitter').Node) {
      if (targetNode) return;

      const nameNode = node.childForFieldName('name') ?? node.childForFieldName('declarator');
      if (nameNode && nameNode.text === symbolName) {
        targetNode = node;
        bodyNode =
          node.childForFieldName('body') ??
          node.children.find((c) =>
            [
              'compound_statement',
              'statement_block',
              'block',
              'function_body',
              'body_statement',
              'code_block',
              'do_block',
            ].includes(c.type),
          ) ??
          null;
        return;
      }

      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) walk(child);
      }
    }

    walk(root);

    if (!targetNode) return null;

    const replaceTarget: import('web-tree-sitter').Node =
      target === 'full' || !bodyNode ? targetNode : bodyNode;
    const startPos = replaceTarget.startIndex;
    const endPos = replaceTarget.endIndex;

    const startLine = replaceTarget.startPosition.row + 1;
    const endLine = replaceTarget.endPosition.row + 1;

    let formattedReplacement = newBody.trim();
    if (target === 'body' && lang === 'py') {
      const indent = '    ';
      formattedReplacement = formattedReplacement
        .split('\n')
        .map((l) => (l.trim() ? `${indent}${l}` : ''))
        .join('\n');
    }

    const updatedContent =
      content.slice(0, startPos) + formattedReplacement + content.slice(endPos);
    const newEndLine = startLine + formattedReplacement.split('\n').length - 1;

    return {
      file: '',
      symbol: symbolName,
      originalRange: { startLine, endLine },
      newRange: { startLine, endLine: newEndLine },
      updatedContent,
    };
  } finally {
    tree.delete();
    parser.delete();
  }
}

/**
 * Surgically replace a symbol's body or definition inside a source file.
 */
export async function replaceSymbolInFile(
  opts: MutateSymbolOptions,
  projectRoot: string,
): Promise<MutateSymbolResult> {
  // Path containment (safeResolveReal) is applied by the tool layer
  // (codebase-ast-replace-tool.ts) BEFORE this call, so `opts.file` arrives
  // canonical and absolute here; the fallback below only serves direct
  // callers (tests) that pass relative paths.
  const resolved = path.isAbsolute(opts.file) ? opts.file : path.resolve(projectRoot, opts.file);

  const content = await fs.readFile(resolved, 'utf8');
  const lang = detectLang(resolved) ?? 'other';

  let result: MutateSymbolResult | null = null;

  if (['ts', 'tsx', 'js', 'jsx'].includes(lang)) {
    result = await mutateTsSymbol(content, lang, opts.symbol, opts.newBody, opts.target);
  } else {
    result = await mutateTreeSitterSymbol(content, lang, opts.symbol, opts.newBody, opts.target);
  }

  if (!result) {
    throw new Error(
      `Symbol '${opts.symbol}' could not be located in AST of '${path.relative(projectRoot, resolved)}'`,
    );
  }

  result.file = resolved;

  if (opts.checkInvariants !== false) {
    const inv = await polyglotInvariantEngine.evaluate({
      originalCode: content,
      modifiedCode: result.updatedContent,
      lang,
      filePath: resolved,
    });

    if (!inv.valid && !opts.allowBreakingChanges) {
      const summary = inv.violations.map((v) => `[${v.ruleId}] ${v.message}`).join('\n');
      throw new Error(
        `AST Invariant Violation: Mutating '${opts.symbol}' introduces breaking changes:\n${summary}\nPass allowBreakingChanges: true if this breaking change is intended.`,
      );
    }
    result.violations = inv.violations;
  }

  await atomicWrite(resolved, result.updatedContent);

  try {
    enqueueReindex({ projectRoot, files: [resolved] });
  } catch {
    // Non-fatal background reindex
  }

  return result;
}
