import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import { runWithProcessTelemetry } from '@wrongstack/core/observability';
import { afterEach, describe, expect, it } from 'vitest';
import {
  KIT_DIRECTORY,
  KIT_HISTORY_DIRECTORY,
  kitPath,
  listKits,
  loadKit,
} from '../src/project-kit/catalog.js';
import { executeKit, kitHistory } from '../src/project-kit/service.js';
import { projectKitRunTool, projectKitTool } from '../src/project-kit.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wrongstack-kit-'));
  roots.push(root);
  const ctx = { projectRoot: root, agentId: 'test-agent' } as never;
  const opts = { signal: new AbortController().signal };
  const template = (await projectKitTool.execute(
    { action: 'template', name: 'strings.unique' },
    ctx,
    opts,
  )) as { files: Record<string, string> };
  for (const [file, text] of Object.entries(template.files)) {
    const absolute = path.join(root, file);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, text);
  }
  const kitDir = path.join(root, KIT_DIRECTORY, 'strings.unique');
  const revision = (await loadKit(root, 'strings.unique')).revision;
  const run = (
    action: 'verify' | 'run',
    input: unknown = {},
    rev = revision,
    signal = opts.signal,
  ) =>
    executeKit({
      root,
      name: 'strings.unique',
      revision: rev,
      action,
      input,
      agentId: 'test-agent',
      signal,
    });
  const manifest = JSON.parse(await readFile(path.join(kitDir, 'kit.json'), 'utf8'));
  return { root, ctx, opts, kitDir, revision, run, manifest };
}

async function cancelAfterChildOutput(f: Awaited<ReturnType<typeof fixture>>, revision: string) {
  const events = new EventBus();
  const controller = new AbortController();
  let observed = false;
  const off = events.on('process.output', (event) => {
    if (event.stream !== 'stderr') return;
    observed = true;
    controller.abort();
  });
  try {
    const result = await runWithProcessTelemetry(
      {
        events,
        sessionId: 'kit-fixture',
        toolCallId: 'cancel-fixture',
        toolName: 'project_kit_run',
      },
      () => f.run('verify', {}, revision, controller.signal),
    );
    expect(observed).toBe(true);
    return result;
  } finally {
    off();
  }
}

