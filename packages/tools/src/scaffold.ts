import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/core/types';
import { atomicWrite } from '@wrongstack/core/utils';
import { safeResolveReal } from './_util.js';

interface ScaffoldInput {
  template: string;
  name: string;
  cwd?: string | undefined;
  vars?: Record<string, string>;
  dry_run?: boolean | undefined;
}

interface ScaffoldOutput {
  template: string;
  name: string;
  files_created: number;
  files: string[];
  dry_run: boolean;
  output: string;
}

const BUILT_IN_TEMPLATES: Record<string, { description: string; files: Record<string, string> }> = {
  'npm-package': {
    description: 'Basic npm package with ESM',
    files: {
      'package.json': JSON.stringify(
        {
          name: '{{name}}',
          version: '0.1.1',
          type: 'module',
          main: './dist/index.js',
          scripts: { build: 'tsc', test: 'vitest run' },
          devDependencies: { typescript: '^5.0.0' },
        },
        null,
        2,
      ),
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true },
          include: ['src'],
        },
        null,
        2,
      ),
      'src/index.ts': `export function hello() {\n  return 'Hello from {{name}}';\n}\n`,
      'src/index.test.ts': `import { hello } from './index';\nimport { describe, it, expect } from 'vitest';\n\ndescribe('hello', () => {\n  it('returns greeting', () => {\n    expect(hello()).toBe('Hello from {{name}}');\n  });\n});\n`,
    },
  },
  'cli-tool': {
    description: 'CLI tool with argparse',
    files: {
      'package.json': JSON.stringify(
        {
          name: '{{name}}',
          version: '0.1.1',
          type: 'module',
          bin: { '{{name}}': './src/index.js' },
          scripts: { build: 'tsc', start: 'node dist/index.js' },
        },
        null,
        2,
      ),
      'src/index.ts': `#!/usr/bin/env node\n\nasync function main() {\n  console.log('Hello from {{name}}');\n}\n\nmain();\n`,
    },
  },
  'react-component': {
    description: 'React component with TypeScript',
    files: {
      '{{name}}.tsx': `interface {{Name}}Props {\n  className?: string;\n}\n\nexport function {{Name}}({ className }: {{Name}}Props) {\n  return (\n    <div className={className}>\n      {{Name}} Component\n    </div>\n  );\n}\n`,
      '{{name}}.test.tsx': `import { render, screen } from '@testing-library/react';\nimport { {{Name}} } from './{{Name}}';\n\ndescribe('{{Name}}', () => {\n  it('renders', () => {\n    render(<{{Name}} />);\n    expect(screen.getByText('{{Name}} Component')).toBeInTheDocument();\n  });\n});\n`,
    },
  },
};

export const scaffoldTool: Tool<ScaffoldInput, ScaffoldOutput> = {
  name: 'scaffold',
  category: 'Project',
  description:
    'Generate new files and folder structures from built-in templates or custom definitions. ' +
    'This is the recommended way to bootstrap new packages, components, or modules instead of creating files one by one with `write`.',
  usageHint:
    'PREFERRED FOR SCAFFOLDING:\n\n' +
    '- Use built-in templates when they match your needs (e.g. react-component, npm-package).\n' +
    '- Supports `dry_run` so you can preview exactly what will be created.\n' +
    '- Has the powerful `fs.write.outside-project` capability — review paths carefully.\n' +
    'Much cleaner and safer than manually writing multiple files.',
  permission: 'confirm',
  mutating: true,
  subjectKey: 'name',
  capabilities: ['fs.write.outside-project', 'fs.write'],
  icon: 'scaffold',
  timeoutMs: 30_000,
  inputSchema: {
    type: 'object',
    properties: {
      template: {
        type: 'string',
        description:
          'Template name (npm-package, cli-tool, react-component) or path to template directory',
      },
      name: {
        type: 'string',
        description: 'Project/component name (used in generated files)',
      },
      cwd: { type: 'string', description: 'Working directory (default: cwd)' },
      vars: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Template variables for custom templates',
      },
      dry_run: {
        type: 'boolean',
        description: 'Preview generated files without creating (default: false)',
      },
    },
    required: ['template', 'name'],
  },
  async execute(input, ctx) {
    const cwd = input.cwd ? await safeResolveReal(input.cwd, ctx) : ctx.cwd;
    const name = input.name;
    const vars = { name, ...input.vars };

    const builtIn = BUILT_IN_TEMPLATES[input.template];
    if (builtIn) {
      return await handleBuiltIn(name, builtIn.files, cwd, ctx, input.dry_run ?? false, vars);
    }

    return {
      template: input.template,
      name,
      files_created: 0,
      files: [],
      dry_run: input.dry_run ?? false,
      output: `Template "${input.template}" not found. Available: ${Object.keys(BUILT_IN_TEMPLATES).join(', ')}`,
    };
  },
};

