/**
 * Skeleton Extractor — High-speed AST-based file outline and body reduction.
 *
 * Strips function, method, and class implementations while preserving
 * signatures, type definitions, imports, and docstrings. Achieves 70–90%
 * token reduction for LLM context injection and repository understanding.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as TS from '@typescript/typescript6';
import { detectLang, isIndexablePath } from './languages.js';
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

export interface SkeletonSymbolRange {
  name?: string | undefined;
  kind?: string | undefined;
  startLine: number;
  endLine: number;
  bodyStartLine?: number | undefined;
  bodyEndLine?: number | undefined;
}

export interface SkeletonOptions {
  /** Keep JSDoc / docstring comments. Defaults to true. */
  includeDocs?: boolean | undefined;
  /** Collapse multi-line import blocks into a single summary line. Defaults to false. */
  collapseImports?: boolean | undefined;
  /** Keep only exported / public declarations. Defaults to false. */
  exportsOnly?: boolean | undefined;
  /** Include original start-end line numbers in stripped block comments (e.g. L32-L45). Defaults to true. */
  includeLineNumbers?: boolean | undefined;
  /** Maximum recursion depth for nested scopes. */
  maxDepth?: number | undefined;
}

export interface FileSkeletonResult {
  file: string;
  lang: SymbolLang;
  skeleton: string;
  symbols?: SkeletonSymbolRange[] | undefined;
  stats: {
    originalLines: number;
    skeletonLines: number;
    tokenSavingsPercent: number;
    symbolCount: number;
  };
}

interface Replacement {
  start: number;
  end: number;
  text: string;
}

/**
 * Apply non-overlapping replacements to source text from beginning to end.
 */
function applyReplacements(content: string, replacements: Replacement[]): string {
  if (replacements.length === 0) return content;

  // Sort by start ascending
  const sorted = [...replacements].sort((a, b) => a.start - b.start);
  let result = '';
  let lastIndex = 0;

  for (const r of sorted) {
    if (r.start < lastIndex) {
      // Overlapping with previously replaced block; skip inner replacement
      continue;
    }
    result += content.slice(lastIndex, r.start);
    result += r.text;
    lastIndex = r.end;
  }

  result += content.slice(lastIndex);
  return result;
}

/**
 * Extract skeleton for TypeScript and JavaScript files via TypeScript Compiler API.
 */
