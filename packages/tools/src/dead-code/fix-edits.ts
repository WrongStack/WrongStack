/**
 * Source-text edits for the dead-code fixer: computing a file's edit from the
 * CURRENT syntax tree, and the cascade pass that removes what the edit orphaned.
 */

import type * as TS from '@typescript/typescript6';
import {
  buildRefIndex,
  createSource,
  extractModuleFacts,
  innerScopeNames,
  isWriteOnlyPosition,
} from './parse.js';

type Ts = typeof import('@typescript/typescript6');

const MAX_DIFF_LINES = 400;

export function truncateDiff(diff: string): string {
  const lines = diff.split('\n');
  if (lines.length <= MAX_DIFF_LINES) return diff;
  return `${lines.slice(0, MAX_DIFF_LINES).join('\n')}\n… ${lines.length - MAX_DIFF_LINES} more diff lines`;
}

// ─── Text edits ──────────────────────────────────────────────────────────

interface Edit {
  start: number;
  end: number;
  text: string;
}

function applyEdits(text: string, edits: Edit[]): string {
  // Drop edits contained in another (removing a statement already removes its modifier).
  const sorted = [...edits].sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Edit[] = [];
  for (const e of sorted) {
    const last = kept[kept.length - 1];
    if (last && e.start < last.end) {
      if (e.end > last.end) last.end = e.end;
      continue;
    }
    kept.push({ ...e });
  }
  let out = text;
  for (let i = kept.length - 1; i >= 0; i--) {
    const e = kept[i]!;
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

/** Statement span including attached leading comments, the trailing comment and its line break. */
function statementRange(ts: Ts, sf: TS.SourceFile, node: TS.Node): [number, number] {
  const text = sf.text;
  let start = node.getStart(sf);
  const comments = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i]!;
    const gap = text.slice(c.end, start);
    if ((gap.match(/\n/g)?.length ?? 0) > 1) break;
    start = c.pos;
  }
  let lineStart = start;
  while (lineStart > 0 && (text[lineStart - 1] === ' ' || text[lineStart - 1] === '\t'))
    lineStart--;
  if (lineStart === 0 || text[lineStart - 1] === '\n') start = lineStart;
  let end = node.getEnd();
  for (const c of ts.getTrailingCommentRanges(text, end) ?? []) {
    if (!text.slice(end, c.pos).includes('\n')) end = c.end;
  }
  while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
  if (text[end] === '\r') end++;
  if (text[end] === '\n') end++;
  // Don't leave a double blank line behind.
  const before = text.slice(Math.max(0, start - 4), start);
  const blankBefore = start === 0 || /\n[ \t]*\r?\n$/.test(before) || before.endsWith('\n\n');
  if (blankBefore) {
    const m = /^[ \t]*\r?\n/.exec(text.slice(end));
    if (m) end += m[0].length;
  }
  return [start, end];
}

/**
 * Removing a statement: a variable whose initializer has side effects
 * (`const h = start();`) loses only its binding — the expression stays.
 */