async function handleBuiltIn(
  name: string,
  templateFiles: Record<string, string>,
  cwd: string,
  ctx: Parameters<Tool['execute']>[1],
  dryRun: boolean,
  vars: Record<string, string>,
): Promise<ScaffoldOutput> {
  const files: string[] = [];
  let filesCreated = 0;

  for (const [filePath, content] of Object.entries(templateFiles)) {
    const resolvedPath = substituteVars(filePath, name, vars);
    const joinedPath = path.join(cwd, resolvedPath);
    // Ensure generated files cannot escape the project root via template variable injection (e.g. name containing "../")
    const root = path.resolve(ctx.projectRoot ?? ctx.cwd ?? process.cwd());
    const target = path.resolve(joinedPath);
    const rel = path.relative(root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`scaffold: generated path "${resolvedPath}" would escape project root`);
    }
    const fullPath = target;

    if (!dryRun) {
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      // atomicWrite: scaffolded files land in the user's tracked tree.
      // A torn write here would commit a corrupt file to their repo.
      await atomicWrite(fullPath, substituteVars(content, name, vars));
    }
    files.push(resolvedPath);
    filesCreated++;
  }

  return {
    template: 'built-in',
    name,
    files_created: filesCreated,
    files,
    dry_run: dryRun,
    output: dryRun
      ? `Would create ${filesCreated} files: ${files.join(', ')}`
      : `Created ${filesCreated} files: ${files.join(', ')}`,
  };
}

/** Escape a string so it matches literally inside a regular expression. */
function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Substitute `{{name}}`, `{{Name}}` and caller-supplied `{{key}}` placeholders
 * (WS-057).
 *
 * Both halves of this used to be injectable, and both inputs come from the
 * tool's arguments:
 *
 *  - The variable NAME was interpolated raw into `new RegExp(...)`. A key of
 *    `.*` compiled to `\{\{.*\}\}`, which is greedy and matches from the first
 *    `{{` to the LAST `}}` — replacing whole spans of the template rather than
 *    one placeholder. A key containing `(` threw instead, aborting the
 *    scaffold with a regex syntax error.
 *  - The VALUE was passed as a replacement STRING, where `$&`, `` $` ``, `$'`
 *    and `$1` are special. A value of `` $` `` expands to everything before
 *    the match, so a variable could duplicate or relocate template content it
 *    was never given.
 *
 * Names are escaped; values go through a replacer FUNCTION, which is the only
 * form `String.replace` treats as fully literal.
 */
function substituteVars(content: string, name: string, vars: Record<string, string>): string {
  const kebab = name.toLowerCase().replace(/\s+/g, '-');
  const pascal = name.replace(/(?:^|[-_\s]+)([a-z])/g, (_, c: string) => c.toUpperCase());
  let result = content;
  result = result.replace(/\{\{name\}\}/g, () => kebab);
  result = result.replace(/\{\{Name\}\}/g, () => pascal);
  for (const [k, v] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${escapeRegexLiteral(k)}\\}\\}`, 'g'), () => v);
  }
  return result;
}
