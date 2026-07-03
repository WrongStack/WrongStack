import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  SKILL_LIMITS,
  type SkillLoader,
  stripFrontmatter,
  type Tool,
  ToolValidationError,
} from '@wrongstack/core';

interface SkillToolInput {
  name: string;
  /** Optional relative path of a bundled resource to load (e.g. `references/REF.md`, `scripts/extract.py`, `assets/template.html`). Omit to list resources. */
  resource?: string | undefined;
}

interface SkillResource {
  /** Path relative to the skill directory (e.g. `scripts/extract.py`). */
  path: string;
  bytes: number;
}

interface LoadedResource {
  rel: string;
  absPath: string;
  content: string;
  bytes: number;
  truncated: boolean;
}

interface SkillToolOutput {
  name: string;
  description: string;
  /** Frontmatter-stripped SKILL.md body (capped). */
  body: string;
  /** All bundled resource files (recursive), when no specific resource was requested. */
  resources: SkillResource[];
  /** Absolute directory of the skill — run scripts via bash using paths under here. */
  dir: string;
  /** When `resource` was requested: the loaded file. */
  loadedResource?: LoadedResource | undefined;
}

const MAX_BODY_CHARS = SKILL_LIMITS.MAX_SKILL_BODY_CHARS;
const MAX_RESOURCE_CHARS = SKILL_LIMITS.MAX_RESOURCE_CHARS;
const MAX_LISTED_RESOURCES = SKILL_LIMITS.MAX_LISTED_RESOURCES;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

/**
 * Skill tool — the agentskills.io progressive-disclosure primitive.
 *
 * - `skill({ name })` → SKILL.md body + a recursive listing of every bundled
 *   resource file (scripts/ references/ assets/ templates/ … any subdir).
 * - `skill({ name, resource })` → the content of that one resource file.
 *
 * Use this (not the `read` tool) to load skill resources: it works for foreign
 * skills that live outside the project root (e.g. `~/.claude/skills/…`), which
 * a project-root-restricted `read` tool may refuse. Scripts are returned with
 * their absolute path so the agent can run them via `bash`.
 */
export function makeSkillTool(skillLoader: SkillLoader): Tool<SkillToolInput, SkillToolOutput> {
  return {
    name: 'skill',
    category: 'Skills',
    description:
      "Load a skill's instructions or a bundled resource on demand (agentskills.io progressive disclosure). " +
      'With only `name`: returns the SKILL.md body + a list of bundled resource files. ' +
      'With `name` + `resource` (a relative path like `references/REF.md` or `scripts/extract.py`): returns that file content. ' +
      'Prefer this over the read tool for skill files — it reaches foreign skills outside the project root.',
    usageHint:
      'Load a skill body or one of its bundled resources (progressive disclosure).\n\n' +
      'WHEN TO USE:\n' +
      '- A task matches a skill trigger → load the body: skill({ name })\n' +
      '- You need a reference/template/script bundled with the skill → skill({ name, resource: "references/REF.md" })\n\n' +
      'The body call lists every bundled resource; load the ones you need. Run scripts via bash using the returned abs path.',
    permission: 'auto',
    mutating: false,
    capabilities: ['fs.read'],
    icon: 'document',
    timeoutMs: 5_000,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Exact skill name (as shown in the available-skills list).',
        },
        resource: {
          type: 'string',
          description:
            'Optional relative path of a bundled resource to load (e.g. references/REF.md, scripts/extract.py, assets/template.html). Omit to list resources.',
        },
      },
      required: ['name'],
    },
    async execute(input, ctx) {
      const name = input?.name?.trim();
      if (!name) {
        throw new ToolValidationError({ message: 'skill: name is required', field: 'name' });
      }
      const manifest = await skillLoader.find(name);
      if (!manifest) {
        throw new ToolValidationError({
          message: `skill "${name}" not found — use /skill to list available skills`,
          field: 'name',
        });
      }
      const dir = path.dirname(manifest.path);

      // Loading a specific resource takes precedence; skip the (potentially large)
      // full listing in that case to keep the response focused.
      let loadedResource: LoadedResource | undefined;
      if (input.resource?.trim()) {
        loadedResource = await loadResource(dir, input.resource.trim());
      }

      const raw = await skillLoader.readBody(name);
      const body = stripFrontmatter(raw).trim().slice(0, MAX_BODY_CHARS);
      const resources = loadedResource ? [] : await listResources(dir);

      try {
        await ctx?.session?.append({
          type: 'skill_activated',
          ts: new Date().toISOString(),
          skillName: manifest.name,
        });
      } catch {
        // best-effort: session recording must never break skill loading
      }

      return {
        name: manifest.name,
        description: manifest.description,
        body,
        resources,
        dir,
        loadedResource,
      };
    },
    serialize(output) {
      if (output.loadedResource) {
        const lr = output.loadedResource;
        const note = lr.truncated
          ? ` (truncated to ${lr.content.length} chars of ${lr.bytes} B)`
          : '';
        return `# Resource: ${output.name}/${lr.rel}\n(abs path: ${lr.absPath})${note}\n\n${lr.content}`;
      }
      const head = `# Skill: ${output.name}\n${output.description}\n\n${output.body}`;
      if (output.resources.length === 0) return head;
      const listing = output.resources.map((r) => `- ${r.path} (${r.bytes} B)`).join('\n');
      return (
        `${head}\n\n## Bundled resources (load on demand)\n` +
        `Load any with: \`skill({ name: "${output.name}", resource: "<path>" })\`. ` +
        `Run scripts via bash using their abs path under ${output.dir}.\n${listing}`
      );
    },
  };
}

