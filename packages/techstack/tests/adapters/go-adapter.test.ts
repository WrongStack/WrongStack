import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GoAdapter } from '../../src/adapters/go.js';
import { workspaceId } from '../../src/discovery/index.js';
import { constructPurl, parsePurlEcosystem } from '../../src/registry/purl.js';
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

  it.each([
    ['example.com/spaced', '1.0.0', 'runtime', true],
    ['example.com/tabbed', '1.2.3', 'runtime', true],
    ['example.com/indirect', '1.4.5', 'transitive', false],
  ] as const)('inventories single-line requirement %s', async (name, locked, scope, direct) => {
    const { dir, ws } = mkWorkspace({
      'go.mod': [
        'module example.com/app',
        '',
        'go 1.21',
        '',
        'require example.com/spaced v1.0.0',
        'require\texample.com/tabbed v1.2.3',
        'require\texample.com/indirect v1.4.5 // indirect',
        '',
      ].join('\n'),
    });
    try {
      const deps = await new GoAdapter().inventory(ws, {});
      expect(deps.find((dep) => dep.name === name)).toMatchObject({ name, locked, scope, direct });
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

  it('keeps the required version when go.sum records an older one', async () => {
    const gosum = [
      'github.com/gorilla/mux v1.8.0 h1:old=',
      'github.com/gorilla/mux v1.8.0/go.mod h1:old=',
      'github.com/gorilla/mux v1.8.1 h1:abc=',
      'github.com/gorilla/mux v1.8.1/go.mod h1:abc=',
      '',
    ].join('\n');
    const { dir, ws } = mkWorkspace({ 'go.mod': GOMOD, 'go.sum': gosum });
    try {
      const deps = await new GoAdapter().inventory(ws, {});
      const mux = deps.find((d) => d.name === 'github.com/gorilla/mux');
      // go.sum is a checksum log written lowest-first, not a resolution list:
      // taking its first entry reported 1.8.0 for a module required at 1.8.1, and
      // the purl built from it sent every advisory query to the wrong component.
      expect(mux?.requested).toBe('1.8.1');
      expect(mux?.locked).toBe('1.8.1');
      expect(mux?.purl?.endsWith('@1.8.1')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits the canonical golang purl that the purl layer can resolve', async () => {
    const { dir, ws } = mkWorkspace({ 'go.mod': GOMOD, 'go.sum': GOSUM });
    try {
      const deps = await new GoAdapter().inventory(ws, {});
      const mux = deps.find((d) => d.name === 'github.com/gorilla/mux');
      // The adapter used the low-level `buildPurl`, which emitted
      // `pkg:go/github.com%2Fgorilla%2Fmux@1.8.1` — a purl whose type and
      // encoding this package's own `parsePurlEcosystem` cannot resolve, so the
      // SBOM identity and every per-purl advisory query were unrecognisable.
      expect(mux?.purl).toBe(constructPurl('go', 'github.com/gorilla/mux', '1.8.1'));
      expect(mux?.purl).toBe('pkg:golang/github.com/gorilla/mux@1.8.1');
      expect(parsePurlEcosystem(mux?.purl ?? '')).toEqual({
        ecosystem: 'go',
        name: 'github.com/gorilla/mux',
        version: '1.8.1',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    'replace "example.com/original" => example.com/fork v1.2.0',
    'replace example.com/original => "example.com/fork" v1.2.0',
    'replace "example.com/original" v1.0.0 => "example.com/fork" v1.2.0',
    'replace (\n  "example.com/original" => "example.com/fork" v1.2.0\n)',
  ])('uses the replacement identity for quoted paths: %s', async (directive) => {
    const { dir, ws } = mkWorkspace({
      'go.mod': `module example.com/app\nrequire example.com/original v1.0.0\n${directive}\n`,
    });
    try {
      const deps = await new GoAdapter().inventory(ws, {});
      expect(deps).toHaveLength(1);
      expect(deps[0]).toMatchObject({
        name: 'example.com/original',
        requested: '1.0.0',
        locked: '1.2.0',
        sourceType: 'registry',
        purl: 'pkg:golang/example.com/fork@1.2.0',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['"../local"', '"../local module"'])(
    'classifies a quoted local replacement as a path: %s',
    async (target) => {
      const { dir, ws } = mkWorkspace({
        'go.mod': `module example.com/app\nrequire example.com/original v1.0.0\nreplace example.com/original => ${target}\n`,
      });
      try {
        const deps = await new GoAdapter().inventory(ws, {});
        expect(deps[0]?.sourceType).toBe('path');
        expect(deps[0]?.purl).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('does not apply a quoted version-specific replacement to another version', async () => {
    const { dir, ws } = mkWorkspace({
      'go.mod':
        'module example.com/app\nrequire example.com/original v1.0.0\nreplace "example.com/original" v1.1.0 => "example.com/fork" v1.2.0\n',
    });
    try {
      const deps = await new GoAdapter().inventory(ws, {});
      expect(deps[0]?.locked).toBe('1.0.0');
      expect(deps[0]?.purl).toBe('pkg:golang/example.com/original@1.0.0');
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
