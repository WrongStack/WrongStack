import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import { describe, expect, it, vi } from 'vitest';
import { wireStandaloneChronicle } from '../src/server/start-webui-chronicle.js';

const globalRoot = path.resolve('/home/.wrongstack');

const base = () => ({
  events: new EventBus(),
  config: { chronicle: { retentionDays: 30 } },
  projectRoot: path.resolve('/repo'),
  wpaths: {
    globalRoot,
    projectSlug: 'repo',
    projectHash: 'repo-hash',
    projectDir: path.join(globalRoot, 'projects', 'repo-hash'),
  },
  getSessionId: () => 'leader',
  logger: { warn: vi.fn() },
});

function fakeWire() {
  const opened: Array<{ projectRoot: string; projectDir?: string | undefined; closed: boolean }> =
    [];
  const wire = vi.fn(
    (options: { projectRoot: string; paths: { projectDir?: string | undefined } }) => {
      const entry = { projectRoot: options.projectRoot, projectDir: options.paths.projectDir };
      const record = { ...entry, closed: false };
      opened.push(record);
      return {
        journal: {},
        serverBacked: true,
        dispose: async () => {
          record.closed = true;
        },
      };
    },
  );
  return { wire, opened };
}

describe('wireStandaloneChronicle', () => {
  it("records the host's own bus through the shared Chronicle producer", async () => {
    const input = base();
    const { wire, opened } = fakeWire();
    const chronicle = wireStandaloneChronicle({ ...input, opts: {}, wire: wire as never });
    expect(chronicle).toBeDefined();
    expect(wire).toHaveBeenCalledWith(
      expect.objectContaining({
        events: input.events,
        config: input.config,
        projectRoot: input.projectRoot,
        paths: input.wpaths,
        sessionId: input.getSessionId,
      }),
    );
    await chronicle?.dispose();
    expect(opened.map((entry) => entry.closed)).toEqual([true]);
  });

  it("follows a project switch into the new project's Chronicle", async () => {
    const input = base();
    const { wire, opened } = fakeWire();
    const chronicle = wireStandaloneChronicle({ ...input, opts: {}, wire: wire as never });
    chronicle?.switchProject(input.projectRoot);
    expect(wire).toHaveBeenCalledTimes(1);
    const other = path.resolve('/other');
    chronicle?.switchProject(other);
    expect(opened[0]?.closed).toBe(true);
    expect(opened[1]?.projectRoot).toBe(other);
    expect(opened[1]?.projectDir).toMatch(/projects/);
    expect(opened[1]?.projectDir).not.toBe(input.wpaths.projectDir);
    await chronicle?.dispose();
    expect(opened.every((entry) => entry.closed)).toBe(true);
  });

  it('leaves a bus the caller handed in to the producers its owner wired', () => {
    const input = base();
    const wire = vi.fn();
    expect(
      wireStandaloneChronicle({
        ...input,
        opts: { services: { events: input.events } as never },
        wire: wire as never,
      }),
    ).toBeUndefined();
    expect(wire).not.toHaveBeenCalled();
  });

  it('reports a journal that refuses appends once, not per event', () => {
    const input = base();
    let report: ((error: unknown) => void) | undefined;
    wireStandaloneChronicle({
      ...input,
      opts: {},
      wire: ((options: { onPersistError?: (error: unknown) => void }) => {
        report = options.onPersistError;
        return undefined;
      }) as never,
    });
    report?.(new Error('disk full'));
    report?.(new Error('disk full'));
    expect(input.logger.warn).toHaveBeenCalledTimes(1);
    expect(input.logger.warn).toHaveBeenCalledWith('chronicle: an event could not be recorded', {
      message: 'disk full',
    });
  });

  it('is wired by startWebUI before its agents exist and closed on shutdown', () => {
    // startWebUI is the desktop engine. Without this call nothing it runs reaches Chronicle,
    // and a desktop conversation's Session Story has no context, model, tool or file rows.
    const start = readFileSync(new URL('../src/server/start-webui.ts', import.meta.url), 'utf8');
    const wired = start.indexOf('wireStandaloneChronicle({');
    expect(wired).toBeGreaterThan(-1);
    expect(wired).toBeLessThan(start.indexOf('createStandaloneAgentServices({'));
    expect(start).toContain('chronicle?.switchProject(next);');
    expect(start).toMatch(/disposeChronicle: chronicle \? \(\) => chronicle\.dispose\(\)/);
    const shutdown = readFileSync(
      new URL('../src/server/start-webui-shutdown.ts', import.meta.url),
      'utf8',
    );
    expect(shutdown).toMatch(/options\s*\.disposeChronicle\?\.\(\)/);
  });
});
