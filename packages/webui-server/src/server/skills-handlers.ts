/**
 * Shared skills WebSocket handlers for both the standalone WebUI server
 * (`packages/webui/src/server/index.ts`) and the CLI's `--webui` embedded
 * server (`packages/cli/src/webui-server.ts`).
 *
 * These were previously inlined in BOTH servers, and the CLI copy had
 * drifted — it only wired `skills.list`, so `skills.content` /
 * `skills.export` / `skills.update` (and install/uninstall/create/edit)
 * fell through to the "Unhandled message type" warning even though the
 * SkillsPanel sends them. Extracting the full set here gives both servers
 * one source of truth. Each function handles the full request→response
 * cycle for one message type; callers drop them into their switch:
 *
 *   case 'skills.content': return handleSkillsContent(ws, skillsCtx, msg);
 *
 * The logic is a verbatim lift of the standalone's inline cases — only the
 * dependency references changed (`skillLoader`/`skillInstaller`/
 * `projectRoot` → `ctx.*`, local `send`/`errMessage` → imported helpers).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { WebSocket } from 'ws';
import type { SkillLoader } from '@wrongstack/core/types';
import { atomicWrite, resolveWstackPaths } from '@wrongstack/core/utils';
import type { SkillInstaller } from '@wrongstack/core/skills';
import { send, errMessage, withRequestId } from './ws-utils.js';
import { validateSkillsCreatePayload, validateSkillsEditPayload } from './ws-payload-validation.js';
import { createZipBuffer, type ZipEntryInput } from './zip.js';

export interface SkillsContext {
  /** Backs skills.list/content/edit/export. Absent ⇒ feature disabled. */
  skillLoader: SkillLoader | undefined;
  /** Backs skills.install/uninstall/update. Absent ⇒ those ops disabled. */
  skillInstaller: SkillInstaller | undefined;
  /** Project root — used by skills.create to write `.wrongstack/skills/…`. */
  projectRoot: string;
  /** Project skills directory, normally `<project>/.wrongstack/skills`. */
  projectSkillsDir?: string | undefined;
  /** Profile skills directory, normally `~/.wrongstack/profiles/<name>/skills`. */
  globalSkillsDir?: string | undefined;
}

// ── Shared handlers ───────────────────────────────────────────────────

/**
 * List installed skills. Enriches each manifest with the source URL + git
 * ref recorded by the installer (when present), so the panel can show
 * provenance and offer update/uninstall.
 */
export async function handleSkillsList(
  ws: WebSocket,
  ctx: SkillsContext,
  msg?: unknown,
): Promise<void> {
  if (!ctx.skillLoader) {
    send(ws, {
      type: 'skills.list',
      payload: withRequestId(msg, { skills: [], enabled: false }),
    });
    return;
  }
  try {
    const manifests = await ctx.skillLoader.list();
    const entries = await ctx.skillLoader.listEntries();
    const byName = new Map(entries.map((e) => [e.name, e]));

    // Fetch source URLs and commit refs from the manifest (installed-skills.json)
    const sourceUrlsByName = new Map<string, string>();
    const refsByName = new Map<string, string>();
    if (ctx.skillInstaller) {
      try {
        const installed = await ctx.skillInstaller.listInstalled();
        for (const entry of installed) {
          sourceUrlsByName.set(entry.name, entry.source);
          refsByName.set(entry.name, entry.ref);
        }
      } catch {
        // Non-fatal — source URLs just won't be shown
      }
    }

    send(ws, {
      type: 'skills.list',
      payload: withRequestId(msg, {
        enabled: true,
        skills: manifests.map((m) => ({
          name: m.name,
          description: m.description,
          version: m.version ?? '',
          source: m.source,
          sourceUrl: sourceUrlsByName.get(m.name) ?? '',
          ref: refsByName.get(m.name) ?? '',
          path: m.path,
          trigger: byName.get(m.name)?.trigger ?? '',
          scope: byName.get(m.name)?.scope ?? [],
        })),
      }),
    });
  } catch (err) {
    send(ws, {
      type: 'skills.list',
      payload: withRequestId(msg, {
        skills: [],
        enabled: true,
        error: errMessage(err),
      }),
    });
  }
}

/**
 * Read a single skill's body + its directory's related files + which other
 * skills reference it by name. Powers the skill detail/preview view.
 */
