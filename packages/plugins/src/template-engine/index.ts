/**
 * template-engine plugin — File template expansion with variable substitution.
 *
 * Tools registered:
 * - template_expand: Expand a template string with variables
 * - template_render: Read a template file and expand it
 * - template_create: Save a named template to the plugin store
 * - template_list: List all saved templates
 */

import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Plugin } from '@wrongstack/core/types';
import { releaseHandle, withinProject } from '../runtime/index.js';

const API_VERSION = '^0.1.10';

interface StoredTemplate {
  name: string;
  content: string;
  description?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

// Module-level state, shared between `setup` and `teardown`.
//
// Why module-level? The Plugin interface in @wrongstack/core does not
// thread state from `setup` → `teardown`. Keeping `templates` inside
// the setup closure made the Map unreachable from teardown, which
// would leak the saved-template store across plugin reload cycles
// (H1 audit pattern, 2026-06-03 — same shape as cron/file-watcher).
// With stable Map identity at module scope, teardown can finally
// reach the resource and clear it. Setup re-initializes the Map
// (idempotent re-init on plugin reload); teardown releases it.
const templates = new Map<string, StoredTemplate>();
const MAX_TEMPLATES = 256;
const MAX_TEMPLATE_NAME_CHARS = 128;
const MAX_TEMPLATE_CONTENT_CHARS = 256 * 1024;
const MAX_TEMPLATE_DESCRIPTION_CHARS = 4 * 1024;
const MAX_TOTAL_TEMPLATE_CHARS = 8 * 1024 * 1024;

function templateChars(template: StoredTemplate): number {
  return template.name.length + template.content.length + (template.description?.length ?? 0);
}

/**
 * Handle for the system-prompt contributor.
 *
 * Unlike `api.onEvent`, the host does NOT track prompt contributors for
 * automatic cleanup (`DefaultPluginAPI.registerSystemPromptContributor`
 * returns the unregister function and keeps no reference). Discarding it
 * meant every reload added another copy of the same prompt block, and
 * teardown left one behind entirely.
 */
let contributorUnregister: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Template engine
// ---------------------------------------------------------------------------

function expandTemplate(template: string, variables: Record<string, string>): string {
  let result = template;

  // Replace simple {{variable}} patterns (supporting hyphens and dots)
  result = result.replace(/\{\{([\w.-]+)\}\}/g, (match, key) => {
    const value = variables[key];
    if (value !== undefined) return value;
    return match; // leave unresolved
  });

  return result;
}

function expandConditionals(template: string, variables: Record<string, string>): string {
  // Handle {{#if variable}}...{{/if}}
  return template.replace(/\{\{#if\s+([\w.-]+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key, content) => {
    const val = variables[key];
    return val !== undefined && val !== '' && val !== 'false' && val !== '0' ? content : '';
  });
}

function expandLoops(template: string, variables: Record<string, string>): string {
  // Handle {{#each items}}...{{item}}...{{/each}}
  // Simplified: just repeat the block for each item separated by newlines
  return template.replace(/\{\{#each\s+([\w.-]+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (_, key, content) => {
    const val = variables[key];
    if (!val) return '';
    // If the variable value is a comma-separated list, expand each
    if (typeof val === 'string' && val.includes(',')) {
      const items = val.split(',').map((s) => s.trim());
      return items.map((item) => expandTemplate(content, { ...variables, [key]: item, item })).join('\n');
    }
    return expandTemplate(content, variables);
  });
}

function renderTemplate(
  template: string,
  variables: Record<string, string>,
  escapeHtml = true,
): string {
  let result = template;

  // Process conditionals first
  result = expandConditionals(result, variables);

  // Process loops
  result = expandLoops(result, variables);

  // Process simple variable substitution
  result = expandTemplate(result, variables);

  // Auto-escape HTML when enabled (controlled by config or caller)
  if (escapeHtml) {
    result = result
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return result;
}

function renderTemplateRaw(template: string, variables: Record<string, string>): string {
  let result = template;

  result = expandConditionals(result, variables);
  result = expandLoops(result, variables);
  result = expandTemplate(result, variables);

  return result;
}

function validateRelativeTemplatePath(field: string, value: string): string | null {
  // Path traversal guard: reject absolute paths and path components that
  // escape the working directory. Core file tools have project-root
  // sandboxing; plugin-local fs access needs defense in depth.
  if (isAbsolute(value) || value.split(/[\\/]+/).includes('..')) {
    return `${field} must be a relative path without ".." components`;
  }
  // The string checks above are necessary but not sufficient. On Windows a
  // *drive-relative* path such as `C:out.txt` is NOT reported as absolute
  // by `isAbsolute`, yet it resolves against the current directory of that
  // drive — i.e. straight out of the project. Verify where the path
  // actually lands, which also covers spellings the string checks miss.
  if (!withinProject(value)) {
    return `${field} must resolve inside the project directory`;
  }
  return null;
}

/**
 * Destinations this tool may never write, even though they are inside the
 * project.
 *
 * "Inside the project" was the whole write policy, and these paths are all
 * inside it: `.git/hooks/pre-commit` and `.husky/pre-commit` execute on the
 * user's next commit, `.github/workflows/*` executes in CI, and the config
 * directories carry credentials and plugin/hook definitions. `path-guard`
 * protects `.git/**`, but its PreToolUse matcher keys on the tool NAMES
 * `write|edit|bash|exec`, so it never sees a tool this package registers —
 * which is exactly why the check has to live here.
 */
const PROTECTED_WRITE_PREFIXES = [
  '.git/',
  '.husky/',
  '.github/workflows/',
  '.wrongstack/',
  '.claude/',
  'node_modules/',
];
const PROTECTED_WRITE_FILES = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.npmrc',
  '.gitattributes',
]);

/** `validateRelativeTemplatePath` plus the protected-destination denylist. */
function validateWritableTemplateTarget(field: string, value: string): string | null {
  const baseError = validateRelativeTemplatePath(field, value);
  if (baseError) return baseError;
  const norm = value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  if (
    PROTECTED_WRITE_PREFIXES.some((p) => norm.startsWith(p)) ||
    PROTECTED_WRITE_FILES.has(base) ||
    base === '.env' ||
    base.startsWith('.env.')
  ) {
    return (
      `${field} "${value}" is a protected path (VCS hooks, CI workflows, ` +
      `dependency manifests, or agent configuration). Write it with the ` +
      `\`write\` tool instead, which prompts for confirmation.`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'template-engine',
  version: '0.1.0',
  description: 'Expands file templates with variable substitution, conditionals, and loops',
  apiVersion: API_VERSION,
  capabilities: { tools: true },
  defaultConfig: {
    autoEscapeHtml: true,
    templateDir: './templates',
    strictVariables: false,
  },
  configSchema: {
    type: 'object',
    properties: {
      autoEscapeHtml: { type: 'boolean', default: true },
      templateDir: { type: 'string', default: './templates' },
      strictVariables: { type: 'boolean', default: false },
    },
  },

  setup(api) {
    // Idempotent re-init: drop any templates that survived a previous
    // teardown (the H1 fix path — maps cleared in teardown, fresh maps
    // here). If setup is called for the first time, the module-level
    // Map is already empty.
    templates.clear();
    const autoEscapeHtml =
      ((api.config.extensions?.['template-engine'] as Record<string, unknown>)?.[
        'autoEscapeHtml'
      ] as boolean) ?? true;

    // --- template_expand ---
    api.tools.register({
      name: 'template_expand',
      description:
        'Expand a template string with variable substitution. Supports {{variable}}, {{#if var}}...{{/if}} conditionals, and {{#each items}}...{{/each}} loops.',
      inputSchema: {
        type: 'object',
        properties: {
          template: {
            type: 'string',
            description: 'Template string with {{variable}} placeholders',
          },
          variables: {
            type: 'object',
            description: 'Variables to substitute into the template',
            additionalProperties: { type: 'string' },
          },
          output_path: {
            type: 'string',
            description: 'Optional path to write the expanded result',
          },
          raw: { type: 'boolean', default: false, description: 'Disable HTML auto-escaping' },
        },
        required: ['template', 'variables'],
      },
      // Writes caller-supplied content to a caller-supplied path. `auto` +
      // no declared capability meant no confirmation prompt, no read-only-mode
      // block (`readonly-permission-policy` keys on `capabilities`, not
      // `mutating`), and no PreToolUse hook — plugin tools reach the executor
      // through `plugin_manager action:'use'`, which bypasses it.
      permission: 'confirm',
      capabilities: ['fs.write'],
      riskTier: 'destructive',
      category: 'Project',
      mutating: true,
      async execute(input: Record<string, unknown>) {
        const template = input['template'];
        const variables = input['variables'] as Record<string, string> | undefined;
        const output_path = input['output_path'] as string | undefined;
        const raw = (input['raw'] as boolean | undefined) ?? false;

        if (!template || typeof template !== 'string') {
          return { ok: false, error: 'template is required and must be a string' };
        }
        if (!variables || typeof variables !== 'object') {
          return { ok: false, error: 'variables is required and must be an object' };
        }

        let result: string;
        /* v8 ignore start -- the render pipeline (regex replaces) does not throw; this guard is defensive. */
        try {
          result = raw
            ? renderTemplateRaw(template, variables)
            : renderTemplate(template, variables, autoEscapeHtml);
        } catch (err: unknown) {
          return { ok: false, error: String(err) };
        }
        /* v8 ignore stop */

        if (output_path) {
          const pathError = validateWritableTemplateTarget('output_path', output_path);
          if (pathError) return { ok: false, error: pathError };
          // Every other failure in this tool returns `{ok:false}`; an EACCES /
          // ENOSPC here used to reject out of `execute` instead.
          try {
            await writeFile(output_path, result, 'utf-8');
          } catch (err: unknown) {
            return { ok: false, error: `Could not write ${output_path}: ${String(err)}` };
          }
          return {
            ok: true,
            output_path,
            contentLength: result.length,
            message: `Wrote ${result.length} characters to ${output_path}`,
          };
        }

        return {
          ok: true,
          result,
          contentLength: result.length,
          variableCount: Object.keys(variables).length,
        };
      },
    });

    // --- template_render ---
    api.tools.register({
      name: 'template_render',
      description: 'Read a template file from disk and expand it with the given variables.',
      inputSchema: {
        type: 'object',
        properties: {
          template_path: { type: 'string', description: 'Path to the template file' },
          variables: {
            type: 'object',
            description: 'Variables to substitute',
            additionalProperties: { type: 'string' },
          },
          output_path: {
            type: 'string',
            description: 'Optional path to write the rendered result',
          },
          raw: { type: 'boolean', default: false },
        },
        required: ['template_path', 'variables'],
      },
      // Same reasoning as `template_expand` above.
      permission: 'confirm',
      capabilities: ['fs.write'],
      riskTier: 'destructive',
      mutating: true,
      async execute(input: Record<string, unknown>) {
        const template_path = input['template_path'];
        const variables = input['variables'] as Record<string, string> | undefined;
        const output_path = input['output_path'] as string | undefined;
        const raw = (input['raw'] as boolean | undefined) ?? false;

        if (!template_path || typeof template_path !== 'string') {
          return { ok: false, error: 'template_path is required and must be a string' };
        }
        const templatePathError = validateRelativeTemplatePath('template_path', template_path);
        if (templatePathError) return { ok: false, error: templatePathError };
        if (!variables || typeof variables !== 'object') {
          return { ok: false, error: 'variables is required and must be an object' };
        }

        let content: string;
        try {
          content = await readFile(template_path, 'utf-8');
        } catch (err: unknown) {
          return { ok: false, error: `Could not read template file: ${err}` };
        }

        let result: string;
        /* v8 ignore start -- the render pipeline (regex replaces) does not throw; this guard is defensive. */
        try {
          result = raw
            ? renderTemplateRaw(content, variables)
            : renderTemplate(content, variables, autoEscapeHtml);
        } catch (err: unknown) {
          return { ok: false, error: `Template rendering failed: ${err}` };
        }
        /* v8 ignore stop */

        if (output_path) {
          const pathError = validateWritableTemplateTarget('output_path', output_path);
          if (pathError) return { ok: false, error: pathError };
          try {
            await writeFile(output_path, result, 'utf-8');
          } catch (err: unknown) {
            return { ok: false, error: `Could not write ${output_path}: ${String(err)}` };
          }
          return {
            ok: true,
            template_path,
            output_path,
            message: `Rendered and wrote ${result.length} chars to ${output_path}`,
          };
        }

        return {
          ok: true,
          template_path,
          result,
          contentLength: result.length,
        };
      },
    });

    // --- template_create ---
    api.tools.register({
      name: 'template_create',
      description: "Save a named template to the plugin's template store for later use.",
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            maxLength: MAX_TEMPLATE_NAME_CHARS,
            description: 'Unique name for this template',
          },
          content: {
            type: 'string',
            maxLength: MAX_TEMPLATE_CONTENT_CHARS,
            description: 'Template content with {{variable}} placeholders',
          },
          description: {
            type: 'string',
            maxLength: MAX_TEMPLATE_DESCRIPTION_CHARS,
            description: 'Optional description of what this template is for',
          },
        },
        required: ['name', 'content'],
      },
      permission: 'auto',
      mutating: false,
      async execute(input: Record<string, unknown>) {
        const name = input['name'] as string;
        const content = input['content'] as string;
        const description = input['description'] as string | undefined;

        if (!name || typeof name !== 'string' || name.trim() === '') {
          return { ok: false, error: 'name is required and must be a non-empty string' };
        }
        if (!content || typeof content !== 'string') {
          return { ok: false, error: 'content is required and must be a string' };
        }
        if (name.length > MAX_TEMPLATE_NAME_CHARS) {
          return { ok: false, error: `name exceeds ${MAX_TEMPLATE_NAME_CHARS} characters` };
        }
        if (content.length > MAX_TEMPLATE_CONTENT_CHARS) {
          return {
            ok: false,
            error: `content exceeds ${MAX_TEMPLATE_CONTENT_CHARS} characters`,
          };
        }
        if (description && description.length > MAX_TEMPLATE_DESCRIPTION_CHARS) {
          return {
            ok: false,
            error: `description exceeds ${MAX_TEMPLATE_DESCRIPTION_CHARS} characters`,
          };
        }

        const now = new Date().toISOString();
        const existing = templates.get(name);
        if (!existing && templates.size >= MAX_TEMPLATES) {
          return { ok: false, error: `template limit reached (${MAX_TEMPLATES})` };
        }

        const tmpl: StoredTemplate = {
          name,
          content,
          description,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };

        let retainedChars = 0;
        for (const stored of templates.values()) retainedChars += templateChars(stored);
        const nextChars =
          retainedChars - (existing ? templateChars(existing) : 0) + templateChars(tmpl);
        if (nextChars > MAX_TOTAL_TEMPLATE_CHARS) {
          return {
            ok: false,
            error: `template store exceeds ${MAX_TOTAL_TEMPLATE_CHARS} retained characters`,
          };
        }

        templates.set(name, tmpl);
        api.metrics.gauge('template_count', templates.size);

        return {
          ok: true,
          name,
          message: existing ? `Updated template '${name}'.` : `Created template '${name}'.`,
          createdAt: tmpl.createdAt,
        };
      },
    });

    // --- template_list ---
    api.tools.register({
      name: 'template_list',
      description: "List all templates saved in the plugin's template store.",
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      mutating: false,
      async execute() {
        const list = Array.from(templates.values()).map((t) => ({
          name: t.name,
          description: t.description,
          contentLength: t.content.length,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        }));

        return {
          ok: true,
          count: list.length,
          templates: list,
        };
      },
    });

    // System prompt contributor. Release any previous registration first
    // so a reload replaces it rather than stacking a duplicate.
    contributorUnregister = releaseHandle(contributorUnregister);
    contributorUnregister = api.registerSystemPromptContributor(async () => [
      {
        type: 'text' as const,
        text: `Template engine available:
- template_expand: expand a template string with {{variable}}, {{#if}} conditionals, {{#each}} loops
- template_render: render a template file with variables
- template_create: save a named template
- template_list: list saved templates`,
      },
    ]);

    api.log.info('template-engine plugin loaded', { version: '0.1.0' });
  },

  teardown(api) {
    // Drop every saved template so the next setup() starts from a
    // clean store (H1 fix — see module-level state comment above).
    // Templates are pure data so this is a single Map.clear().
    const count = templates.size;
    templates.clear();
    contributorUnregister = releaseHandle(contributorUnregister);
    api.log.info('template-engine: teardown complete', { cleared: count });
  },

  async health() {
    // Surface store size + total bytes via /diag plugins. Templates
    // are small (a few KB each) so totalBytes is a useful gauge of
    // store weight without paying for an aggregation per request.
    let totalBytes = 0;
    for (const t of templates.values()) {
      totalBytes += t.content.length;
    }
    return {
      ok: true,
      message: `template-engine: ${templates.size} saved template(s), ${totalBytes} bytes total`,
      count: templates.size,
      totalBytes,
    };
  },
};

export default plugin;
