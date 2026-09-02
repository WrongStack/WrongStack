import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RustAdapter } from '../../src/adapters/rust.js';
import { workspaceId } from '../../src/discovery/index.js';
import type { Workspace } from '../../src/types.js';

const CARGO = `[package]\nname="x"\nversion="0.1.0"\n[dependencies]\nserde="1.0"\ntokio={version="1.40"}\n[dev-dependencies]\ncriterion="0.5"\n`;
const LOCK = `[[package]]\nname="serde"\nversion="1.0.215"\n[[package]]\nname="tokio"\nversion="1.40.0"\n`;

function mkWorkspace(files: Record<string, string>): { dir: string; ws: Workspace } {
  const dir = join(tmpdir(), `ts-rs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c);
  return {
    dir,
    ws: {
      id: workspaceId('', 'rust'),
      relativeRoot: dir,
      ecosystem: 'rust' as const,
      manifests: Object.keys(files).filter((f) => f !== 'Cargo.lock'),
      lockfiles: Object.keys(files).filter((f) => f === 'Cargo.lock'),
      confidence: 0.9,
      coverage: 'full' as const,
    },
  };
}

describe('RustAdapter', () => {
  it('extracts deps from Cargo.toml', async () => {
    const { dir, ws } = mkWorkspace({ 'Cargo.toml': CARGO });
    try {
      const deps = await new RustAdapter().inventory(ws, {});
      expect(deps.map((d) => d.name)).toContain('serde');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('separates dev-deps scope', async () => {
    const { dir, ws } = mkWorkspace({ 'Cargo.toml': CARGO });
    try {
      const deps = await new RustAdapter().inventory(ws, {});
      expect(deps.find((d) => d.name === 'criterion')?.scope).toBe('development');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads locked versions from Cargo.lock', async () => {
    const { dir, ws } = mkWorkspace({ 'Cargo.toml': CARGO, 'Cargo.lock': LOCK });
    try {
      const deps = await new RustAdapter().inventory(ws, {});
      expect(deps.find((d) => d.name === 'serde')?.locked).toBe('1.0.215');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('has manifest evidence on every dep', async () => {
    const { dir, ws } = mkWorkspace({ 'Cargo.toml': CARGO });
    try {
      const deps = await new RustAdapter().inventory(ws, {});
      for (const d of deps) expect(d.evidence.some((e) => e.kind === 'manifest')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] for no manifest', async () => {
    const { dir, ws } = mkWorkspace({});
    try {
      expect(await new RustAdapter().inventory(ws, {})).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
