import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  missingRequiredRuntimeTools,
  missingRuntimeCapabilities,
  runtimeToolReferencesFromText,
} from '@wrongstack/core/agent-catalog';
import {
  markRecommendedSkillLoaded,
  markRecommendedSkillUnavailable,
  markRequiredSkillLoaded,
  markRequiredSkillUnavailable,
  SKILL_LIMITS,
  stripFrontmatter,
} from '@wrongstack/core/skills';
import type { SkillLoader, Tool } from '@wrongstack/core/types';
import { ToolValidationError } from '@wrongstack/core/types';

export interface SkillToolInput {
  name: string;
  /** Character offset for continuing a long body or resource. */
  offset?: number | undefined;
  /** Optional relative path of a bundled resource to load (e.g. `references/REF.md`, `scripts/extract.py`, `assets/template.html`). Omit to list resources. */
  resource?: string | undefined;
}

export interface SkillResource {
  /** Path relative to the skill directory (e.g. `scripts/extract.py`). */
  path: string;
  bytes: number;
}

export interface LoadedResource {
  rel: string;
  absPath: string;
  content: string;
  bytes: number;
  truncated: boolean;
  nextOffset?: number | undefined;
}

export interface SkillToolOutput {
  name: string;
  description: string;
  /** Frontmatter-stripped SKILL.md body (capped). */
  body: string;
  /** Present when more instructions remain. */
  nextOffset?: number | undefined;
  totalChars?: number | undefined;
  /** All bundled resource files (recursive), when no specific resource was requested. */
  resources: SkillResource[];
  /** Absolute directory of the skill — run scripts via bash using paths under here. */
  dir: string;
  /** When `resource` was requested: the loaded file. */
  loadedResource?: LoadedResource | undefined;
  /**
   * Soft advisory: prose in the skill body mentions tools not registered in
   * this runtime (e.g. hidden by a token-saving tier). The skill still loads —
   * only `manifest.requiredTools` hard-fails.
   */
  warning?: string | undefined;
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
    // A page is already bounded (MAX_SKILL_BODY_CHARS body, MAX_RESOURCE_CHARS
    // resource, MAX_LISTED_RESOURCES entries) and continues via nextOffset.
    // Previewing it instead — a lowered `limits.toolOutputPreviewBytes`, or a
    // batch whose other results used up the iteration budget — handed the model
    // the head of the instructions and a file path while the call still
    // reported the skill as loaded.
    preserveFullOutput: true,
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
        offset: {
          type: 'integer',
          minimum: 0,
          description:
            'Character offset returned as nextOffset to continue reading a long body or resource.',
        },
        resource: {
          type: 'string',
          description:
            'Optional relative path of a bundled resource to load (e.g. references/REF.md, scripts/extract.py, assets/template.html). Omit to list resources.',
        },
      },
      required: ['name'],
    },
    async execute(input, ctx, opts) {
      const name = input?.name?.trim();
      if (!name) {
        throw new ToolValidationError({ message: 'skill: name is required', field: 'name' });
      }
      const offset = input.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new ToolValidationError({
          message: 'skill: offset must be a non-negative integer',
          field: 'offset',
        });
      // Activation must observe wizard/file-tool/editor changes made since discovery.
      skillLoader.invalidateCache?.();
      const manifest = await skillLoader.find(name);
      if (!manifest) {
        // A required skill that cannot be provided must not hold the run's
        // edits hostage; the failed load releases it and the run reports it.
        markRequiredSkillUnavailable(ctx, name);
        markRecommendedSkillUnavailable(ctx, name);
        throw new ToolValidationError({
          message: `skill "${name}" not found — use /skill to list available skills`,
          field: 'name',
        });
      }
      const availableToolNames = (ctx?.catalogTools ?? ctx?.tools ?? []).map((tool) => tool.name);
      const missingCapabilities = missingRuntimeCapabilities(
        manifest.requiredCapabilities,
        availableToolNames,
      );
      const missingTools = missingRequiredRuntimeTools(manifest.requiredTools, availableToolNames);
      if (missingCapabilities.length > 0 || missingTools.length > 0) {
        markRequiredSkillUnavailable(ctx, manifest.name);
        markRecommendedSkillUnavailable(ctx, manifest.name);
        throw new ToolValidationError({
          message:
            `skill "${name}" is unavailable in this runtime; ` +
            [
              missingCapabilities.length > 0
                ? `missing capabilities: ${missingCapabilities.join(', ')}`
                : '',
              missingTools.length > 0 ? `missing tools: ${missingTools.join(', ')}` : '',
            ]
              .filter(Boolean)
              .join('; '),
          field: 'name',
        });
      }
      const dir = path.dirname(manifest.path);

      // Loading a specific resource takes precedence; skip the (potentially large)
      // full listing in that case to keep the response focused.
      let loadedResource: LoadedResource | undefined;
      if (input.resource?.trim()) {
        loadedResource = await loadResource(dir, input.resource.trim(), offset);
      }

      const raw = await skillLoader.readBody(name);
      // Body-text tool references are advisory only: prose may mention tools
      // hidden by a token-saving tier or optional integrations, and hard-failing
      // here made such skills unloadable. Only manifest.requiredTools (checked
      // above) blocks the load; body mentions produce a warning in the output.
      const missingBodyTools = missingRequiredRuntimeTools(
        runtimeToolReferencesFromText(raw),
        availableToolNames,
      );
      const warning =
        missingBodyTools.length > 0
          ? `Warning: skill "${name}" references tools not registered in this runtime: ${missingBodyTools.join(', ')}. Steps that call them may be unavailable.`
          : undefined;
      const fullBody = stripFrontmatter(raw).trim();
      const body = fullBody.slice(offset, offset + MAX_BODY_CHARS);
      const nextOffset = offset + body.length < fullBody.length ? offset + body.length : undefined;
      const resources = loadedResource ? [] : await listResources(dir);
      // Only the page that finishes the body counts toward a required-skill gate.
      if (!loadedResource && nextOffset === undefined) {
        markRequiredSkillLoaded(ctx, manifest.name, opts?.toolUseId);
        markRecommendedSkillLoaded(ctx, manifest.name);
        try {
          await ctx?.session?.append({
            type: 'skill_activated',
            ts: new Date().toISOString(),
            skillName: manifest.name,
          });
        } catch {
          // best-effort: session recording must never break skill loading
        }
      }

      return {
        name: manifest.name,
        description: manifest.description,
        body,
        nextOffset,
        totalChars: fullBody.length,
        resources,
        dir,
        loadedResource,
        warning,
      };
    },
    serialize(output) {
      const warningLine = output.warning ? `\n\n${output.warning}` : '';
      if (output.loadedResource) {
        const lr = output.loadedResource;
        const note = lr.truncated
          ? ` (more content remains; continue with skill({ name: "${output.name}", resource: "${lr.rel}", offset: ${lr.nextOffset} }))`
          : '';
        return `# Resource: ${output.name}/${lr.rel}\n(abs path: ${lr.absPath})${note}\n\n${lr.content}${warningLine}`;
      }
      const continuation =
        output.nextOffset !== undefined
          ? `\n\nMore instructions remain. Read them before following this skill: skill({ name: "${output.name}", offset: ${output.nextOffset} }).`
          : '';
      const head = `# Skill: ${output.name}\n${output.description}\nSkill directory: ${output.dir} (resolve relative paths here).\n\n${output.body}${continuation}`;
      if (output.resources.length === 0) return `${head}${warningLine}`;
      const listing = output.resources.map((r) => `- ${r.path} (${r.bytes} B)`).join('\n');
      return (
        `${head}\n\n## Bundled resources (load on demand)\n` +
        `Load any with: \`skill({ name: "${output.name}", resource: "<path>" })\`. ` +
        `Run scripts via bash using their abs path under ${output.dir}.\n${listing}${warningLine}`
      );
    },
  };
}