/** Load a single bundled resource by relative path, with a path-traversal guard. */
async function loadResource(skillDir: string, rel: string): Promise<LoadedResource> {
  const norm = rel.replace(/\\/g, '/');
  if (path.isAbsolute(rel) || norm.split('/').some((seg) => seg === '..')) {
    throw new ToolValidationError({
      message: `skill: invalid resource path "${rel}"`,
      field: 'resource',
    });
  }
  const absPath = path.resolve(skillDir, rel);
  const root = path.resolve(skillDir);
  if (absPath !== root && !absPath.startsWith(root + path.sep)) {
    throw new ToolValidationError({
      message: `skill: resource "${rel}" escapes the skill directory`,
      field: 'resource',
    });
  }
  let buf: Buffer;
  try {
    buf = await fs.readFile(absPath);
  } catch {
    throw new ToolValidationError({
      message: `skill: resource "${rel}" not readable`,
      field: 'resource',
    });
  }
  const raw = buf.toString('utf8');
  const truncated = raw.length > MAX_RESOURCE_CHARS;
  return {
    rel: norm,
    absPath,
    content: truncated ? raw.slice(0, MAX_RESOURCE_CHARS) : raw,
    bytes: buf.length,
    truncated,
  };
}

/** Recursively list every file in the skill dir (any subdir), except SKILL.md. */
async function listResources(skillDir: string): Promise<SkillResource[]> {
  const out: SkillResource[] = [];
  await walk(skillDir, skillDir, out);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out.slice(0, MAX_LISTED_RESOURCES);
}

async function walk(root: string, dir: string, out: SkillResource[]): Promise<void> {
  if (out.length >= MAX_LISTED_RESOURCES) return;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_LISTED_RESOURCES) return;
    const fullPath = path.join(dir, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        isDir = (await fs.stat(fullPath)).isDirectory();
      } catch {
        continue; // broken symlink
      }
    }
    if (isDir) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      await walk(root, fullPath, out);
    } else if (e.isFile()) {
      if (e.name === 'SKILL.md' || e.name === 'SKILL.save.md') continue;
      try {
        const stat = await fs.stat(fullPath);
        const rel = path.relative(root, fullPath).split(path.sep).join('/');
        out.push({ path: rel, bytes: stat.size });
      } catch {
        // skip unreadable entry
      }
    }
  }
}
