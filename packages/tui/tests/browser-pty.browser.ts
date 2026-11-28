import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium } from '@playwright/test';
import { spawn } from 'node-pty';
import { describe, expect, it, onTestFinished } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { resolveBunExecutable } from '../../../scripts/lib/bun-executable.mjs';
import { TerminalWebSocketHandler } from '../../webui-server/src/server/terminal-ws-handler.js';
import { computeSidebarWidth } from '../src/components/sidebar.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const requireWebui = createRequire(new URL('../../webui/package.json', import.meta.url));
const xtermJs = readFileSync(requireWebui.resolve('@xterm/xterm/lib/xterm.js'));
const xtermCss = readFileSync(requireWebui.resolve('@xterm/xterm/css/xterm.css'));
const unicodeAddon = readFileSync(requireWebui.resolve('@xterm/addon-unicode11'));
const bun = (
  globalThis as typeof globalThis & {
    Bun: {
      Transpiler: new (options: { loader: 'ts' }) => { transformSync(source: string): string };
    };
  }
).Bun;
const transportJs = new bun.Transpiler({ loader: 'ts' }).transformSync(
  readFileSync(new URL('../../webui/src/lib/terminal-transport.ts', import.meta.url), 'utf8'),
);

interface TerminalClient {
  terminal: {
    cols: number;
    rows: number;
    resize(cols: number, rows: number): void;
    options: { fontFamily: string; fontSize: number };
    paste(text: string): void;
    clearSelection(): void;
    getSelection(): string;
    buffer: {
      active: {
        type: string;
        baseY: number;
        viewportY: number;
        length: number;
        getLine(row: number):
          | {
              translateToString(trim: boolean, start: number, end: number): string;
              getCell(col: number): { isInverse(): number } | undefined;
            }
          | undefined;
      };
    };
  };
  socket: WebSocket;
  sendInput(data: string): void;
  connect(): void;
  connected: boolean;
}

