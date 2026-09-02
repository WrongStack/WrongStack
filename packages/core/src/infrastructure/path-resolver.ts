import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PathResolver } from '../types/path-resolver.js';

const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'pnpm-workspace.yaml',
  'go.mod',
  'Cargo.toml',
  'pyproject.toml',
  // Use AGENTS.md, not the bare .wrongstack directory.  A bare .wrongstack/
  // directory can be the global config directory (~/.wrongstack), which is
  // NOT a project marker.  Only .wrongstack/AGENTS.md signals a real
  // WrongStack project.
  '.wrongstack/AGENTS.md',
];

export class DefaultPathResolver implements PathResolver {
  readonly projectRoot: string;
  readonly cwd: string;

  constructor(cwd: string = process.cwd()) {
    this.cwd = path.resolve(cwd);
    this.projectRoot = this.detectProjectRoot(this.cwd);
  }

  detectProjectRoot(start: string): string {
    let dir = path.resolve(start);
    const root = path.parse(dir).root;
    const home = path.resolve(os.homedir());
    const startPath = path.resolve(start);
    while (dir !== root) {
      // Don't walk past the user home directory.  Home often has stray
      // markers (.git for dotfile tracking, package.json from global
      // tooling) that are unrelated to the actual working directory.
      // When cwd IS home we still check markers there — this guard
      // only fires during the upward walk from a subdirectory.
      if (dir === home && dir !== startPath) {
        break;
      }
      for (const marker of PROJECT_MARKERS) {
        try {
          fs.accessSync(path.join(dir, marker));
          return dir;
        } catch {
          // continue
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return startPath;
  }

  resolve(input: string): string {
    const abs = path.isAbsolute(input) ? input : path.resolve(this.cwd, input);
    let real: string;
    try {
      real = fs.realpathSync(abs);
    } catch {
      // path doesn't exist yet; normalize without resolving symlinks
      real = path.normalize(abs);
    }
    return real;
  }

  isInsideRoot(absPath: string): boolean {
    const normalized = path.normalize(absPath);
    const root = path.normalize(this.projectRoot);
    if (normalized === root) return true;
    const rel = path.relative(root, normalized);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  ensureInsideRoot(absPath: string): string {
    const resolved = this.resolve(absPath);
    if (!this.isInsideRoot(resolved)) {
      // Render the input as a project-relative-looking string when possible
      // so the error message can flow through telemetry / LLM transcripts
      // without leaking the absolute project root layout.
      const display = path.isAbsolute(absPath) ? path.basename(absPath) : absPath;
      const err = new Error(`Path "${display}" resolves outside the project root`);
      // Keep the full information available to programmatic callers; only
      // the user-facing `message` is sanitized.
      (
        err as Error & { fullPath?: string | undefined; projectRoot?: string | undefined }
      ).fullPath = absPath;
      (
        err as Error & { fullPath?: string | undefined; projectRoot?: string | undefined }
      ).projectRoot = this.projectRoot;
      throw err;
    }
    return resolved;
  }
}