describe('Project Kit lifecycle', () => {
  it('discovers without executing, verifies, applies defaults and runs from a source snapshot', async () => {
    const f = await fixture();
    expect((await listKits(f.root, 'duplicate')).tools).toHaveLength(1);
    await expect(f.run('run', { values: ['b', 'a', 'b'] })).rejects.toThrow(
      'no passing verification',
    );
    const verification = await f.run('verify');
    expect(verification.status).toBe('passed');
    expect(verification.cases).toHaveLength(3);
    expect(
      await projectKitTool.execute({ action: 'inspect', name: 'strings.unique' }, f.ctx, f.opts),
    ).toMatchObject({ verified: true, revision: f.revision });
    const result = await f.run('run', { values: ['b', 'a', 'b'] });
    expect(result.output).toEqual(['b', 'a']);
    expect(await readFile(path.join(f.root, result.sourceSnapshot, 'main.mjs'), 'utf8')).toContain(
      'export async function run',
    );
    const history = await kitHistory(f.root, 'strings.unique');
    expect(history).toHaveLength(2);
    expect(history.every((r) => r.status === 'passed')).toBe(true);
    expect(history.every((r) => r.exitCode === 0)).toBe(true);
    expect(JSON.stringify(history)).not.toContain('values');
  });

  it('invalidates verification when any bundled file changes', async () => {
    const f = await fixture();
    await f.run('verify');
    await writeFile(path.join(f.kitDir, 'notes.md'), 'changed behavior');
    await expect(f.run('run', { values: [] })).rejects.toThrow('revision changed');
    const current = (await loadKit(f.root, 'strings.unique')).revision;
    await expect(f.run('run', { values: [] }, current)).rejects.toThrow('no passing verification');
    expect(
      await projectKitTool.execute({ action: 'inspect', name: 'strings.unique' }, f.ctx, f.opts),
    ).toMatchObject({ verified: false });
  });

  it('rejects invalid input before starting a process, and does not echo secret values', async () => {
    const f = await fixture();
    await f.run('verify');
    await expect(f.run('run', { values: 'private-value' })).rejects.toThrow('schema validation');
    await expect(f.run('run', { values: [], unexpected: 'private-value' })).rejects.not.toThrow(
      'private-value',
    );
    expect(await kitHistory(f.root, 'strings.unique')).toHaveLength(1);
  });

  it('records failing verification and never enables that revision', async () => {
    const f = await fixture();
    await writeFile(path.join(f.kitDir, 'main.mjs'), 'export function run() { return ["wrong"]; }');
    const rev = (await loadKit(f.root, 'strings.unique')).revision;
    const result = await f.run('verify', {}, rev);
    expect(result).toMatchObject({ status: 'failed', cases: [{ passed: false }] });
    await expect(f.run('run', { values: [] }, rev)).rejects.toThrow('no passing verification');
    await expect(
      projectKitRunTool.execute(
        { action: 'verify', name: 'strings.unique', revision: rev },
        f.ctx,
        f.opts,
      ),
    ).rejects.toThrow('Verification case failed');
  });

  it('enforces the output schema and rejects missing run exports', async () => {
    const f = await fixture();
    for (const source of ['export function run() { return 12; }', 'export const other = 1;']) {
      await writeFile(path.join(f.kitDir, 'main.mjs'), source);
      const rev = (await loadKit(f.root, 'strings.unique')).revision;
      expect((await f.run('verify', {}, rev)).status).toBe('failed');
    }
  });

  it('revokes an earlier pass when re-verification fails in a changed environment', async () => {
    const f = await fixture();
    await writeFile(
      path.join(f.kitDir, 'main.mjs'),
      `import { existsSync } from 'node:fs';
export function run(input, ctx) {
  if (existsSync(ctx.resolvePath('broken-marker'))) return ['wrong'];
  const values = [...new Set(input.values)]; return input.sort ? values.sort() : values;
}`,
    );
    const rev = (await loadKit(f.root, 'strings.unique')).revision;
    expect((await f.run('verify', {}, rev)).status).toBe('passed');
    await writeFile(path.join(f.root, 'broken-marker'), 'environment changed');
    expect((await f.run('verify', {}, rev)).status).toBe('failed');
    await expect(f.run('run', { values: [] }, rev)).rejects.toThrow('no passing verification');
  });

  it('bounds infinite loops and records cancellation', async () => {
    const f = await fixture();
    f.manifest.timeoutMs = 500;
    await writeFile(path.join(f.kitDir, 'kit.json'), JSON.stringify(f.manifest));
    await writeFile(
      path.join(f.kitDir, 'main.mjs'),
      'export function run() { process.stderr.write("ready"); while (true) {} }',
    );
    const rev = (await loadKit(f.root, 'strings.unique')).revision;
    expect(await f.run('verify', {}, rev)).toMatchObject({ status: 'failed', error: 'Timed out' });
    // Cancellation is exercised after the child starts, independently of its
    // timeout. Snapshot I/O and Node startup may exceed 200ms under coverage.
    f.manifest.timeoutMs = 30_000;
    await writeFile(path.join(f.kitDir, 'kit.json'), JSON.stringify(f.manifest));
    const cancellationRevision = (await loadKit(f.root, 'strings.unique')).revision;
    expect(await cancelAfterChildOutput(f, cancellationRevision)).toMatchObject({
      status: 'failed',
      error: 'Cancelled',
    });
  }, 45_000);

  it('records exitCode and a bounded redacted stderr tail for timed-out and cancelled runs', async () => {
    const f = await fixture();
    // This test requires actual stderr evidence, so allow bounded startup
    // headroom; the separate loop test covers the short timeout contract.
    f.manifest.timeoutMs = 10_000;
    await writeFile(path.join(f.kitDir, 'kit.json'), JSON.stringify(f.manifest));
    await writeFile(
      path.join(f.kitDir, 'main.mjs'),
      `export function run() {
        process.stderr.write('stalled with GITHUB_TOKEN=ghp_timeoutsecret123\\n');
        return new Promise(() => {});
      }`,
    );
    const rev = (await loadKit(f.root, 'strings.unique')).revision;

    const timedOut = await f.run('verify', {}, rev);
    expect(timedOut.error).toBe('Timed out');
    expect(timedOut.stderrTail).toContain('GITHUB_TOKEN=[REDACTED]');
    expect(timedOut.stderrTail ?? '').not.toContain('ghp_timeoutsecret123');
    expect((timedOut.stderrTail ?? '').length).toBeLessThanOrEqual(4096);
    // Measured on this platform: a force-killed child reports exit code 1 on both
    // the timeout and the cancellation path, so it is asserted exactly here. Other
    // platforms report no code for a killed child, so they keep the portable check.
    if (process.platform === 'win32') {
      expect(timedOut.exitCode).toBe(1);
    } else {
      expect(timedOut.exitCode === undefined || typeof timedOut.exitCode === 'number').toBe(true);
    }
    const [timedOutRecord] = await kitHistory(f.root, 'strings.unique');
    expect(timedOutRecord?.stderrTail).toBe(timedOut.stderrTail);
    expect(timedOutRecord?.exitCode).toBe(timedOut.exitCode);

    f.manifest.timeoutMs = 30_000;
    await writeFile(path.join(f.kitDir, 'kit.json'), JSON.stringify(f.manifest));
    const cancellationRevision = (await loadKit(f.root, 'strings.unique')).revision;
    const cancelled = await cancelAfterChildOutput(f, cancellationRevision);
    expect(cancelled.error).toBe('Cancelled');
    expect(cancelled.stderrTail).toContain('GITHUB_TOKEN=[REDACTED]');
    expect((cancelled.stderrTail ?? '').length).toBeLessThanOrEqual(4096);
    if (process.platform === 'win32') {
      expect(cancelled.exitCode).toBe(1);
    } else {
      expect(cancelled.exitCode === undefined || typeof cancelled.exitCode === 'number').toBe(true);
    }
  }, 45_000);

  it('persists the exit code and a bounded redacted stderr tail when the child dies without a result', async () => {
    const f = await fixture();
    await writeFile(
      path.join(f.kitDir, 'main.mjs'),
      `export function run() {
        process.stderr.write('A'.repeat(6000));
        process.stderr.write('kit child diagnostic GITHUB_TOKEN=ghp_secretvalue123\\n', () => process.exit(0));
        setTimeout(() => process.exit(0), 1000);
        return new Promise(() => {});
      }`,
    );
    const rev = (await loadKit(f.root, 'strings.unique')).revision;
    const result = await f.run('verify', {}, rev);
    expect(result).toMatchObject({
      status: 'failed',
      exitCode: 0,
      error: 'Node exited without a successful result (0)',
    });
    expect(result.stderrTail?.length).toBeGreaterThan(4000);
    expect(result.stderrTail?.length).toBeLessThanOrEqual(4096);
    expect(result.stderrTail).toContain('kit child diagnostic GITHUB_TOKEN=[REDACTED]');
    expect(result.stderrTail).not.toContain('ghp_secretvalue123');
    const [persistedRecord] = await kitHistory(f.root, 'strings.unique');
    expect(persistedRecord).toMatchObject({
      status: 'failed',
      exitCode: 0,
      error: 'Execution failed; see session result',
    });
    expect(persistedRecord?.stderrTail).toBe(result.stderrTail);
    const persisted = await readFile(
      path.join(f.root, KIT_HISTORY_DIRECTORY, 'strings.unique', result.runId, 'record.json'),
      'utf8',
    );
    expect(persisted).not.toContain('ghp_secretvalue123');
  });

  it('records a child that exits 0 without a result distinguishably from a failed case', async () => {
    const f = await fixture();
    await writeFile(path.join(f.kitDir, 'main.mjs'), 'export function run() { process.exit(0); }');
    const rev = (await loadKit(f.root, 'strings.unique')).revision;
    const result = await f.run('verify', {}, rev);
    expect(result).toMatchObject({
      status: 'failed',
      exitCode: 0,
      error: 'Node exited without a successful result (0)',
    });
    // The distinguishing markers: no case ever reported an outcome, and the error
    // is not the case-assertion failure shape.
    expect(result.cases ?? []).toEqual([]);
    expect(result.error ?? '').not.toContain('Verification case failed');
    expect((result.stderrTail ?? '').length).toBeLessThanOrEqual(4096);
    const [persisted] = await kitHistory(f.root, 'strings.unique');
    expect(persisted).toMatchObject({ status: 'failed', exitCode: 0 });
    expect(persisted?.cases ?? []).toEqual([]);
  });

  it('still records the result when the kit leaves a handle open', async () => {
    const f = await fixture();
    await writeFile(
      path.join(f.kitDir, 'main.mjs'),
      `export function run(input) {
  setInterval(() => {}, 1000);
  const values = [...new Set(input.values)];
  return input.sort ? values.sort() : values;
}`,
    );
    const rev = (await loadKit(f.root, 'strings.unique')).revision;
    // The lingering interval must neither stall the child nor lose the result:
    // the channel closes first, and the deferred exit keeps the run bounded.
    expect(await f.run('verify', {}, rev)).toMatchObject({ status: 'passed', exitCode: 0 });
  }, 15000);

  it('loads local imports from the captured bundle and exposes SDK paths', async () => {
    const f = await fixture();
    await writeFile(
      path.join(f.kitDir, 'helper.mjs'),
      'export const unique = (v) => [...new Set(v)];',
    );
    await writeFile(
      path.join(f.kitDir, 'main.mjs'),
      `import { unique } from './helper.mjs';
export function run(input, ctx) {
  if (ctx.resolvePath('package.json') !== ctx.projectRoot + ${JSON.stringify(path.sep)} + 'package.json') throw new Error('wrong root');
  ctx.log('working');
  const v = unique(input.values); return input.sort ? v.sort() : v;
}`,
    );
    const rev = (await loadKit(f.root, 'strings.unique')).revision;
    expect(await f.run('verify', {}, rev)).toMatchObject({
      status: 'passed',
      logs: ['working', 'working', 'working'],
    });
  });

  it('does not import modules during discovery and isolates invalid entries', async () => {
    const f = await fixture();
    await writeFile(path.join(f.kitDir, 'main.mjs'), 'throw new Error("must not import");');
    await mkdir(path.join(f.root, KIT_DIRECTORY, 'broken'));
    const catalog = await listKits(f.root);
    expect(catalog.tools).toHaveLength(1);
    expect(catalog.invalid).toHaveLength(1);
    await expect(loadKit(f.root, '../escape')).rejects.toThrow('Invalid Project Kit name');
  });

  it('executes captured import bytes even if workspace sources change during verification', async () => {
    const f = await fixture();
    await writeFile(
      path.join(f.kitDir, 'helper.mjs'),
      'export const unique = (values) => [...new Set(values)];',
    );
    await writeFile(
      path.join(f.kitDir, 'main.mjs'),
      `import { writeFile } from 'node:fs/promises';
export async function run(input, ctx) {
  await writeFile(ctx.resolvePath('.wrongstack/project-kit/strings.unique/helper.mjs'), 'throw new Error("changed source")');
  const { unique } = await import('./helper.mjs');
  const result = unique(input.values); return input.sort ? result.sort() : result;
}`,
    );
    const rev = (await loadKit(f.root, 'strings.unique')).revision;
    expect((await f.run('verify', {}, rev)).status).toBe('passed');
    const current = (await loadKit(f.root, 'strings.unique')).revision;
    expect(current).not.toBe(rev);
    await expect(f.run('run', { values: [] }, current)).rejects.toThrow('no passing verification');
  });

  it('rejects unsupported schemas rather than pretending to validate them', async () => {
    const f = await fixture();
    f.manifest.inputSchema.properties.values.uniqueItems = true;
    await writeFile(path.join(f.kitDir, 'kit.json'), JSON.stringify(f.manifest));
    await expect(loadKit(f.root, 'strings.unique')).rejects.toThrow(
      'unsupported keyword uniqueItems',
    );
  });

  it('rejects symlinked project stores', async () => {
    const f = await fixture();
    const other = await mkdtemp(path.join(os.tmpdir(), 'wrongstack-kit-outside-'));
    roots.push(other);
    await symlink(other, path.join(f.root, '.wrongstack', 'project-kit-runs'), 'junction');
    await expect(kitPath(f.root, '.wrongstack/project-kit-runs/test', true)).rejects.toThrow(
      'symlinks',
    );
  });

  it('uses the existing execution permission boundary even for read-labelled modules', () => {
    expect(projectKitTool).toMatchObject({ permission: 'auto', mutating: false });
    expect(projectKitRunTool).toMatchObject({
      permission: 'confirm',
      mutating: true,
      capabilities: expect.arrayContaining(['shell.arbitrary']),
    });
    expect(projectKitRunTool.subjectFields).toContain('revision');
  });
});