describe('full App through PTY / WebSocket / xterm.js', () => {
  it.each([false, true])(
    'keeps scroll, resize, paste and reconnect usable (sidebar=%s)',
    async (sidebar) => {
      const base = join(repo, '.temp_files', 'tui-browser-terminals');
      mkdirSync(base, { recursive: true });
      const root = mkdtempSync(join(base, 'pty-'));
      const trace = join(root, 'terminal.bin');
      const wss = new WebSocketServer({ noServer: true });
      const clients = new Set<WebSocket>();
      let inputMessages = 0;
      let browser: Browser | undefined;
      let handler: TerminalWebSocketHandler | undefined;
      let terminalExit: Promise<void> | undefined;
      const errors: string[] = [];
      const server = createServer((req, res) => {
        if (req.url === '/xterm.js') {
          res.setHeader('Content-Type', 'text/javascript');
          res.end(xtermJs);
        } else if (req.url === '/xterm.css') {
          res.setHeader('Content-Type', 'text/css');
          res.end(xtermCss);
        } else if (req.url === '/unicode11.js' || req.url === '/terminal-transport.js') {
          res.setHeader('Content-Type', 'text/javascript');
          res.end(req.url === '/unicode11.js' ? unicodeAddon : transportJs);
        } else {
          res.setHeader('Content-Type', 'text/html');
          res.end(`<!doctype html><link rel="stylesheet" href="/xterm.css"><div id="terminal"></div>
          <script src="/xterm.js"></script><script src="/unicode11.js"></script><script type="module">
          import { bindTerminalTransport } from '/terminal-transport.js';
          const terminal = window.terminal = new Terminal({ cols: 100, rows: 32, fontFamily: 'monospace', fontSize: 14, allowProposedApi: true });
          terminal.loadAddon(new window.Unicode11Addon.Unicode11Addon());
          terminal.unicode.activeVersion = '11';
          terminal.open(document.getElementById('terminal'));
          const handlers = new Map();
          let status = () => {};
          const ws = {
            send(message) {
              if (window.socket?.readyState !== WebSocket.OPEN) return false;
              window.socket.send(JSON.stringify(message));
              return true;
            },
            on(type, fn) { handlers.set(type, fn); return () => handlers.delete(type); },
            onStatus(fn) { status = fn; return () => { status = () => {}; }; },
          };
          const id = 'fixture';
          window.sendInput = (data) => ws.send({ type: 'terminal.input', payload: { id, data } });
          bindTerminalTransport({
            id, term: terminal, ws,
            onRunning: () => { window.connected = true; terminal.focus(); },
            onExit: ({ exitCode }) => terminal.write('\\r\\n[terminal exited: ' + exitCode + ']'),
            onOutput: () => {},
            onReplayGap: () => { throw new Error('unexpected replay gap'); },
          });
          window.connect = () => {
            const socket = window.socket = new WebSocket('ws://' + location.host);
            window.connected = false;
            socket.onopen = () => status({ state: 'open' });
            socket.onclose = () => { status({ state: 'closed' }); window.connected = false; };
            socket.onmessage = e => { const message = JSON.parse(e.data); handlers.get(message.type)?.(message); };
          };
          connect();
          </script>`);
        }
      });
      onTestFinished(async () => {
        handler?.dispose();
        for (const client of clients) client.terminate();
        wss.close();
        await browser?.close();
        server.closeAllConnections();
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        if (terminalExit) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`PTY did not exit: ${root}`)), 5000);
            void terminalExit!.then(() => {
              clearTimeout(timer);
              resolve();
            });
          });
        }
      });
      server.on('upgrade', (request, socket, head) =>
        wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request)),
      );
      wss.on('connection', (ws) => {
        clients.add(ws);
        handler?.addClient(ws);
        ws.on('message', (data) => {
          const message = JSON.parse(data.toString());
          if (message.type === 'terminal.input') {
            inputMessages++;
            appendFileSync(join(root, 'input.jsonl'), `${JSON.stringify(message.payload.data)}\n`);
          }
          void handler?.handleMessage(ws, message).catch((error) => errors.push(String(error)));
        });
        ws.on('close', () => clients.delete(ws));
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No fixture listener');
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        TERM: 'xterm-256color',
        WRONGSTACK_HOME: join(root, 'home'),
        WRONGSTACK_TUI_TERMINAL: 'browser',
        WRONGSTACK_TUI_ICON_STYLE: '',
        WSTACK_ICONS: 'auto',
        WRONGSTACK_NO_TITLE: '1',
        FORCE_COLOR: '3',
        COLORTERM: 'truecolor',
        WRONGSTACK_PTY_TEST_SIDEBAR: String(sidebar),
      };
      delete childEnv.NO_COLOR;
      handler = new TerminalWebSocketHandler(
        () => repo,
        { level: 'silent' } as never,
        () => ({
          spawn: (_file, _args, opts) => {
            const pty = spawn(
              resolveBunExecutable(),
              [fileURLToPath(new URL('./helpers/browser-pty-app.tsx', import.meta.url)), root],
              {
                ...opts,
                env: {
                  ...childEnv,
                  TERM: opts.env.TERM,
                  COLORTERM: opts.env.COLORTERM,
                  WRONGSTACK_TUI_TERMINAL: opts.env.WRONGSTACK_TUI_TERMINAL,
                },
              },
            );
            pty.onData((data) => appendFileSync(trace, data));
            terminalExit = new Promise<void>((resolve) => {
              pty.onExit(() => resolve());
            });
            return {
              write: (data) => pty.write(data),
              resize: (cols, rows) => pty.resize(cols, rows),
              kill: () => pty.kill(),
              onData: pty.onData,
              onExit: pty.onExit,
            };
          },
        }),
      );
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1300, height: 850 } });
      page.on('pageerror', (error) => errors.push(error.message));
      const screen = () =>
        page.evaluate(() => {
          const terminal = (globalThis as unknown as TerminalClient).terminal;
          return Array.from(
            { length: terminal.buffer.active.length },
            (_, row) =>
              terminal.buffer.active.getLine(row)?.translateToString(true, 0, terminal.cols) ?? '',
          );
        });
      const records = () =>
        readFileSync(join(root, 'events.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map(
            (line) =>
              JSON.parse(line) as {
                type: string;
                calls?: number;
                text?: string;
                blocks?: Array<{ type: string; text?: string }>;
              },
          );
      const runs = () => records().filter((event) => event.type === 'run');
      const checked = (name: string) =>
        appendFileSync(
          join(root, 'checks.jsonl'),
          `${JSON.stringify({ name, status: 'passed' })}\n`,
        );
      await page.goto(`http://127.0.0.1:${address.port}`);
      await expect
        .poll(async () => (await screen()).join('\n'), {
          timeout: 20_000,
          message: `Full App boot (${root})`,
        })
        .toContain('[Text]');
      expect(records()[0]).toMatchObject({
        type: 'boot',
        stdinTTY: true,
        stdoutTTY: true,
        capability: {
          terminalHost: { host: 'browser' },
          isWindowsConhost: false,
          graphicsProtocol: 'halfblock',
        },
      });
      await page.screenshot({ path: join(root, 'boot.png') });
      // Change both the emulator grid and the real PTY, as a host's fit addon
      // does after a browser zoom/font/viewport change. Inspect the full App,
      // including its sidebar, rather than just the isolated composer.
      for (const [cols, rows, fontSize] of [
        [40, 24, 18],
        [63, 20, 12],
        [64, 20, 12],
        [80, 24, 16],
        [160, 48, 10],
        [30, 12, 20],
        [100, 32, 14],
      ]) {
        await page.evaluate(
          ([cols, rows, fontSize]) => {
            const terminal = (globalThis as unknown as TerminalClient).terminal;
            terminal.options.fontSize = fontSize!;
            terminal.options.fontFamily = 'Courier New, monospace';
            terminal.resize(cols!, rows!);
          },
          [cols!, rows!, fontSize!],
        );
        const mainCols = cols! - (sidebar ? computeSidebarWidth(cols!) : 0);
        await expect
          .poll(
            async () => {
              const lines = await screen();
              const footer = lines[rows! - 2]?.slice(0, mainCols) ?? '';
              const top =
                lines.find((line) => line.startsWith('╭') && line.includes('WRONGSTACK')) ?? '';
              const composerEdge = Math.max(footer.lastIndexOf('╯'), top.indexOf('╮')) + 1;
              const sidebarVisible = lines.some((line) =>
                /\b(?:MODEL CORE|SESSION)\b/.test(line.slice(mainCols)),
              );
              return { footer: footer.includes('[Text]'), composerEdge, sidebarVisible };
            },
            {
              message: `composer after ${cols}x${rows} (${root})`,
            },
          )
          .toEqual({ footer: true, composerEdge: mainCols, sidebarVisible: mainCols < cols! });
        await expect
          .poll(async () => (await screen()).join('\n'), {
            message: `tail after ${cols}x${rows} (${root})`,
          })
          .toContain('PTY answer 40');
        await expect
          .poll(async () => (await screen()).filter((line) => line.includes('[Text]')), {
            message: `one composer after ${cols}x${rows} (${root})`,
          })
          .toHaveLength(1);
        expect(
          await page.evaluate(() => {
            const buffer = (globalThis as unknown as TerminalClient).terminal.buffer.active;
            return { type: buffer.type, baseY: buffer.baseY, viewportY: buffer.viewportY };
          }),
        ).toEqual({ type: 'alternate', baseY: 0, viewportY: 0 });
        await page
          .locator('.xterm-screen')
          .screenshot({ path: join(root, `resize-${cols}x${rows}.png`) });
      }
      checked('font and grid changes keep composer, tail and alternate screen intact');

      const resizeGrid = async (cols: number, rows: number) => {
        await page.evaluate(
          ([cols, rows]) => (globalThis as unknown as TerminalClient).terminal.resize(cols, rows),
          [cols, rows] as const,
        );
      };
      await resizeGrid(40, 24);
      const draft = `DRAFT-START ${'wrapped text '.repeat(39)}${' '.repeat(20)}DRAFT-END`;
      await page.keyboard.insertText(draft);
      await expect.poll(async () => (await screen()).join('\n')).toContain('DRAFT-END');
      await page.keyboard.press('Home');
      await expect.poll(async () => (await screen()).join('\n')).toContain('DRAFT-START');
      await resizeGrid(40, 8);
      await expect.poll(async () => (await screen()).slice(-8).join('\n')).toContain('DRAFT-START');
      await page.keyboard.press('End');
      await expect.poll(async () => (await screen()).slice(-8).join('\n')).toContain('DRAFT-END');
      await page.screenshot({ path: join(root, 'short-terminal-draft.png') });
      await page.keyboard.press('Control+u');
      await expect.poll(async () => (await screen()).join('\n')).not.toContain('DRAFT-END');
      await page.keyboard.insertText('panel draft');
      await expect.poll(async () => (await screen()).slice(-8).join('\n')).toContain('panel draft');
      await page.keyboard.press('F2');
      await expect
        .poll(async () => (await screen()).slice(-8).join('\n'))
        .toContain('FLEET CONTROL');
      await expect.poll(async () => (await screen()).slice(-8).join('\n')).toContain('F2/Esc');
      expect((await screen()).slice(-8).join('\n')).not.toContain('panel draft');
      await page.keyboard.press('z');
      await page.keyboard.press('Escape');
      await expect.poll(async () => (await screen()).slice(-8).join('\n')).toContain('panel draft');
      expect((await screen()).slice(-8).join('\n')).not.toContain('panel draftz');
      await page.keyboard.press('Control+u');
      await expect
        .poll(async () => (await screen()).slice(-8).join('\n'))
        .not.toContain('panel draft');
      checked('F2 uses the main area and protects the draft in an eight-row terminal');
      await resizeGrid(100, 32);
      await expect.poll(async () => (await screen()).join('\n')).toContain('PTY answer 40');
      checked(
        'Home and End keep the active row visible in an eight-row terminal with a long draft',
      );

      const paste = 'first browser line\nsecond browser line\nthird browser line';
      await page.evaluate(
        (text) => (globalThis as unknown as TerminalClient).terminal.paste(text),
        paste,
      );
      await expect.poll(async () => (await screen()).join('\n')).toContain('pasted #1');
      expect(records().filter((event) => event.type === 'run')).toHaveLength(0);
      await page.keyboard.press('Enter');
      await expect.poll(() => records().filter((event) => event.type === 'run')).toHaveLength(1);
      expect(
        records()
          .find((event) => event.type === 'run')
          ?.blocks?.map((block) => block.text ?? '')
          .join(''),
      ).toContain(paste);
      await expect
        .poll(async () => (await screen()).join('\n'))
        .toContain('PTY completed request 1');
      await page.screenshot({ path: join(root, 'submitted.png') });
      checked('multiline paste waits for Enter and submits all line breaks once');

      const tail = (await screen()).join('\n');
      await page.keyboard.press('PageUp');
      await expect.poll(async () => (await screen()).join('\n')).not.toBe(tail);
      const paged = (await screen()).filter((line) => line.includes('PTY answer')).join('\n');
      const terminalBox = await page.locator('.xterm-screen').boundingBox();
      if (!terminalBox) throw new Error('No xterm screen geometry');
      await page.mouse.move(
        terminalBox.x + terminalBox.width / 2,
        terminalBox.y + terminalBox.height / 3,
      );
      await page.mouse.wheel(0, -600);
      await expect
        .poll(async () => (await screen()).filter((line) => line.includes('PTY answer')).join('\n'))
        .not.toBe(paged);
      expect(runs()).toHaveLength(1);
      await page.screenshot({ path: join(root, 'scrolled.png') });
      checked('PageUp and native wheel events scroll managed transcript');

      const selectionLines = await screen();
      const row = selectionLines.findIndex((line) => line.includes('selectable transcript text'));
      const col = selectionLines[row]?.indexOf('selectable') ?? -1;
      expect(row).toBeGreaterThanOrEqual(0);
      expect(col).toBeGreaterThanOrEqual(0);
      const cellWidth = terminalBox.width / 100;
      const cellHeight = terminalBox.height / 32;
      await page.keyboard.down('Shift');
      try {
        await page.mouse.move(
          terminalBox.x + (col + 0.2) * cellWidth,
          terminalBox.y + (row + 0.5) * cellHeight,
        );
        await page.mouse.down();
        await page.mouse.move(
          terminalBox.x + (col + 10.8) * cellWidth,
          terminalBox.y + (row + 0.5) * cellHeight,
          { steps: 12 },
        );
        await page.mouse.up();
      } finally {
        await page.keyboard.up('Shift');
      }
      await page.screenshot({ path: join(root, 'selection.png') });
      await expect
        .poll(() =>
          page.evaluate(() => (globalThis as unknown as TerminalClient).terminal.getSelection()),
        )
        .toContain('selectable');
      checked('Shift-drag selects visible transcript text while mouse tracking is active');

      await page.evaluate(() =>
        (globalThis as unknown as TerminalClient).terminal.clearSelection(),
      );
      await page.mouse.move(
        terminalBox.x + (col + 0.5) * cellWidth,
        terminalBox.y + (row + 0.5) * cellHeight,
      );
      await page.mouse.down();
      try {
        await page.mouse.move(
          terminalBox.x + (col + 8.5) * cellWidth,
          terminalBox.y + (row + 0.5) * cellHeight,
          { steps: 8 },
        );
        await expect
          .poll(() =>
            page.evaluate(
              ([r, c]) =>
                (globalThis as unknown as TerminalClient).terminal.buffer.active
                  .getLine(r!)
                  ?.getCell(c!)
                  ?.isInverse(),
              [row, col + 2],
            ),
          )
          .toBeGreaterThan(0);
        await page.screenshot({ path: join(root, 'app-selection.png') });
        // Cancel in the gutter before release, keeping the user's OS clipboard
        // untouched while verifying the App's real drag/SGR highlight path.
        await page.mouse.move(
          terminalBox.x + terminalBox.width - cellWidth / 2,
          terminalBox.y + (row + 0.5) * cellHeight,
          { steps: 8 },
        );
      } finally {
        await page.mouse.up();
      }
      checked(
        'App text selection highlights the dragged transcript cells and cancels at the gutter',
      );

      // The production terminal transport reattaches the existing renderer and PTY.
      await page.keyboard.type('reconnect draft');
      await expect.poll(async () => (await screen()).join('\n')).toContain('reconnect draft');
      await page.evaluate(() => (globalThis as unknown as TerminalClient).socket.close());
      await expect
        .poll(() => page.evaluate(() => (globalThis as unknown as TerminalClient).connected))
        .toBe(false);
      await page.evaluate(() => (globalThis as unknown as TerminalClient).connect());
      await expect
        .poll(() => page.evaluate(() => (globalThis as unknown as TerminalClient).connected))
        .toBe(true);
      await expect.poll(async () => (await screen()).join('\n')).toContain('reconnect draft');
      expect(records().filter((event) => event.type === 'boot')).toHaveLength(1);
      expect(runs()).toHaveLength(1);
      await page.keyboard.type(' after reconnect');
      await page.keyboard.press('Enter');
      await expect.poll(() => runs()).toHaveLength(2);
      expect(
        runs()[1]
          ?.blocks?.map((block) => block.text ?? '')
          .join(''),
      ).toContain('reconnect draft after reconnect');
      await expect
        .poll(async () => (await screen()).join('\n'))
        .toContain('PTY completed request 2');
      checked('reconnect replays the retained PTY without losing or double-submitting the draft');

      const beforePartial = inputMessages;
      await page.evaluate(() =>
        (globalThis as unknown as TerminalClient).sendInput('\x1b[200~first reconnect line\r'),
      );
      await expect.poll(() => inputMessages).toBeGreaterThan(beforePartial);
      await page.evaluate(() => (globalThis as unknown as TerminalClient).socket.close());
      await expect
        .poll(() => page.evaluate(() => (globalThis as unknown as TerminalClient).connected))
        .toBe(false);
      // Exercise a real network pause longer than the old 500 ms paste-idle path.
      await page.waitForTimeout(650);
      expect(runs()).toHaveLength(2);
      await page.evaluate(() => (globalThis as unknown as TerminalClient).connect());
      await expect
        .poll(() => page.evaluate(() => (globalThis as unknown as TerminalClient).connected))
        .toBe(true);
      await page.evaluate(() =>
        (globalThis as unknown as TerminalClient).sendInput('second reconnect line\x1b[201~'),
      );
      await expect
        .poll(async () =>
          (await screen()).some((line) => line.startsWith('│ >') && line.includes('pasted #')),
        )
        .toBe(true);
      expect(runs()).toHaveLength(2);
      await page.keyboard.press('Enter');
      await expect.poll(() => runs()).toHaveLength(3);
      expect(
        runs()[2]
          ?.blocks?.map((block) => block.text ?? '')
          .join(''),
      ).toContain('first reconnect line\nsecond reconnect line');
      await expect
        .poll(async () => (await screen()).join('\n'))
        .toContain('PTY completed request 3');
      checked('a partial multiline paste survives a 650 ms disconnect and completes exactly once');
      await page.keyboard.type('newline-only paste');
      await page.evaluate(() => (globalThis as unknown as TerminalClient).terminal.paste('\n'));
      await expect
        .poll(async () =>
          (await screen()).some((line) => line.startsWith('│ >') && line.includes('pasted #')),
        )
        .toBe(true);
      expect(runs()).toHaveLength(3);
      await page.keyboard.press('Enter');
      await expect.poll(() => runs()).toHaveLength(4);
      expect(
        runs()[3]
          ?.blocks?.map((block) => block.text ?? '')
          .join(''),
      ).toContain('newline-only paste');
      await expect
        .poll(async () => (await screen()).join('\n'))
        .toContain('PTY completed request 4');
      checked('a newline-only paste stays data and does not submit the existing draft');
      writeFileSync(join(root, 'stream-command.json'), JSON.stringify({ text: 'STREAM-A' }));
      await page.keyboard.type('stream-proof');
      await page.keyboard.press('Enter');
      await expect.poll(() => runs()).toHaveLength(5);
      await expect.poll(async () => (await screen()).join('\n')).toContain('STREAM-A');
      const transcript = async () =>
        (await screen()).join('\n').match(/PTY (?:answer|question) \d+/g);
      for (let pageUp = 0; pageUp < 2; pageUp++) {
        const previous = (await transcript())?.[0];
        await page.keyboard.press('PageUp');
        await expect.poll(async () => (await transcript())?.[0]).not.toBe(previous);
      }
      await expect.poll(transcript).not.toBeNull();
      const reading = await transcript();
      writeFileSync(
        join(root, 'stream-command.json'),
        JSON.stringify({ text: 'STREAM-A\nSTREAM-B' }),
      );
      await expect
        .poll(
          () =>
            records()
              .filter((event) => event.type === 'stream')
              .at(-1)?.text,
        )
        .toContain('STREAM-B');
      // A real draft edit forces an App frame after the provider update; the
      // anchored transcript must keep the reader's content while output grows.
      await page.keyboard.type('draft while reading');
      await expect.poll(async () => (await screen()).join('\n')).toContain('draft while reading');
      expect(await transcript()).toEqual(reading);
      for (const cols of [60, 100]) {
        await page.evaluate(
          (cols) => (globalThis as unknown as TerminalClient).terminal.resize(cols, 32),
          cols,
        );
        const top = reading![0]!;
        await expect
          .poll(async () => (await screen()).join('\n'), {
            message: `reader anchor at ${cols} columns (${root})`,
          })
          .toContain(top);
        await page.screenshot({ path: join(root, `reading-${cols}.png`) });
      }
      // The app owns wheel reports; xterm's outer viewport must stay at zero.
      expect(
        await page.evaluate(
          () => (globalThis as unknown as TerminalClient).terminal.buffer.active.viewportY,
        ),
      ).toBe(0);
      for (let i = 0; i < 8; i++) await page.keyboard.press('PageDown');
      await expect.poll(async () => (await screen()).join('\n')).toContain('STREAM-B');
      writeFileSync(
        join(root, 'stream-command.json'),
        JSON.stringify({ text: 'STREAM-A\nSTREAM-B\nSTREAM-C', finish: true }),
      );
      await expect.poll(async () => (await screen()).join('\n')).toContain('STREAM-C');
      expect(runs()).toHaveLength(5);
      checked(
        'reader anchor survives stream growth and resize; paging to tail resumes following output',
      );
      await page.screenshot({ path: join(root, 'reconnected.png') });
      await expect
        .poll(async () => (await screen()).some((line) => /WRONGSTACK.*idle/.test(line)))
        .toBe(true);
      await page.keyboard.press('Control+u');
      await expect
        .poll(async () => (await screen()).join('\n'))
        .not.toContain('draft while reading');
      const longPaste = `${'a'.repeat(49_960)}🚀\nlong paste end`;
      await page.evaluate(
        (text) => (globalThis as unknown as TerminalClient).terminal.paste(text),
        longPaste,
      );
      await expect
        .poll(async () => (await screen()).find((line) => line.includes('│ >')) ?? '', {
          message: `long paste should stay in the composer (${root})`,
          timeout: 15_000,
        })
        .toContain('pasted #');
      expect(runs()).toHaveLength(5);
      await page.keyboard.press('Enter');
      await expect.poll(() => runs()).toHaveLength(6);
      const pasted =
        runs()[5]
          ?.blocks?.map((block) => block.text ?? '')
          .join('') ?? '';
      expect(pasted.includes(longPaste)).toBe(true);
      await expect
        .poll(async () => (await screen()).join('\n'))
        .toContain('PTY completed request 6');
      const oversizedPaste = `${'a'.repeat(65_529)}🚀\noversized paste end`;
      await page.evaluate(
        (text) => (globalThis as unknown as TerminalClient).terminal.paste(text),
        oversizedPaste,
      );
      await expect
        .poll(async () => (await screen()).join('\n'), { timeout: 15_000 })
        .toContain('Paste rejected');
      expect(runs()).toHaveLength(6);
      checked(
        'the production route delivers a large Unicode paste and its closing delimiter intact',
      );
      expect(errors).toEqual([]);
    },
    60_000,
  );
});