export async function handleSkillsContent(
  ws: WebSocket,
  ctx: SkillsContext,
  msg: unknown,
): Promise<void> {
  if (!ctx.skillLoader) {
    send(ws, {
      type: 'skills.content',
      payload: {
        name: '',
        body: '',
        path: '',
        source: '',
        relatedFiles: [],
        references: [],
        error: 'Skills not enabled',
      },
    });
    return;
  }
  const contentPayload = (msg as { payload: { name: string; source: string } }).payload;
  if (!contentPayload?.name) {
    send(ws, {
      type: 'skills.content',
      payload: {
        name: '',
        body: '',
        path: '',
        source: '',
        relatedFiles: [],
        references: [],
        error: 'Skill name is required',
      },
    });
    return;
  }
  try {
    const { name, source } = contentPayload;
    const entries = await ctx.skillLoader.listEntries();
    const entry = entries.find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (!entry) {
      send(ws, {
        type: 'skills.content',
        payload: {
          name,
          body: '',
          path: '',
          source,
          relatedFiles: [],
          references: [],
          error: `Skill "${name}" not found`,
        },
      });
      return;
    }
    // Read body directly from path — avoids re-running find() which re-reads all SKILL.md files
    const body = await fs.readFile(entry.path, 'utf8');
    const skillDir = path.dirname(entry.path);

    // Related files — other files in the same skill directory
    let relatedFiles: string[] = [];
    try {
      const files = await fs.readdir(skillDir);
      relatedFiles = files
        .filter((f) => f !== path.basename(entry.path))
        .map((f) => path.join(skillDir, f));
    } catch {
      // Non-fatal
    }

    // References — which other skills reference this one (by name)
    // Read all other skill bodies in parallel, keyed by name for O(1) lookup
    const nameLower = name.toLowerCase();
    const refResults = await Promise.all(
      entries
        .filter((e) => e.name.toLowerCase() !== nameLower)
        .map(async (e): Promise<[string, boolean]> => {
          try {
            // Use entry.path directly to skip find() overhead
            const content = await fs.readFile(e.path, 'utf8');
            return [e.name, content.toLowerCase().includes(nameLower)];
          } catch {
            return [e.name, false];
          }
        }),
    );
    const refs = refResults.filter(([, hasRef]) => hasRef).map(([n]) => n);

    send(ws, {
      type: 'skills.content',
      payload: { name, body, path: entry.path, source, relatedFiles, references: refs },
    });
  } catch (err) {
    send(ws, {
      type: 'skills.content',
      payload: {
        name: contentPayload.name,
        body: '',
        path: '',
        source: contentPayload.source,
        relatedFiles: [],
        references: [],
        error: errMessage(err),
      },
    });
  }
}

/**
 * Install a skill from a git ref (`owner/repo` or URL). Optional `global`
 * installs into the user-wide skills dir instead of the project's.
 */
export async function handleSkillsInstall(
  ws: WebSocket,
  ctx: SkillsContext,
  msg: unknown,
): Promise<void> {
  if (!ctx.skillInstaller) {
    send(ws, {
      type: 'skills.installed',
      payload: { success: false, error: 'Skills not enabled' },
    });
    return;
  }
  const installPayload = (msg as { payload: { ref: string; global?: boolean } }).payload;
  if (!installPayload?.ref?.trim()) {
    send(ws, {
      type: 'skills.installed',
      payload: {
        success: false,
        error: 'Skill reference is required (e.g. owner/repo or https://github.com/owner/repo)',
      },
    });
    return;
  }
  try {
    const results = await ctx.skillInstaller.install(installPayload.ref.trim(), {
      global: installPayload.global,
    });
    send(ws, {
      type: 'skills.installed',
      payload: {
        success: true,
        results,
        error: null,
      },
    });
  } catch (err) {
    send(ws, {
      type: 'skills.installed',
      payload: {
        success: false,
        error: errMessage(err),
      },
    });
  }
}

/**
 * Uninstall a skill by name. Optional `global` restricts/Targets the
 * user-wide install.
 */