async function extractTsSkeleton(
  content: string,
  lang: SymbolLang,
  opts: SkeletonOptions,
): Promise<{ skeleton: string; symbolCount: number; symbols: SkeletonSymbolRange[] }> {
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

  const replacements: Replacement[] = [];
  const symbolRanges: SkeletonSymbolRange[] = [];
  let symbolCount = 0;
  const includeLineNumbers = opts.includeLineNumbers ?? true;

  function isExported(node: TS.Node): boolean {
    if (!ts.canHaveModifiers(node)) return false;
    const modifiers = ts.getModifiers(node);
    return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  }

  function visit(node: TS.Node, depth: number) {
    if (opts.maxDepth !== undefined && depth > opts.maxDepth) {
      return;
    }

    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessor(node) ||
      ts.isSetAccessor(node)
    ) {
      symbolCount++;
      if (opts.exportsOnly && depth === 0 && !isExported(node)) {
        replacements.push({
          start: node.getStart(sourceFile),
          end: node.getEnd(),
          text: '',
        });
        return;
      }

      const nodeStart =
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const nodeEnd = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      let bodyStart: number | undefined;
      let bodyEnd: number | undefined;

      if (node.body && ts.isBlock(node.body)) {
        const start = node.body.getStart(sourceFile);
        const end = node.body.getEnd();
        bodyStart = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
        bodyEnd = sourceFile.getLineAndCharacterOfPosition(end).line + 1;

        const hasLeadingSpace = start > 0 && /\s/.test(content[start - 1] ?? '');
        const label = includeLineNumbers ? `/* L${bodyStart}-L${bodyEnd} */` : '/* ... */';
        replacements.push({
          start,
          end,
          text: hasLeadingSpace ? `{ ${label} }` : ` { ${label} }`,
        });
      }

      let name: string | undefined;
      if ('name' in node && node.name && ts.isIdentifier(node.name as TS.Node)) {
        name = (node.name as TS.Identifier).text;
      }

      symbolRanges.push({
        name,
        kind: ts.isFunctionDeclaration(node) ? 'function' : 'method',
        startLine: nodeStart,
        endLine: nodeEnd,
        bodyStartLine: bodyStart,
        bodyEndLine: bodyEnd,
      });

      if (node.body && ts.isBlock(node.body)) {
        return; // Don't visit inside stripped body
      }
    } else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      if (node.body) {
        const start = node.body.getStart(sourceFile);
        const end = node.body.getEnd();
        const bodyStart = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
        const bodyEnd = sourceFile.getLineAndCharacterOfPosition(end).line + 1;
        const label = includeLineNumbers ? `/* L${bodyStart}-L${bodyEnd} */` : '/* ... */';

        if (ts.isBlock(node.body)) {
          const hasLeadingSpace = start > 0 && /\s/.test(content[start - 1] ?? '');
          replacements.push({
            start,
            end,
            text: hasLeadingSpace ? `{ ${label} }` : ` { ${label} }`,
          });
          return;
        } else {
          replacements.push({
            start,
            end,
            text: label,
          });
          return;
        }
      }
    } else if (
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      symbolCount++;
      if (opts.exportsOnly && depth === 0 && !isExported(node)) {
        replacements.push({
          start: node.getStart(sourceFile),
          end: node.getEnd(),
          text: '',
        });
        return;
      }

      let name: string | undefined;
      if ('name' in node && node.name && ts.isIdentifier(node.name as TS.Node)) {
        name = (node.name as TS.Identifier).text;
      }

      symbolRanges.push({
        name,
        kind: ts.isClassDeclaration(node)
          ? 'class'
          : ts.isInterfaceDeclaration(node)
            ? 'interface'
            : ts.isTypeAliasDeclaration(node)
              ? 'type'
              : 'enum',
        startLine: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
      });
    }

    ts.forEachChild(node, (child) => visit(child, depth + 1));
  }

  ts.forEachChild(sourceFile, (node) => visit(node, 0));

  let skeleton = applyReplacements(content, replacements);

  if (opts.collapseImports) {
    skeleton = collapseTsImports(skeleton);
  }

  return { skeleton, symbolCount, symbols: symbolRanges };
}

function collapseTsImports(code: string): string {
  const lines = code.split('\n');
  const resultLines: string[] = [];
  let inImportGroup = false;
  let importGroupCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (trimmed.startsWith('import ') || trimmed.startsWith('import{')) {
      inImportGroup = true;
      importGroupCount++;
      // Consume multi-line import
      while (
        !trimmed.includes(';') &&
        !trimmed.includes("from '") &&
        !trimmed.includes('from "') &&
        i + 1 < lines.length
      ) {
        i++;
      }
    } else {
      if (inImportGroup) {
        resultLines.push(`// ... [${importGroupCount} import statements collapsed]`);
        inImportGroup = false;
        importGroupCount = 0;
      }
      resultLines.push(line);
    }
  }

  if (inImportGroup) {
    resultLines.push(`// ... [${importGroupCount} import statements collapsed]`);
  }

  return resultLines.join('\n');
}

/**
 * Extract skeleton for polyglot languages using Tree-Sitter AST.
 */
