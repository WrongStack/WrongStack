import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { PluginUiRegistry } from '@wrongstack/core/plugin';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildImageCommand, buildPanelCommand, formatPluginViewNodeText } from '../src/commands.js';

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c ^= bytes[i]!;
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  const crcBuf = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  out.writeUInt32BE(crc32(crcBuf), 8 + data.length);
  return out;
}

function makeSolidPng(width: number, height: number): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    raw[row] = 0; // filter None
    for (let x = 0; x < width; x += 1) {
      const px = row + 1 + x * 4;
      raw[px] = 32;
      raw[px + 1] = 160;
      raw[px + 2] = 240;
      raw[px + 3] = 255;
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

describe('/panel and /image portable commands', () => {
  let rootDir = '';
  let outsideDir = '';

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'wstack-cmd-proj-'));
    outsideDir = await mkdtemp(join(tmpdir(), 'wstack-cmd-outside-'));
  });

  afterEach(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
    if (outsideDir) await rm(outsideDir, { recursive: true, force: true });
  });

  it('lists, renders, opens, and dispatches actions on declarative plugin panels via /panel', async () => {
    const registry = new PluginUiRegistry();
    let count = 1;
    const chip = registry.registerStatusChip('demo', {
      id: 'health',
      text: 'ok:1',
      tone: 'success',
    });
    registry.registerPanel('demo', {
      id: 'metrics',
      title: 'Demo Metrics',
      actions: [{ id: 'bump', label: 'Increment', shortcut: 'b' }],
      render: () => ({
        kind: 'stack',
        direction: 'vertical',
        children: [
          {
            kind: 'kv',
            items: [{ label: 'Count', value: String(count), tone: 'accent' }],
          },
          {
            kind: 'table',
            columns: ['Metric', 'Value'],
            rows: [['Requests', String(count * 10)]],
          },
        ],
      }),
      onAction: async (actionId) => {
        if (actionId === 'bump') {
          count += 1;
          chip.update({ text: `ok:${count}` });
        }
      },
    });

    const openedActions: string[] = [];
    const onPanelOpen = {
      current: (action: string) => {
        openedActions.push(action);
        return true;
      },
    };
    const cmd = buildPanelCommand({
      pluginUiRegistry: registry,
      onPanelOpen,
    });

    // Bare `/panel` delegates to TUI overlay when onPanelOpen handles it
    const openRes = await cmd.run('', undefined as never);
    expect(openRes).toEqual({});
    expect(openedActions).toEqual(['plugin-panel']);

    // `/panel list` prints panels + status chips
    const listRes = await cmd.run('list', undefined as never);
    expect(listRes?.message).toContain('demo:metrics');
    expect(listRes?.message).toContain('Demo Metrics');
    expect(listRes?.message).toContain('ok:1');

    // `/panel action demo:metrics bump` triggers onAction and `/panel show` reflects updated state
    const actRes = await cmd.run('action demo:metrics bump', undefined as never);
    expect(actRes?.message).toContain('Executed action "bump"');
    const showRes = await cmd.run('show demo:metrics', undefined as never);
    expect(showRes?.message).toContain('Count:');
    expect(showRes?.message).toContain('2');
    expect(showRes?.message).toContain('20');

    // Direct node formatter covers badges, progress, log, code, markdown
    const formatted = formatPluginViewNodeText({
      kind: 'stack',
      direction: 'vertical',
      children: [
        { kind: 'badges', badges: [{ label: 'LIVE', tone: 'success' }] },
        { kind: 'progress', label: 'Load', current: 5, total: 10 },
        { kind: 'log', lines: [{ ts: '10:00', level: 'info', text: 'ready' }] },
        { kind: 'code', language: 'ts', content: 'const x = 1;' },
        { kind: 'markdown', content: '**done**' },
      ],
    });
    expect(formatted).toContain('[LIVE]');
    expect(formatted).toContain('50%');
    expect(formatted).toContain('ready');
    expect(formatted).toContain('const x = 1;');
    expect(formatted).toContain('**done**');

    // `--json` output mode for WebUI & programmatic bridges
    const listJson = JSON.parse(
      (await cmd.run('list --json', undefined as never))?.message ?? '{}',
    ) as {
      statusChips: Array<{ text: string }>;
      panels: Array<{ qualifiedId: string }>;
    };
    expect(listJson.statusChips[0]?.text).toBe('ok:2');
    expect(listJson.panels[0]?.qualifiedId).toBe('demo:metrics');

    const actJson = JSON.parse(
      (await cmd.run('action demo:metrics bump --json', undefined as never))?.message ?? '{}',
    ) as {
      statusChips: Array<{ text: string }>;
      activePanel: { qualifiedId: string; view: { kind: string } };
    };
    expect(actJson.statusChips[0]?.text).toBe('ok:3');
    expect(actJson.activePanel.qualifiedId).toBe('demo:metrics');
    expect(actJson.activePanel.view.kind).toBe('stack');
  });

  it('validates project-contained PNG artifacts and blocks path traversal in /image', async () => {
    const subDir = join(rootDir, 'artifacts');
    await mkdir(subDir, { recursive: true });
    const imgPath = join(subDir, 'chart.png');
    await writeFile(imgPath, makeSolidPng(8, 4));

    const outsideImg = join(outsideDir, 'secret.png');
    await writeFile(outsideImg, makeSolidPng(4, 4));

    const openedActions: string[] = [];
    const cmd = buildImageCommand({
      projectRoot: rootDir,
      onPanelOpen: {
        current: (action: string) => {
          openedActions.push(action);
          return true;
        },
      },
    });

    // `--info` prints dimensions without opening the TUI modal
    const infoRes = await cmd.run('artifacts/chart.png --info', undefined as never);
    expect(infoRes?.message).toContain('image/png');
    expect(infoRes?.message).toContain('8×4');
    expect(openedActions).toHaveLength(0);

    // Interactive `/image artifacts/chart.png` dispatches `image:<resolvedPath>` to TUI modal
    const modalRes = await cmd.run('artifacts/chart.png', undefined as never);
    expect(modalRes).toEqual({});
    expect(openedActions).toHaveLength(1);
    expect(openedActions[0]).toContain('image:');
    expect(openedActions[0]).toContain('chart.png');

    // Escaping projectRoot is strictly rejected
    const escapeRes = await cmd.run(outsideImg, undefined as never);
    expect(escapeRes?.message).toMatch(/outside|project root|denied/i);
  });
});
