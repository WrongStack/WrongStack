import { randomUUID } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { type Tool, ToolValidationError } from '@wrongstack/contracts/types';
import { ToolCapabilities } from '@wrongstack/core/security';
import { isBinaryBuffer } from './_util.js';
import type { ArtifactPresentation } from './artifact-presentation.js';
import { liveBrowser } from './browser/tools.js';

export interface PresentArtifactInput {
  path?: string | undefined;
  browserSessionId?: string | undefined;
  title?: string | undefined;
}

export const presentArtifactTool: Tool<PresentArtifactInput, ArtifactPresentation> = {
  name: 'present_artifact',
  category: 'Meta',
  icon: 'document',
  permission: 'auto',
  mutating: false,
  capabilities: [ToolCapabilities.FS_READ],
  description:
    'Present an existing project text file, raster image, unified diff, or an owned live browser session. Graphical surfaces use read-only previews or their file viewer. The request is scoped to the current session and does not change contents.',
  usageHint:
    'Use a project-relative path (text/diff up to 2 MB, raster images up to 4 MB), or browserSessionId from browser_open, and an optional title. Call once per result. This requests presentation; it does not prove display. HTML/SVG are source, never executable previews.',
  // No top-level oneOf/allOf/anyOf: Anthropic-bound surfaces (the WrongForge
  // gateway) reject those outright. "path or browserSessionId" is enforced by
  // execute() and stated in the property descriptions instead.
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      browserSessionId: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description:
          'Existing live browser session opened by this agent in this conversation. Required unless path is given.',
      },
      path: {
        type: 'string',
        minLength: 1,
        maxLength: 4096,
        description:
          'Existing file relative to the project root. Required unless browserSessionId is given.',
      },
      title: {
        type: 'string',
        minLength: 1,
        maxLength: 160,
        description: 'Short label for the result.',
      },
    },
  },
  async execute(input, ctx, options) {
    const signal = options?.signal ?? ctx.signal;
    signal?.throwIfAborted();
    const sessionId = ctx.eventSessionId();
    const invalid = (message: string) =>
      new ToolValidationError({ message: `present_artifact: ${message}`, field: 'path' });
    if (!sessionId?.trim() || sessionId.length > 256 || /[\x00-\x1f\x7f]/.test(sessionId))
      throw invalid('an owning session is required');
    if (input?.browserSessionId !== undefined) {
      if (
        input.path !== undefined ||
        typeof input.browserSessionId !== 'string' ||
        !/^[\w-]{1,128}$/.test(input.browserSessionId)
      )
        throw invalid('choose a file or browser session');
      const sessions = await liveBrowser.sessions(ctx.projectRoot);
      const browser = sessions.find(
        (item) =>
          item.id === input.browserSessionId &&
          item.conversationId === sessionId &&
          item.ownerId === (ctx.agentId || 'leader'),
      );
      if (!browser) throw invalid('browser is not owned by this agent and conversation');
      signal?.throwIfAborted();
      if (ctx.eventSessionId() !== sessionId)
        throw invalid('session changed while resolving the artifact');
      if (
        input.title !== undefined &&
        (typeof input.title !== 'string' ||
          !input.title.trim() ||
          input.title.length > 160 ||
          /[\x00-\x1f\x7f]/.test(input.title))
      )
        throw invalid('invalid title');
      return {
        type: 'artifact.presentation',
        version: 2,
        id: randomUUID(),
        sessionId,
        path: 'browser',
        kind: 'browser',
        browserSessionId: browser.id,
        title: input.title?.trim() ?? 'Live browser',
      };
    }
    if (
      !input ||
      typeof input.path !== 'string' ||
      !input.path.trim() ||
      input.path.length > 4096 ||
      /[\x00-\x1f\x7f]/.test(input.path)
    )
      throw invalid('provide an existing project file');
    if (
      input.title !== undefined &&
      (typeof input.title !== 'string' ||
        !input.title.trim() ||
        input.title.length > 160 ||
        /[\x00-\x1f\x7f]/.test(input.title))
    )
      throw invalid('title must contain 1 to 160 printable characters');
    const root = await realpath(ctx.projectRoot);
    const lexical = path.resolve(root, input.path);
    const inside = (target: string) => {
      const rel = path.relative(root, target);
      return (
        rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
      );
    };
    if (!inside(lexical)) throw invalid('file must stay inside the project');
    const resolved = await realpath(lexical);
    if (!inside(resolved)) throw invalid('symlink target must stay inside the project');
    const file = await open(resolved, 'r');
    let kind: 'text' | 'image' | 'diff' = /\.(patch|diff)$/i.test(resolved) ? 'diff' : 'text';
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
        throw invalid('select a text file up to 2 MB or raster image up to 4 MB');
      const sample = Buffer.alloc(Math.min(stat.size, 8192));
      const { bytesRead } = await file.read(sample, 0, sample.length, 0);
      const bytes = sample.subarray(0, bytesRead);
      const ascii = (at: number, text: string) =>
        bytes.subarray(at, at + text.length).toString('ascii') === text;
      const raster =
        (bytes[0] === 0x89 && ascii(1, 'PNG')) ||
        (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
        ascii(0, 'GIF8') ||
        (ascii(0, 'RIFF') && ascii(8, 'WEBP')) ||
        ascii(0, 'BM') ||
        (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) ||
        ascii(4, 'ftypavif') ||
        ascii(4, 'ftypavis');
      if (raster) kind = 'image';
      else if (isBinaryBuffer(bytes))
        throw invalid('binary files are not supported by the file viewer');
      if (kind !== 'image' && stat.size > 2 * 1024 * 1024)
        throw invalid('select a text file up to 2 MB');
    } finally {
      await file.close();
    }
    signal?.throwIfAborted();
    if (ctx.eventSessionId() !== sessionId)
      throw invalid('session changed while resolving the artifact');
    const relative = path.relative(root, resolved).split(path.sep).join('/');
    if (relative.includes(':') || relative.includes('\\'))
      throw invalid('file path is not supported by the viewer');
    return {
      type: 'artifact.presentation',
      version: 2,
      kind,
      id: randomUUID(),
      sessionId,
      path: relative,
      title: input.title?.trim() ?? path.basename(relative),
    };
  },
};