/** Load a single bundled resource by relative path, with a path-traversal guard. */
async function loadResource(skillDir: string, rel: string, offset = 0): Promise<LoadedResource> {
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

  // The check above only proves the STRING stays under the skill directory. A
  // symlink placed inside `<repo>/.claude/skills/<name>/` satisfies it and
  // still resolves anywhere on the host. Skill directories are deliberately
  // not confined to the project root — they have to reach `~/.claude/skills`
  // and `~/.wrongstack/skills` — so this containment is the ENTIRE boundary,
  // and `skill` runs at `permission: 'auto'`, so nothing prompts the user.
  // Resolve both sides and re-check, then open the resolved path: validating
  // one path and opening another is the hole WS-048 closed elsewhere.
  let realPath: string;
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
    realPath = await fs.realpath(absPath);
  } catch {
    throw new ToolValidationError({
      message: `skill: resource "${rel}" not readable`,
      field: 'resource',
    });
  }
  if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
    throw new ToolValidationError({
      message: `skill: resource "${rel}" resolves outside the skill directory`,
      field: 'resource',
    });
  }

  let buf: Buffer;
  try {
    buf = await fs.readFile(realPath);
  } catch {
    throw new ToolValidationError({
      message: `skill: resource "${rel}" not readable`,
      field: 'resource',
    });
  }
  const raw = buf.toString('utf8');
  const truncated = raw.length > offset + MAX_RESOURCE_CHARS;
  return {
    rel: norm,
    // The canonical path — the one actually opened, and the one a follow-up
    // `bash` invocation should use.
    absPath: realPath,
    content: raw.slice(offset, offset + MAX_RESOURCE_CHARS),
    nextOffset: truncated ? offset + MAX_RESOURCE_CHARS : undefined,
    bytes: buf.length,
    truncated,
  };
}