export async function handleSkillsUninstall(
  ws: WebSocket,
  ctx: SkillsContext,
  msg: unknown,
): Promise<void> {
  if (!ctx.skillInstaller) {
    send(ws, {
      type: 'skills.uninstalled',
      payload: { success: false, error: 'Skills not enabled' },
    });
    return;
  }
  const uninstallPayload = (msg as { payload: { name: string; global?: boolean } }).payload;
  if (!uninstallPayload?.name?.trim()) {
    send(ws, {
      type: 'skills.uninstalled',
      payload: { success: false, error: 'Skill name is required' },
    });
    return;
  }
  try {
    await ctx.skillInstaller.uninstall(uninstallPayload.name.trim(), {
      global: uninstallPayload.global,
    });
    send(ws, { type: 'skills.uninstalled', payload: { success: true, error: null } });
  } catch (err) {
    send(ws, { type: 'skills.uninstalled', payload: { success: false, error: errMessage(err) } });
  }
}

/**
 * Update one skill (`name`) or all installed skills (when `name` is
 * omitted). Reports per-skill updated/unchanged/error tallies.
 */
export async function handleSkillsUpdate(
  ws: WebSocket,
  ctx: SkillsContext,
  msg: unknown,
): Promise<void> {
  if (!ctx.skillInstaller) {
    send(ws, { type: 'skills.updated', payload: { success: false, error: 'Skills not enabled' } });
    return;
  }
  const updatePayload = (msg as { payload?: { name?: string; global?: boolean } | undefined })
    .payload;
  try {
    const result = await ctx.skillInstaller.update(updatePayload?.name, {
      global: updatePayload?.global,
    });
    send(ws, {
      type: 'skills.updated',
      payload: {
        success: true,
        error: null,
        updated: result.updated,
        unchanged: result.unchanged,
        errors: result.errors,
      },
    });
  } catch (err) {
    send(ws, { type: 'skills.updated', payload: { success: false, error: errMessage(err) } });
  }
}

/**
 * Scaffold a new project- or global-scoped skill from a name + description.
 * Writes a templated `SKILL.md` under `.wrongstack/skills/<name>/` (project)
 * or the user-wide skills dir (global).
 */
export async function handleSkillsCreate(
  ws: WebSocket,
  ctx: SkillsContext,
  msg: unknown,
): Promise<void> {
  const parsed = validateSkillsCreatePayload((msg as { payload?: unknown }).payload);
  if (!parsed.ok) {
    send(ws, { type: 'skills.created', payload: { success: false, error: parsed.message } });
    return;
  }
  const createPayload = parsed.value;
  try {
    const targetDir =
      createPayload.scope === 'global'
        ? path.join(
            ctx.globalSkillsDir ??
              resolveWstackPaths({ projectRoot: ctx.projectRoot }).globalSkills,
            createPayload.name.trim(),
          )
        : path.join(
            ctx.projectSkillsDir ?? path.join(ctx.projectRoot, '.wrongstack', 'skills'),
            createPayload.name.trim(),
          );

    // Check if directory already exists
    try {
      await fs.access(targetDir);
      send(ws, {
        type: 'skills.created',
        payload: { success: false, error: `Skill "${createPayload.name}" already exists` },
      });
      return;
    } catch {
      // Directory does not exist — good
    }

    await fs.mkdir(targetDir, { recursive: true });

    // Parse description lines to build the skill content
    const lines = createPayload.description.trim().split('\n');
    const firstLine = (lines[0] ?? '').trim();
    const bodyLines = lines
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean);
    const descriptionText = firstLine + (bodyLines.length > 0 ? `\n${bodyLines.join('\n')}` : '');
    const trigger = bodyLines.find((l) => l.toLowerCase().startsWith('triggers:')) ?? '';

    const skillContent = [
      '---',
      `name: ${createPayload.name.trim()}`,
      'description: |',
      `  ${descriptionText.replace(/\n/g, '\n  ')}`,
      `version: 1.0.0`,
      '---',
      '',
      `# ${createPayload.name
        .trim()
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')}`,
      '',
      '## Overview',
      '',
      firstLine,
      '',
      ...(bodyLines.length > 0
        ? bodyLines.filter((l) => !l.toLowerCase().startsWith('triggers:'))
        : []),
      '',
      '## Rules',
      '- TODO: add your first rule',
      '',
      '## Patterns',
      '### Do',
      '```ts',
      '// TODO: add a good example',
      '```',
      '',
      "### Don't",
      '```ts',
      '// TODO: add a bad example',
      '```',
      '',
      '## Workflow',
      '1. TODO: describe step one',
      '2. TODO: describe step two',
      '',
      trigger ? `\n${trigger}\n` : '',
      '## Skills in scope',
      '- `bug-hunter` — for systematic bug detection patterns',
      '- `output-standards` — for standardized `<nextsteps>` formatting',
    ].join('\n');

    await atomicWrite(path.join(targetDir, 'SKILL.md'), skillContent);

    // Invalidate the SkillLoader cache so the new skill appears immediately
    // in skills.list and the system prompt builder. Without this, the
    // DefaultSkillLoader caches its results and the skill would stay invisible
    // until the next process restart.
    ctx.skillLoader?.invalidateCache();

    send(ws, {
      type: 'skills.created',
      payload: {
        success: true,
        error: null,
        skill: {
          name: createPayload.name.trim(),
          path: path.join(targetDir, 'SKILL.md'),
          scope: createPayload.scope,
        },
      },
    });
  } catch (err) {
    send(ws, { type: 'skills.created', payload: { success: false, error: errMessage(err) } });
  }
}