async function extractTreeSitterSkeleton(
  content: string,
  lang: SymbolLang,
  opts: SkeletonOptions,
): Promise<{ skeleton: string; symbolCount: number; symbols: SkeletonSymbolRange[] } | null> {
  const parsed = await parseTreeSitterAst({ content, lang });
  if (!parsed) return null;

  const { tree, parser } = parsed;
  const replacements: Replacement[] = [];
  const symbolRanges: SkeletonSymbolRange[] = [];
  let symbolCount = 0;
  const includeLineNumbers = opts.includeLineNumbers ?? true;

  try {
    const root = tree.rootNode;

    function walk(node: import('web-tree-sitter').Node) {
      const type = node.type;

      // Detect function/method declarations across C, C++, Java, C#, Go, Rust, Python, PHP, Ruby, Kotlin, Swift
      if (
        type === 'function_definition' ||
        type === 'function_declaration' ||
        type === 'method_declaration' ||
        type === 'function_item' ||
        type === 'method' ||
        type === 'singleton_method' ||
        type === 'func_literal'
      ) {
        symbolCount++;
        const nodeStart = node.startPosition.row + 1;
        const nodeEnd = node.endPosition.row + 1;
        let bodyStart: number | undefined;
        let bodyEnd: number | undefined;

        // Find body child
        const bodyNode =
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
          );

        if (bodyNode) {
          bodyStart = bodyNode.startPosition.row + 1;
          bodyEnd = bodyNode.endPosition.row + 1;
          const label = includeLineNumbers ? `/* L${bodyStart}-L${bodyEnd} */` : '/* ... */';

          if (lang === 'py') {
            replacements.push({
              start: bodyNode.startIndex,
              end: bodyNode.endIndex,
              text: includeLineNumbers ? `... # L${bodyStart}-L${bodyEnd}` : '...',
            });
          } else if (lang === 'ruby') {
            replacements.push({
              start: bodyNode.startIndex,
              end: bodyNode.endIndex,
              text: includeLineNumbers ? `\n    # L${bodyStart}-L${bodyEnd}` : '\n    # ...',
            });
          } else {
            const hasLeadingSpace =
              bodyNode.startIndex > 0 && /\s/.test(content[bodyNode.startIndex - 1] ?? '');
            replacements.push({
              start: bodyNode.startIndex,
              end: bodyNode.endIndex,
              text: hasLeadingSpace ? `{ ${label} }` : ` { ${label} }`,
            });
          }
        }

        const nameNode = node.childForFieldName('name') ?? node.childForFieldName('declarator');
        const symbolName = nameNode ? nameNode.text : undefined;

        symbolRanges.push({
          name: symbolName,
          kind: type.includes('function') ? 'function' : 'method',
          startLine: nodeStart,
          endLine: nodeEnd,
          bodyStartLine: bodyStart,
          bodyEndLine: bodyEnd,
        });

        if (bodyNode) return; // Skip walking into replaced body
      } else if (
        type === 'class_definition' ||
        type === 'class_specifier' ||
        type === 'class_declaration' ||
        type === 'struct_specifier' ||
        type === 'interface_declaration' ||
        type === 'trait_item'
      ) {
        symbolCount++;
        const nameNode = node.childForFieldName('name');
        symbolRanges.push({
          name: nameNode ? nameNode.text : undefined,
          kind: type.includes('class')
            ? 'class'
            : type.includes('struct')
              ? 'struct'
              : type.includes('interface')
                ? 'interface'
                : 'trait',
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });
      }

      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) walk(child);
      }
    }

    walk(root);
    const skeleton = applyReplacements(content, replacements);
    return { skeleton, symbolCount, symbols: symbolRanges };
  } finally {
    tree.delete();
    parser.delete();
  }
}

/**
 * Fallback line-based heuristic for files without Tree-sitter or TS AST support.
 */
function extractFallbackSkeleton(
  content: string,
  _lang: SymbolLang,
): { skeleton: string; symbolCount: number } {
  const lines = content.split('\n');
  const skeletonLines: string[] = [];
  let symbolCount = 0;
  let inBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith('export ') ||
      trimmed.startsWith('function ') ||
      trimmed.startsWith('def ') ||
      trimmed.startsWith('class ') ||
      trimmed.startsWith('interface ') ||
      trimmed.startsWith('type ') ||
      trimmed.startsWith('struct ') ||
      trimmed.startsWith('pub ') ||
      trimmed.startsWith('import ') ||
      trimmed.startsWith('package ') ||
      trimmed.startsWith('#include')
    ) {
      symbolCount++;
      if (trimmed.endsWith('{')) {
        skeletonLines.push(`${line.replace(/\{$/, '')}{ /* ... */ }`);
        inBlock = true;
      } else {
        skeletonLines.push(line);
      }
    } else if (trimmed === '}' && inBlock) {
      inBlock = false;
    } else if (
      !inBlock &&
      (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*'))
    ) {
      skeletonLines.push(line);
    }
  }

  return {
    skeleton: skeletonLines.length > 0 ? skeletonLines.join('\n') : content,
    symbolCount,
  };
}