function removalEdit(ts: Ts, sf: TS.SourceFile, stmt: TS.Statement): Edit {
  const [start, end] = statementRange(ts, sf, stmt);
  const init = ts.isVariableStatement(stmt)
    ? stmt.declarationList.declarations[0]?.initializer
    : undefined;
  if (!init || isPureExpression(ts, init)) return { start, end, text: '' };
  const expr = init.getText(sf);
  const lineStart = sf.text.lastIndexOf('\n', stmt.getStart(sf) - 1) + 1;
  const indent = /^[ \t]*/.exec(sf.text.slice(lineStart))![0];
  const eol = sf.text.includes('\r\n') ? '\r\n' : '\n';
  const wrapped = /^(\{|function\b|class\b|let\s*\[)/.test(expr) ? `(${expr})` : expr;
  const guard = asiGlues(sf, stmt, wrapped) ? ';' : '';
  const tail = sf.text.slice(start, end).endsWith('\n') ? eol : '';
  const atLineStart = start === 0 || sf.text[start - 1] === '\n';
  return { start, end, text: `${atLineStart ? indent : ''}${guard}${wrapped};${tail}` };
}

/**
 * True when `expr`, kept as a bare statement, would continue the previous
 * statement: without a terminating `;` there, ASI does not split before a
 * line starting with `(`, `[`, a template, `+`, `-` or `/`
 * (`const a = f()\n[1].forEach(g)` parses as `f()[1].forEach(g)`).
 */
function asiGlues(sf: TS.SourceFile, stmt: TS.Statement, expr: string): boolean {
  if (!/^[[(`+\-/]/.test(expr)) return false;
  const siblings = (stmt.parent as { statements?: readonly TS.Statement[] }).statements;
  const prev = siblings?.[siblings.indexOf(stmt) - 1];
  return prev !== undefined && !prev.getText(sf).endsWith(';');
}

function nextTokenStart(text: string, pos: number): number {
  let i = pos;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
}

function modifierOf(ts: Ts, node: TS.Node, kind: TS.SyntaxKind): TS.Modifier | undefined {
  if (!ts.canHaveModifiers(node)) return undefined;
  return (ts.getModifiers(node) ?? []).find((m) => m.kind === kind);
}

function declaredName(ts: Ts, stmt: TS.Statement): string | null {
  if (
    (ts.isFunctionDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt) ||
      ts.isModuleDeclaration(stmt)) &&
    stmt.name &&
    ts.isIdentifier(stmt.name)
  ) {
    return stmt.name.text;
  }
  if (ts.isVariableStatement(stmt)) {
    const decls = stmt.declarationList.declarations;
    if (decls.length === 1 && ts.isIdentifier(decls[0]!.name)) return decls[0]!.name.text;
  }
  return null;
}

type ListNode = TS.NamedExports | TS.NamedImports;

/** Edits that remove `drop` elements from export/import lists, rebuilding each list once. */
function listEdits(
  ts: Ts,
  sf: TS.SourceFile,
  drops: Map<ListNode, Set<number>>,
  eol: string,
): Edit[] {
  const edits: Edit[] = [];
  for (const [list, indices] of drops) {
    const stmt = list.parent.kind === ts.SyntaxKind.ImportClause ? list.parent.parent : list.parent;
    const kept = list.elements.filter((_, i) => !indices.has(i));
    const isImport = ts.isNamedImports(list);
    if (kept.length === 0) {
      if (isImport) {
        const clause = list.parent as TS.ImportClause;
        if (clause.name) {
          // `import D, { a } from` → `import D from`
          edits.push({ start: clause.name.getEnd(), end: list.getEnd(), text: '' });
          continue;
        }
      }
      const [s, e] = statementRange(ts, sf, stmt);
      edits.push({ start: s, end: e, text: '' });
      continue;
    }
    const original = list.getText(sf);
    const texts = kept.map((el) => el.getText(sf));
    let rebuilt: string;
    if (original.includes('\n')) {
      const firstLineStart = sf.text.lastIndexOf('\n', list.elements[0]!.getStart(sf)) + 1;
      const indent = /^[ \t]*/.exec(sf.text.slice(firstLineStart))![0];
      const closeLineStart = sf.text.lastIndexOf('\n', list.getEnd() - 1) + 1;
      const closeIndent = /^[ \t]*/.exec(sf.text.slice(closeLineStart))![0];
      rebuilt = `{${eol}${texts.map((t) => `${indent}${t},`).join(eol)}${eol}${closeIndent}}`;
    } else {
      rebuilt = `{ ${texts.join(', ')} }`;
    }
    edits.push({ start: list.getStart(sf), end: list.getEnd(), text: rebuilt });
  }
  return edits;
}

function addDrop(drops: Map<ListNode, Set<number>>, list: ListNode, index: number): void {
  let set = drops.get(list);
  if (!set) {
    set = new Set();
    drops.set(list, set);
  }
  set.add(index);
}

// ─── Per-file edit computation ───────────────────────────────────────────

export interface FileOps {
  removeDeclarations: Set<string>; // exported names (or local names for unused-local)
  removeLocals: Set<string>;
  unexport: Set<string>;
  removeReexports: Set<string>;
}

export function computeFileEdit(ts: Ts, file: string, text: string, ops: FileOps): string {
  const sf = createSource(ts, file, text);
  const facts = extractModuleFacts(ts, file, text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const edits: Edit[] = [];
  const drops = new Map<ListNode, Set<number>>();

  // Exported name → local binding; local → every exported name it has.
  const localOf = new Map<string, string | null>();
  const namesOfLocal = new Map<string, string[]>();
  for (const exp of facts.exports) {
    localOf.set(exp.name, exp.local);
    if (exp.local) namesOfLocal.set(exp.local, [...(namesOfLocal.get(exp.local) ?? []), exp.name]);
  }

  const deleteLocals = new Set<string>(ops.removeLocals);
  const dropExportNames = new Set<string>(ops.unexport);
  let removeAnonymousDefault = false;
  for (const name of ops.removeDeclarations) {
    const local = localOf.get(name);
    if (local === undefined) continue;
    if (local === null) {
      if (name === 'default') removeAnonymousDefault = true;
      continue;
    }
    // Another exported alias of the same binding survives: drop only this name.
    const aliases = namesOfLocal.get(local) ?? [];
    if (aliases.some((a) => a !== name && !ops.removeDeclarations.has(a))) {
      dropExportNames.add(name);
      continue;
    }
    deleteLocals.add(local);
    for (const a of aliases) dropExportNames.add(a);
  }

  for (const stmt of sf.statements) {
    const name = declaredName(ts, stmt);
    const exportMod = modifierOf(ts, stmt, ts.SyntaxKind.ExportKeyword);
    const defaultMod = modifierOf(ts, stmt, ts.SyntaxKind.DefaultKeyword);
    const exportedAs = exportMod ? (defaultMod ? 'default' : name) : null;

    if (name && deleteLocals.has(name)) {
      edits.push(removalEdit(ts, sf, stmt));
      continue;
    }
    if (exportedAs === 'default' && name === null && removeAnonymousDefault) {
      const [s, e] = statementRange(ts, sf, stmt);
      edits.push({ start: s, end: e, text: '' });
      continue;
    }
    if (exportMod && exportedAs && dropExportNames.has(exportedAs)) {
      if (defaultMod && name === null) continue; // anonymous default cannot lose `export`
      const until = defaultMod ? defaultMod.getEnd() : exportMod.getEnd();
      edits.push({ start: exportMod.getStart(sf), end: nextTokenStart(text, until), text: '' });
      continue;
    }
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      const local = ts.isIdentifier(stmt.expression) ? stmt.expression.text : null;
      if (
        dropExportNames.has('default') ||
        (local === null && removeAnonymousDefault) ||
        (local !== null && deleteLocals.has(local))
      ) {
        const [s, e] = statementRange(ts, sf, stmt);
        edits.push({ start: s, end: e, text: '' });
      }
      continue;
    }
    if (ts.isExportDeclaration(stmt)) {
      const clause = stmt.exportClause;
      const viaModule = stmt.moduleSpecifier !== undefined;
      if (clause && ts.isNamespaceExport(clause)) {
        if (viaModule && ops.removeReexports.has(clause.name.text)) {
          const [s, e] = statementRange(ts, sf, stmt);
          edits.push({ start: s, end: e, text: '' });
        }
        continue;
      }
      if (!clause) continue;
      clause.elements.forEach((el, i) => {
        const exported = el.name.text;
        const remove = viaModule
          ? ops.removeReexports.has(exported)
          : dropExportNames.has(exported) || ops.removeReexports.has(exported);
        if (remove) addDrop(drops, clause, i);
      });
    }
  }

  edits.push(...listEdits(ts, sf, drops, eol));
  return applyEdits(text, edits);
}

/** Side-effect-free right-hand sides: dropping `x = <rhs>;` changes nothing else. */
function isPureExpression(ts: Ts, e: TS.Expression): boolean {
  if (ts.isIdentifier(e) || ts.isLiteralExpression(e) || ts.isNoSubstitutionTemplateLiteral(e))
    return true;
  const k = e.kind;
  if (
    k === ts.SyntaxKind.NullKeyword ||
    k === ts.SyntaxKind.TrueKeyword ||
    k === ts.SyntaxKind.FalseKeyword ||
    k === ts.SyntaxKind.ThisKeyword
  ) {
    return true;
  }
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isClassExpression(e)) return true;
  if (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeOfExpression(e) ||
    ts.isVoidExpression(e)
  ) {
    return isPureExpression(ts, e.expression);
  }
  if (ts.isArrayLiteralExpression(e)) {
    return e.elements.every((el) => !ts.isSpreadElement(el) && isPureExpression(ts, el));
  }
  if (ts.isObjectLiteralExpression(e)) {
    return e.properties.every(
      (p) =>
        ts.isShorthandPropertyAssignment(p) ||
        ts.isMethodDeclaration(p) ||
        ts.isGetAccessorDeclaration(p) ||
        ts.isSetAccessorDeclaration(p) ||
        (ts.isPropertyAssignment(p) &&
          !ts.isComputedPropertyName(p.name) &&
          isPureExpression(ts, p.initializer)),
    );
  }
  if (ts.isTemplateExpression(e)) {
    return e.templateSpans.every((span) => isPureExpression(ts, span.expression));
  }
  if (ts.isPrefixUnaryExpression(e)) {
    return (
      e.operator !== ts.SyntaxKind.PlusPlusToken &&
      e.operator !== ts.SyntaxKind.MinusMinusToken &&
      isPureExpression(ts, e.operand)
    );
  }
  if (ts.isConditionalExpression(e)) {
    return [e.condition, e.whenTrue, e.whenFalse].every((x) => isPureExpression(ts, x));
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    const assigns = op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment;
    return !assigns && isPureExpression(ts, e.left) && isPureExpression(ts, e.right);
  }
  if (ts.isPropertyAccessExpression(e)) return isPureExpression(ts, e.expression);
  return false;
}

/**
 * Every statement that writes `name`, if all are plain `name = <pure>;`
 * statements; null when any write is something else (its side effects must stay).
 */
function pureAssignmentStatements(ts: Ts, sf: TS.SourceFile, name: string): TS.Statement[] | null {
  const out: TS.Statement[] = [];
  let impure = false;
  const visit = (node: TS.Node, shadowed: boolean): void => {
    if (impure) return;
    const nextShadowed = shadowed || innerScopeNames(ts, node).includes(name);
    if (
      !nextShadowed &&
      ts.isIdentifier(node) &&
      node.text === name &&
      isWriteOnlyPosition(ts, node)
    ) {
      const write = node.parent;
      const stmt = write.parent;
      if (
        ts.isBinaryExpression(write) &&
        write.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isPureExpression(ts, write.right) &&
        ts.isExpressionStatement(stmt)
      ) {
        out.push(stmt);
      } else {
        impure = true;
      }
      return;
    }
    ts.forEachChild(node, (child) => visit(child, nextShadowed));
  };
  visit(sf, false);
  return impure ? null : out;
}

/**
 * Remove imports and private top-level declarations that the edit orphaned:
 * referenced in `original`, unreferenced in `current`. Repeats to a fixpoint
 * (a removed helper may orphan another).
 */
export function cascadeCleanup(ts: Ts, file: string, original: string, current: string): string {
  const orig = buildRefIndex(ts, createSource(ts, file, original), true);
  const reads = (idx: { counts: Map<string, number>; writes: Map<string, number> }, n: string) =>
    (idx.counts.get(n) ?? 0) - (idx.writes.get(n) ?? 0);
  let text = current;
  for (let round = 0; round < 6; round++) {
    const sf = createSource(ts, file, text);
    const now = buildRefIndex(ts, sf, true);
    const refs = now.counts;
    const orphaned = (name: string): boolean =>
      (orig.counts.get(name) ?? 0) > 0 && (refs.get(name) ?? 0) === 0;
    // A variable whose last READ went away but that is still assigned.
    const writeOnly = (name: string): boolean =>
      reads(orig, name) > 0 && reads(now, name) === 0 && (now.writes.get(name) ?? 0) > 0;
    const edits: Edit[] = [];
    const drops = new Map<ListNode, Set<number>>();
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && stmt.importClause) {
        const clause = stmt.importClause;
        const nb = clause.namedBindings;
        // No default binding counts as "gone" for the whole-statement test.
        const defaultGone = clause.name ? orphaned(clause.name.text) : true;
        if (nb && ts.isNamespaceImport(nb)) {
          if (orphaned(nb.name.text) && defaultGone) {
            const [s, e] = statementRange(ts, sf, stmt);
            edits.push({ start: s, end: e, text: '' });
          }
          continue;
        }
        const named = nb && ts.isNamedImports(nb) ? nb : undefined;
        const goneIdx = named
          ? named.elements.flatMap((el, i) => (orphaned(el.name.text) ? [i] : []))
          : [];
        const allNamedGone = !named || goneIdx.length === named.elements.length;
        if (clause.name && defaultGone && allNamedGone) {
          const [s, e] = statementRange(ts, sf, stmt);
          edits.push({ start: s, end: e, text: '' });
          continue;
        }
        if (clause.name && defaultGone && named) {
          // `import D, { a } from` → `import { a } from`
          edits.push({ start: clause.name.getStart(sf), end: named.getStart(sf), text: '' });
        }
        if (named) for (const i of goneIdx) addDrop(drops, named, i);
        continue;
      }
      if (modifierOf(ts, stmt, ts.SyntaxKind.ExportKeyword)) continue;
      const name = declaredName(ts, stmt);
      if (name && orphaned(name)) {
        edits.push(removalEdit(ts, sf, stmt));
      } else if (name && ts.isVariableStatement(stmt) && writeOnly(name)) {
        const assignments = pureAssignmentStatements(ts, sf, name);
        if (assignments !== null) {
          edits.push(removalEdit(ts, sf, stmt));
          for (const node of assignments) {
            const [s, e] = statementRange(ts, sf, node);
            edits.push({ start: s, end: e, text: '' });
          }
        }
      }
    }
    edits.push(...listEdits(ts, sf, drops, eol));
    if (edits.length === 0) break;
    text = applyEdits(text, edits);
  }
  return text;
}

export function editPackageJson(
  text: string,
  removals: Array<{ field: string; dep: string }>,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return text;
  const json = parsed as Record<string, Record<string, unknown> | undefined>;
  for (const { field, dep } of removals) {
    const section = json[field];
    if (section && typeof section === 'object') delete section[dep];
  }
  const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? '  ';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let out = JSON.stringify(json, null, indent.includes('\t') ? '\t' : indent.length);
  if (eol === '\r\n') out = out.replace(/\n/g, '\r\n');
  return text.endsWith('\n') ? out + eol : out;
}