/**
 * Overwrite a skill's body. Refuses bundled skills (read-only) and unknown
 * names.
 */
export async function handleSkillsEdit(
  ws: WebSocket,
  ctx: SkillsContext,
  msg: unknown,
): Promise<void> {
  if (!ctx.skillLoader) {
    send(ws, { type: 'skills.edited', payload: { success: false, error: 'Skills not enabled' } });
    return;
  }
  const parsed = validateSkillsEditPayload((msg as { payload?: unknown }).payload);
  if (!parsed.ok) {
    send(ws, { type: 'skills.edited', payload: { success: false, error: parsed.message } });
    return;
  }
  const editPayload = parsed.value;
  try {
    const entries = await ctx.skillLoader.listEntries();
    const entry = entries.find((e) => e.name.toLowerCase() === editPayload.name.toLowerCase());
    if (!entry) {
      send(ws, {
        type: 'skills.edited',
        payload: { success: false, error: `Skill "${editPayload.name}" not found` },
      });
      return;
    }
    // Only allow editing WrongStack-managed skills (project/user). Bundled and
    // foreign (.claude/*, extra) sources are read-only — editing them would
    // write into another tool's directory.
    if (entry.source !== 'project' && entry.source !== 'user') {
      const label = entry.source === 'bundled' ? 'Bundled' : 'Foreign (read-only)';
      send(ws, {
        type: 'skills.edited',
        payload: { success: false, error: `${label} skills cannot be edited` },
      });
      return;
    }
    await atomicWrite(entry.path, editPayload.body);
    // Invalidate the SkillLoader cache so the edited body is picked up
    // immediately by readBody and the system prompt builder.
    ctx.skillLoader?.invalidateCache();
    send(ws, { type: 'skills.edited', payload: { success: true, error: null } });
  } catch (err) {
    send(ws, { type: 'skills.edited', payload: { success: false, error: errMessage(err) } });
  }
}

/**
 * Export every readable skill as a base64-encoded zip (one folder per skill,
 * each with its `SKILL.md`). Powers the panel's "Export all" button.
 */
export async function handleSkillsExport(ws: WebSocket, ctx: SkillsContext): Promise<void> {
  if (!ctx.skillLoader) {
    send(ws, {
      type: 'skills.exported',
      payload: { zipBase64: '', skillCount: 0, error: 'Skills not enabled' },
    });
    return;
  }
  try {
    const entries = await ctx.skillLoader.listEntries();
    const zipEntries: ZipEntryInput[] = [];
    for (const entry of entries) {
      try {
        const body = await ctx.skillLoader!.readBody(entry.name);
        const safeName = entry.name.replace(/[\\/]/g, '_');
        zipEntries.push({ name: `${safeName}/SKILL.md`, data: body });
      } catch {
        // Skip skills we can't read
      }
    }
    const zipBuffer = createZipBuffer(zipEntries);
    const zipBase64 = zipBuffer.toString('base64');
    send(ws, {
      type: 'skills.exported',
      payload: { zipBase64, skillCount: zipEntries.length, error: undefined },
    });
  } catch (err) {
    send(ws, {
      type: 'skills.exported',
      payload: { zipBase64: '', skillCount: 0, error: errMessage(err) },
    });
  }
}
