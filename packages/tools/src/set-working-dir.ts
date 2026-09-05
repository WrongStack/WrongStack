import * as fs from 'node:fs/promises';
import type { Context } from '@wrongstack/core/agent';
import type { Tool } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';

// ── Types ──────────────────────────────────────────────────────────────────

export interface SetWorkingDirInput {
  /** Relative or absolute path to navigate to. Must stay within projectRoot. */
  path?: string | undefined;
}

export interface SetWorkingDirOutput {
  /** The new working directory (absolute path). */
  current: string;
  /** The previous working directory (absolute path). */
  previous?: string | undefined;
  /** Human-readable confirmation message. */
  message?: string | undefined;
  /** Error if the directory doesn't exist or is outside the project root. */
  error?: string | undefined;
}

// ── Tool ───────────────────────────────────────────────────────────────────

export const setWorkingDirTool: Tool<SetWorkingDirInput, SetWorkingDirOutput> = {
  name: 'set_working_dir',
  category: 'Context',
  description:
    'Change the current working directory for subsequent file operations and shell tools ' +
    '(`bash`/`exec` spawn in this directory unless given an explicit cwd). ' +
    'The new directory must be inside the project root. ' +
    'Use this to navigate between subdirectories when working on files in different parts of the project.',
  usageHint:
    'Change the working directory so relative paths in subsequent tool calls resolve from a ' +
    'different directory. Pass `path` to set a new directory, or omit to query the current one. ' +
    'The directory must exist and be inside the project root.',
  permission: 'confirm',
  mutating: true,
  capabilities: ['fs.read'],
  icon: 'settings',
  timeoutMs: 5_000,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Directory to navigate to. Can be relative (to projectRoot) or absolute. ' +
          'If omitted, returns the current working directory without changing it.',
      },
    },
  },
  async execute(input, ctx: Context, _opts?: { signal: AbortSignal }) {
    if (!input.path) {
      return {
        current: ctx.workingDir,
        message: `Current working directory is ${ctx.workingDir}`,
      };
    }

    const previous = ctx.workingDir;

    // Validate and set the new working directory
    let resolved: string;
    try {
      resolved = ctx.setWorkingDir(input.path);
    } catch (err) {
      return {
        current: ctx.workingDir,
        error: toErrorMessage(err),
      };
    }

    // Verify the target actually exists on disk AND is a directory.
    // fs.access() alone accepted plain files, leaving workingDir pointing at
    // a file — every later spawn/path-resolve then failed confusingly.
    let isDirectory = false;
    try {
      isDirectory = (await fs.stat(resolved)).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      // Rollback — setWorkingDir validated containment but the target is
      // missing or not a directory. Restore previous and report the error.
      try {
        if (typeof previous === 'string') {
          ctx.setWorkingDir(previous);
        } else {
          ctx.workingDir = previous;
        }
      } catch {
        ctx.workingDir = previous;
      }
      return {
        current: ctx.workingDir,
        error: `Directory does not exist (or is not a directory): ${resolved}`,
      };
    }

    return {
      current: resolved,
      previous,
      message: `Working directory changed to ${resolved}`,
    };
  },
};
