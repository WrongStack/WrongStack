import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { PluginUiRegistry } from '@wrongstack/core/plugin';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImagePreviewModal } from '../src/components/image-preview-modal.js';
import { PluginPanelOverlay, PluginStatusStrip } from '../src/components/plugin-panel-overlay.js';
import { PluginPromptModal } from '../src/components/plugin-prompt-modal.js';
import { ResumePicker } from '../src/components/resume-picker.js';
import { createPanelOpenDispatcher } from '../src/on-panel-open.js';
import { standaloneModalStoreOf } from '../src/standalone-modal-store.js';

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
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const px = row + 1 + x * 4;
      raw[px] = 220;
      raw[px + 1] = 80;
      raw[px + 2] = 40;
      raw[px + 3] = 255;
    }
  }
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

describe('PluginPanelOverlay, PluginStatusStrip, ImagePreviewModal, ResumePicker badge, and modal bridge', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wstack-tui-modals-'));
  });

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('renders PluginStatusStrip within column budget and truncates overflow with +N', () => {
    const registry = new PluginUiRegistry();
    registry.registerStatusChip('p1', { id: 'a', text: 'chip-one', priority: 30 });
    registry.registerStatusChip('p2', { id: 'b', text: 'chip-two', priority: 20 });
    registry.registerStatusChip('p3', { id: 'c', text: 'chip-three', priority: 10 });

    const app = render(
      React.createElement(PluginStatusStrip, {
        chips: registry.listStatusChips(),
        maxColumns: 18,
      }),
    );
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('chip-one');
    expect(frame).toContain('+2');
    app.unmount();
  });

  it('renders PluginPanelOverlay, executes shortcut actions, and closes on Esc', async () => {
    const registry = new PluginUiRegistry();
    let hits = 0;
    registry.registerPanel('ops', {
      id: 'dash',
      title: 'Ops Dashboard',
      actions: [{ id: 'ping', label: 'Ping Server', shortcut: 'p' }],
      render: () => ({
        kind: 'kv',
        items: [{ label: 'Pings', value: String(hits) }],
      }),
      onAction: async (id) => {
        if (id === 'ping') hits += 1;
      },
    });

    const onClose = vi.fn();
    const app = render(
      React.createElement(PluginPanelOverlay, {
        registry,
        onClose,
      }),
    );

    await new Promise((r) => setTimeout(r, 25));
    expect(app.lastFrame() ?? '').toContain('Ops Dashboard');
    expect(app.lastFrame() ?? '').toContain('Pings:');
    expect(app.lastFrame() ?? '').toContain('0');

    // Trigger shortcut 'p'
    app.stdin.write('p');
    await new Promise((r) => setTimeout(r, 35));
    expect(hits).toBe(1);
    expect(app.lastFrame() ?? '').toContain('1');

    // Close on 'q' / Escape
    app.stdin.write('q');
    await new Promise((r) => setTimeout(r, 15));
    expect(onClose).toHaveBeenCalledTimes(1);
    app.unmount();
  });

  it('renders ImagePreviewModal 24-bit half-block preview and closes cleanly', async () => {
    const imgPath = join(tempDir, 'sample.png');
    await writeFile(imgPath, makeSolidPng(8, 8));

    const onClose = vi.fn();
    const app = render(
      React.createElement(ImagePreviewModal, {
        filePath: imgPath,
        capability: {
          isRealTTY: true,
          colorDepth: 3,
          stdoutWritable: true,
          mouseProtocol: 'none',
          canSetTitle: false,
          isTmux: false,
          isWindowsConhost: false,
          supportsSyncOutput: true,
          graphicsProtocol: 'halfblock',
        },
        onClose,
      }),
    );

    // Wait for async readFile + PNG thumbnail decode
    await new Promise((r) => setTimeout(r, 40));
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('Image Preview');
    expect(frame).toContain('sample.png');
    expect(frame).toContain('8×8 PNG');
    expect(frame).toContain('▀');

    app.stdin.write('q');
    await new Promise((r) => setTimeout(r, 15));
    expect(onClose).toHaveBeenCalledTimes(1);
    app.unmount();
  });

  it('displays the ⎇ N branches badge in ResumePicker when branchCount > 1', () => {
    const app = render(
      React.createElement(ResumePicker, {
        sessions: [
          {
            id: '2026-11-11/sess_1',
            title: 'Refactor storage engine',
            startedAt: '2026-11-11T10:00:00.000Z',
            tokenTotal: 1200,
            iterationCount: 3,
            toolCallCount: 4,
            toolErrorCount: 0,
            messageCount: 6,
            branchCount: 3,
            activeBranchName: 'try-cas',
          },
        ],
        selected: 0,
        busy: false,
      }),
    );

    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('⎇ 3 branches (try-cas)');
    app.unmount();
  });

  it('routes tree, plugin-panel, and image:<path> actions through createPanelOpenDispatcher', () => {
    const dispatch = vi.fn();
    const dispatcher = createPanelOpenDispatcher({
      dispatch,
      openProjectPicker: vi.fn(),
      openStatuslinePicker: vi.fn(),
      canOpenTreeOverlay: () => true,
      canOpenPluginPanel: () => true,
    });

    expect(dispatcher('tree')).toBe(true);
    expect(standaloneModalStoreOf(dispatch).get()).toEqual({ kind: 'tree' });

    expect(dispatcher('plugin-panel:ops:dash')).toBe(true);
    expect(standaloneModalStoreOf(dispatch).get()).toEqual({
      kind: 'plugin-panel',
      panelId: 'ops:dash',
    });

    expect(dispatcher('image:/tmp/demo.png')).toBe(true);
    expect(standaloneModalStoreOf(dispatch).get()).toEqual({
      kind: 'image',
      filePath: '/tmp/demo.png',
    });

    standaloneModalStoreOf(dispatch).close();
    expect(standaloneModalStoreOf(dispatch).get()).toBeNull();
  });

  it('renders PluginPromptModal across confirm, select, and input modes and wires PluginUiRegistry handlers', async () => {
    const registry = new PluginUiRegistry();
    const notifications: Array<{ owner: string; text: string }> = [];
    registry.setHandlers({
      onNotify: (owner, text) => {
        notifications.push({ owner, text });
      },
      onPrompt: async (_owner, opts) => (opts.kind === 'confirm' ? true : 'picked-val'),
    });

    registry.notify('deploy-guard', 'Canary healthy', 'success');
    expect(notifications).toEqual([{ owner: 'deploy-guard', text: 'Canary healthy' }]);
    await expect(
      registry.prompt(
        'deploy-guard',
        { kind: 'confirm', title: 'Proceed?' },
        new AbortController().signal,
      ),
    ).resolves.toBe(true);

    // Confirm mode: press 'y'
    const resolvedConfirm = vi.fn();
    const confirmApp = render(
      React.createElement(PluginPromptModal, {
        owner: 'deploy-guard',
        opts: { kind: 'confirm', title: 'Promote canary?', message: 'Zero errors in 5m' },
        onResolve: resolvedConfirm,
      }),
    );
    expect(confirmApp.lastFrame() ?? '').toContain('[deploy-guard] Promote canary?');
    confirmApp.stdin.write('y');
    await new Promise((r) => setTimeout(r, 15));
    expect(resolvedConfirm).toHaveBeenCalledWith(true);
    confirmApp.unmount();

    // Select mode: Down arrow + Enter picks second option
    const resolvedSelect = vi.fn();
    const selectApp = render(
      React.createElement(PluginPromptModal, {
        owner: 'env-picker',
        opts: {
          kind: 'select',
          title: 'Target region',
          options: [
            { label: 'US East', value: 'us-east-1' },
            { label: 'EU Central', value: 'eu-central-1' },
          ],
        },
        onResolve: resolvedSelect,
      }),
    );
    selectApp.stdin.write('\x1b[B');
    await new Promise((r) => setTimeout(r, 15));
    selectApp.stdin.write('\r');
    await new Promise((r) => setTimeout(r, 15));
    expect(resolvedSelect).toHaveBeenCalledWith('eu-central-1');
    selectApp.unmount();

    // Input mode: type characters + Enter
    const resolvedInput = vi.fn();
    const inputApp = render(
      React.createElement(PluginPromptModal, {
        owner: 'tagger',
        opts: { kind: 'input', title: 'Release tag' },
        onResolve: resolvedInput,
      }),
    );
    inputApp.stdin.write('v2.4.0');
    await new Promise((r) => setTimeout(r, 15));
    inputApp.stdin.write('\r');
    await new Promise((r) => setTimeout(r, 15));
    expect(resolvedInput).toHaveBeenCalledWith('v2.4.0');
    inputApp.unmount();
  });
});
