#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript5';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => readFileSync(join(root, file), 'utf8');
const parse = (file) => ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
function visit(node, fn) {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}
function findNamedDeclaration(file, name) {
  let result;
  visit(file, (node) => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.name?.getText() === name
    )
      result = node;
  });
  return result;
}
function namedDeclaration(file, name) {
  const result = findNamedDeclaration(file, name);
  if (!result) throw new Error(`Missing source declaration ${name}`);
  return result;
}

// CLI compatibility modules can re-export a builder through a workspace barrel.
// Follow the named source export rather than reading a stale dist declaration.
function sourceModule(file, specifier) {
  if (specifier.startsWith('.')) return resolve(dirname(file), specifier).replace(/\.js$/, '.ts');
  const match = /^@wrongstack\/([^/]+)(\/.*)?$/.exec(specifier);
  if (!match) throw new Error(`Unsupported source export ${specifier}`);
  const packageRoot = join(root, 'packages', match[1]);
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const entry = manifest.exports[match[2] ? `.${match[2]}` : '.'];
  const output = typeof entry === 'string' ? entry : entry?.import;
  if (manifest.name !== `@wrongstack/${match[1]}` || !output?.startsWith('./dist/'))
    throw new Error(`Review workspace source export ${specifier}`);
  return resolve(packageRoot, output.replace('./dist/', './src/')).replace(/\.js$/, '.ts');
}
function sourceDeclaration(file, name, seen = new Set()) {
  const key = `${file}:${name}`;
  if (seen.has(key)) throw new Error(`Circular source export ${key}`);
  seen.add(key);
  const parsed = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const local = findNamedDeclaration(parsed, name);
  if (local) {
    if (sourceCommandNames(local).length === 0) {
      const delegates = new Set();
      visit(local, (node) => {
        if (
          ts.isReturnStatement(node) &&
          node.expression &&
          ts.isCallExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text.startsWith('build')
        )
          delegates.add(node.expression.expression.text);
      });
      for (const statement of parsed.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
          continue;
        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) continue;
        const imported = bindings.elements.find((item) => delegates.has(item.name.text));
        if (imported)
          return sourceDeclaration(
            sourceModule(file, statement.moduleSpecifier.text),
            imported.propertyName?.text ?? imported.name.text,
            seen,
          );
      }
    }
    return { parsed, declaration: local };
  }
  for (const statement of parsed.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    )
      continue;
    const exported = statement.exportClause.elements.find((item) => item.name.text === name);
    if (!exported) continue;
    return sourceDeclaration(
      sourceModule(file, statement.moduleSpecifier.text),
      exported.propertyName?.text ?? name,
      seen,
    );
  }
  throw new Error(`Missing source declaration ${name} in ${file}`);
}
function property(node, name) {
  return node.properties.find((item) => item.name?.getText().replace(/^['"]|['"]$/g, '') === name);
}
function sourceCommandNames(node) {
  const names = new Set();
  visit(node, (item) => {
    if (!ts.isObjectLiteralExpression(item) || !property(item, 'run')) return;
    const name = property(item, 'name');
    if (name && ts.isPropertyAssignment(name) && ts.isStringLiteral(name.initializer))
      names.add(name.initializer.text);
  });
  return [...names];
}
function indexRows(file, pattern) {
  const rows = new Map();
  for (const line of read(file).split(/\r?\n/)) {
    if (!line.startsWith('| ')) continue;
    const firstCell = line.slice(2, line.indexOf('|', 2));
    const links = [...line.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
    for (const match of firstCell.matchAll(pattern))
      rows.set(match[1], [...(rows.get(match[1]) ?? []), ...links]);
  }
  return rows;
}
const errors = [];
const shellFile = parse('packages/cli/src/subcommands/index.ts');
const loaders = namedDeclaration(shellFile, 'loaders').initializer;
if (!ts.isObjectLiteralExpression(loaders))
  throw new Error('Review changed subcommand loader shape');
const shellNames = loaders.properties.map((item) =>
  item.name.getText().replace(/^['"]|['"]$/g, ''),
);
const shellRows = indexRows('docs/subcommands/README.md', /\bwstack ([a-z][\w-]*)/g);
for (const name of shellNames) {
  if (!shellRows.get(name)?.length)
    errors.push(`wstack ${name}: missing linked guide in docs/subcommands/README.md`);
}

const entryPath = 'packages/cli/src/slash-commands/index.ts';
const entry = parse(entryPath);
const imports = new Map();
for (const statement of entry.statements) {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
    continue;
  const bindings = statement.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) continue;
  const target = statement.moduleSpecifier.text;
  if (!target.startsWith('./')) continue;
  for (const item of bindings.elements)
    imports.set(item.name.text, {
      file: target,
      original: item.propertyName?.text ?? item.name.text,
    });
}
const builders = new Set();
visit(namedDeclaration(entry, 'buildBuiltinSlashCommands'), (node) => {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    imports.has(node.expression.text) &&
    node.expression.text.startsWith('build')
  )
    builders.add(node.expression.text);
});
const slashNames = new Set();
for (const builder of builders) {
  // Hidden names come from the same source panel table as the numeric launcher.
  if (builder === 'buildFKeyAliasCommands') {
    const aliasImport = imports.get(builder);
    const aliasPath = resolve(root, dirname(entryPath), aliasImport.file.replace(/\.js$/, '.ts'));
    const aliasSource = ts.createSourceFile(
      aliasPath,
      readFileSync(aliasPath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const panels = namedDeclaration(aliasSource, 'F_PANELS').initializer;
    if (!ts.isObjectLiteralExpression(panels)) throw new Error('Review changed F-key panel table');
    for (const item of panels.properties) {
      const number = item.name?.getText().replace(/^['"]|['"]$/g, '');
      if (!/^\d+$/.test(number ?? '')) throw new Error('Review non-numeric F-key panel');
      slashNames.add(`f${number}`);
    }
    continue;
  }
  const imported = imports.get(builder);
  const file = resolve(root, dirname(entryPath), imported.file.replace(/\.js$/, '.ts'));
  const { parsed, declaration } = sourceDeclaration(file, imported.original);
  let names = sourceCommandNames(declaration);
  // A delegating builder can return one shared factory from its module.
  if (names.length === 0) names = sourceCommandNames(parsed);
  if (names.length !== 1)
    throw new Error(`Review changed builder shape: ${builder} (${names.join(', ')})`);
  slashNames.add(names[0]);
}
const slashIndex = read('docs/slash/README.md');
const slashRows = indexRows('docs/slash/README.md', /\/([a-z][\w-]*)/g);
const hiddenFKeys = [...slashNames]
  .filter((name) => /^f\d+$/.test(name))
  .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
const hiddenFamilyDescription = hiddenFKeys.length
  ? `\`/${hiddenFKeys[0]}\` through \`/${hiddenFKeys.at(-1)}\``
  : '';
for (const name of slashNames) {
  if (/^f\d+$/.test(name)) {
    if (!slashRows.get('f')?.length || !slashIndex.includes(hiddenFamilyDescription))
      errors.push(`/${name}: missing documented hidden F-key family`);
  } else if (!slashRows.get(name)?.length)
    errors.push(`/${name}: missing linked guide in docs/slash/README.md`);
}
const tuiSources = [
  'packages/tui/src/connections-slash.ts',
  'packages/tui/src/workbench-slash.ts',
  'packages/tui/src/cron-slash.ts',
  'packages/tui/src/hooks/use-session-slash-commands.ts',
];
const tuiNames = new Set();
for (const file of tuiSources)
  for (const name of sourceCommandNames(parse(file))) tuiNames.add(name);
for (const name of tuiNames)
  if (!slashRows.get(name)?.length) errors.push(`TUI /${name}: missing linked guide`);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Command documentation: ${shellNames.length} shell keys, ${slashNames.size} CLI slash registrations and ${tuiNames.size} checked TUI names have linked guides.`,
  );
}