/** Recursively list every file in the skill dir (any subdir), except SKILL.md. */
async function listResources(skillDir: string): Promise<SkillResource[]> {
  const out: SkillResource[] = [];
  const realRoot = await safeRealpath(skillDir);
  // The walk contract takes (root, rootReal, dir, out): `root` is the string-form
  // path used to label entries (path.relative(root, fullPath)), `rootReal` is
  // the realpath containment boundary (undefined when realpath failed), and
  // `dir` is the starting directory to walk. The round-1 fix accidentally
  // swapped `realRoot` and `skillDir` between the rootReal and dir positions,
  // which typechecked as `string | undefined` against `dir: string`. Pass
  // `realRoot` as the boundary and `skillDir` as the starting directory.
  await walk(realRoot ?? path.resolve(skillDir), realRoot, skillDir, out);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out.slice(0, MAX_LISTED_RESOURCES);
}

async function walk(
  root: string,
  rootReal: string | undefined,
  dir: string,
  out: SkillResource[],
): Promise<void> {
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
    // Re-check containment on the RESOLVED path before treating any entry —
    // symlink or otherwise — as part of the listing. The string-based
    // `path.relative(root, fullPath)` check below is a label, not a boundary:
    // a symlink under the skill dir can resolve anywhere on the host, and
    // `loadResource` already enforces the same `realpath` containment via
    // WS-048. Without this, the listing discloses names and sizes of files
    // under an attacker-chosen external directory into the model-facing tool
    // output and the session log, even though the subsequent read is blocked.
    let resolvedFull: string | undefined;
    if (rootReal !== undefined) {
      try {
        resolvedFull = await fs.realpath(fullPath);
      } catch {
        if (e.isSymbolicLink()) continue; // broken symlink
      }
      if (
        resolvedFull !== undefined &&
        resolvedFull !== rootReal &&
        !resolvedFull.startsWith(rootReal + path.sep)
      ) {
        // Symlink (or hardlink via a junction) escapes the skill directory.
        // Refuse to enumerate it — both as a directory (no recursion) and as
        // a file (no listing entry).
        continue;
      }
    }
    if (e.isSymbolicLink() && resolvedFull === undefined) {
      try {
        isDir = (await fs.stat(fullPath)).isDirectory();
      } catch {
        continue; // broken symlink
      }
    }
    if (isDir) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      await walk(root, rootReal, fullPath, out);
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

/** Resolve `p` to its real path, or `undefined` if it can't be resolved. */
async function safeRealpath(p: string): Promise<string | undefined> {
  try {
    return await fs.realpath(p);
  } catch {
    return undefined;
  }
}