/**
 * Extract an AST-based skeleton from a file's content.
 */
export async function extractFileSkeleton(opts: {
  file: string;
  content: string;
  lang?: SymbolLang;
  options?: SkeletonOptions;
}): Promise<FileSkeletonResult> {
  const detected = detectLang(opts.file);
  const lang: SymbolLang = opts.lang ?? detected ?? 'other';
  const options = opts.options ?? {};
  const originalLines = opts.content.split('\n').length;

  let extraction: {
    skeleton: string;
    symbolCount: number;
    symbols?: SkeletonSymbolRange[];
  };

  if (['ts', 'tsx', 'js', 'jsx'].includes(lang)) {
    extraction = await extractTsSkeleton(opts.content, lang, options);
  } else {
    const tsResult = await extractTreeSitterSkeleton(opts.content, lang, options);
    if (tsResult) {
      extraction = tsResult;
    } else {
      extraction = extractFallbackSkeleton(opts.content, lang);
    }
  }

  const skeletonLines = extraction.skeleton.split('\n').length;
  const originalChars = opts.content.length;
  const skeletonChars = extraction.skeleton.length;
  const savings = originalChars > 0 ? ((originalChars - skeletonChars) / originalChars) * 100 : 0;

  return {
    file: opts.file,
    lang,
    skeleton: extraction.skeleton,
    symbols: extraction.symbols,
    stats: {
      originalLines,
      skeletonLines,
      tokenSavingsPercent: Math.max(0, Math.round(savings * 10) / 10),
      symbolCount: extraction.symbolCount,
    },
  };
}

/**
 * Extract skeletons for all indexable files under a directory.
 */
export async function extractDirectorySkeleton(opts: {
  dirPath: string;
  maxFiles?: number;
  options?: SkeletonOptions;
}): Promise<{
  files: FileSkeletonResult[];
  combinedSkeleton: string;
  totalOriginalLines: number;
  totalSkeletonLines: number;
  overallSavingsPercent: number;
}> {
  const maxFiles = opts.maxFiles ?? 30;
  const filePaths: string[] = [];

  async function scan(dir: string) {
    if (filePaths.length >= maxFiles) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (filePaths.length >= maxFiles) break;
      if (
        entry.name.startsWith('.') ||
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'build'
      ) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await scan(fullPath);
      } else if (entry.isFile() && isIndexablePath(fullPath)) {
        filePaths.push(fullPath);
      }
    }
  }

  await scan(opts.dirPath);

  const results: FileSkeletonResult[] = [];
  let totalOrigChars = 0;
  let totalSkelChars = 0;
  let totalOrigLines = 0;
  let totalSkelLines = 0;

  const combinedParts: string[] = [];

  for (const fp of filePaths) {
    try {
      const content = await fs.readFile(fp, 'utf8');
      const res = await extractFileSkeleton({
        file: fp,
        content,
        options: opts.options ?? {},
      });
      results.push(res);
      totalOrigChars += content.length;
      totalSkelChars += res.skeleton.length;
      totalOrigLines += res.stats.originalLines;
      totalSkelLines += res.stats.skeletonLines;

      const rel = path.relative(opts.dirPath, fp).replace(/\\/g, '/');
      combinedParts.push(
        `// ═══════════════════ ${rel} (${res.lang}) ═══════════════════\n${res.skeleton}`,
      );
    } catch {
      // Ignore unreadable files
    }
  }

  const overallSavings =
    totalOrigChars > 0 ? ((totalOrigChars - totalSkelChars) / totalOrigChars) * 100 : 0;

  return {
    files: results,
    combinedSkeleton: combinedParts.join('\n\n'),
    totalOriginalLines: totalOrigLines,
    totalSkeletonLines: totalSkelLines,
    overallSavingsPercent: Math.max(0, Math.round(overallSavings * 10) / 10),
  };
}
