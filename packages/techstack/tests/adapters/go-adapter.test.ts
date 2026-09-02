import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GoAdapter } from '../../src/adapters/go.js';
import { workspaceId } from '../../src/discovery/index.js';
import type { Workspace } from '../../src/types.js';

const GOMOD = `module github.com/x\n\ngo 1.21\n\nrequire (\n    github.com/gorilla/mux v1.8.1\n    golang.org/x/net v0.30.0\n    github.com/google/uuid v1.6.0 // indirect\n)\n`;
const GOSUM = `github.com/gorilla/mux v1.8.1 h1:abc=\ngithub.com/gorilla/mux v1.8.1/go.mod h1:abc=\n`;

function mkWorkspace(files: Record<string, string>): { dir: string; ws: Workspace } {
  const dir = join(tmpdir(), `ts-go-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c);
  return {
    dir,
    ws: {
      id: workspaceId('', 'go'),
      relativeRoot: dir,
      ecosystem: 'go' as const,
      manifests: Object.keys(files).filter((f) => f === 'go.mod'),
      lockfiles: Object.keys(files).filter((f) => f === 'go.sum'),
      confidence: 0.9,
      coverage: 'full' as const,
    },
  };
}

describe('GoAdapter', () => {
  it('extracts deps from go.mod', async () => {
    const { dir, ws } = mkWorkspace({ 'go.mod': GOMOD });
    try {
      const deps = await new GoAdapter().inventory(ws, {});
      expect(deps.map((d) => d.name)).toContain('github.com/gorilla/mux');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks indirect deps as transitive', async () => {
    const { dir, ws } = mkWorkspace({ 'go.mod': GOMOD });
    try {
      const deps = await new GoAdapter().inventory(ws, {});
      const uuid = deps.find((d) => d.name === 'github.com/google/uuid');
      expect(uuid?.scope).toBe('transitive');
      expect(uuid?.direct).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads locked versions from go.sum', async () => {
    const { dir, ws } = mkWorkspace({ 'go.mod': GOMOD, 'go.sum': GOSUM });
    try {
      const deps = await new GoAdapter().inventory(ws, {});
      expect(deps.find((d) => d.name === 'github.com/gorilla/mux')?.locked).toBe('1.8.1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips own module', async () => {
    const { dir, ws } = mkWorkspace({ 'go.mod': GOMOD });
    try {
      const deps = await new GoAdapter().inventory(ws, {});
      expect(deps.find((d) => d.name === 'github.com/x')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('has manifest evidence', async () => {
    const { dir, ws } = mkWorkspace({ 'go.mod': GOMOD });
    try {
      const deps = await new GoAdapter().inventory(ws, {});
      for (const d of deps) expect(d.evidence.some((e) => e.kind === 'manifest')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
