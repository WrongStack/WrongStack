/** Full production launch in a real PTY; only the agent/provider boundary is deterministic. */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { ContentBlock, Message } from '@wrongstack/contracts/types';
import type { Agent } from '@wrongstack/core/agent';
import { SlashCommandRegistry } from '@wrongstack/core/registry';
import { DefaultAttachmentStore } from '@wrongstack/core/storage';
import { detectTerminal } from '@wrongstack/core/utils';
import type { Settings } from '../../src/app-state.js';
import { SETTINGS_DEFAULTS } from '../../src/components/settings-picker-model.js';
import { runTui } from '../../src/run-tui.js';
import { DEFAULT_PANEL_POSITIONS } from '../../src/ui-contracts.js';

const root = process.argv[2]!;
const record = (event: unknown) =>
  appendFileSync(join(root, 'events.jsonl'), `${JSON.stringify(event)}\n`);
const noop = () => {};
const restoredMessages: Message[] = Array.from({ length: 40 }, (_, index) => [
  {
    role: 'user' as const,
    content: [
      { type: 'text' as const, text: `PTY question ${String(index + 1).padStart(2, '0')}` },
    ],
  },
  {
    role: 'assistant' as const,
    content: [
      {
        type: 'text' as const,
        text: `PTY answer ${String(index + 1).padStart(2, '0')} selectable transcript text`,
      },
    ],
  },
]).flat();
if (process.env.WRONGSTACK_PTY_TEST_RICH === '1') {
  // Clusters that string-width and xterm.js measure differently.
  restoredMessages.push(
    { role: 'user', content: [{ type: 'text', text: 'Show rich content ✅ 中文 🚀' }] },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: [
            '## Status ✅ done ⚠️ warn',
            '',
            '- ⚠️ warning item with VS16 then text RIGHT-EDGE',
            '- 🚀 rocket 👍🏽 skin tone then text RIGHT-EDGE',
            '- 中文字符 测试 日本語 한국어 then text RIGHT-EDGE',
            '- flag 🇹🇷 family 👨‍👩‍👧 zwj then text RIGHT-EDGE',
            '',
            '| col | 状态 | note |',
            '|---|---|---|',
            '| a ✅ | 完成 | ⚠️ x |',
            '| bb | 进行中 | 🚀 y |',
            '',
            'LAST-RICH-LINE',
          ].join('\n'),
        },
      ],
    },
  );
}
const events = new EventBus();
let calls = 0;
const agent = {
  ctx: {
    todos: [],
    messages: restoredMessages,
    meta: {},
    state: { onChange: () => noop },
    projectRoot: root,
    cwd: root,
    workingDir: root,
    model: 'fixture/terminal-model',
    provider: { id: 'fixture', capabilities: { maxContext: 200_000, supportsVision: false } },
    session: { id: 'pty-browser-session', writeEvent: noop, close: async () => {} },
    eventSessionId: () => 'pty-browser-session',
    sideEffects: [],
    signal: new AbortController().signal,
    tokenCounter: {
      countTokens: () => 0,
      estimateCost: () => ({ total: 0 }),
      total: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    },
    onWorkingDirChanged: () => noop,
    systemPrompt: [],
    tools: [],
    agentId: 'pty-fixture',
    agentName: 'PTY fixture',
    writtenFiles: new Set(),
    recordRead: noop,
  },
  run: async (blocks: ContentBlock[]) => {
    calls++;
    record({ type: 'run', calls, blocks });
    if (blocks.some((block) => block.type === 'text' && block.text === 'stream-proof')) {
      let text = '';
      const commandPath = join(root, 'stream-command.json');
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (existsSync(commandPath)) {
          const command = JSON.parse(readFileSync(commandPath, 'utf8')) as {
            text: string;
            finish?: boolean;
          };
          if (command.text !== text) {
            events.emit('provider.text_delta', {
              ctx: agent.ctx,
              text: command.text.slice(text.length),
            });
            text = command.text;
            record({ type: 'stream', text });
          }
          if (command.finish) return { status: 'done', iterations: 1, finalText: text };
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('Browser streaming proof did not finish');
    }
    return { status: 'done', iterations: 1, finalText: `PTY completed request ${calls}` };
  },
  abort: noop,
  on: () => noop,
} as unknown as Agent;
const sidebar = process.env.WRONGSTACK_PTY_TEST_SIDEBAR === 'true';
let settings: Settings = {
  ...SETTINGS_DEFAULTS,
  fleetChatVerbosity: 'off',
  featureTokenSaving: 'off',
  lastSettingsField: 67,
  showSidebar: sidebar,
  panelPositions: sidebar
    ? { ...DEFAULT_PANEL_POSITIONS, fleet: 'sidebar' }
    : DEFAULT_PANEL_POSITIONS,
  chime: false,
  selectionMode: 'text',
};
record({
  type: 'boot',
  pid: process.pid,
  stdinTTY: process.stdin.isTTY,
  stdoutTTY: process.stdout.isTTY,
  capability: detectTerminal(),
});
const code = await runTui({
  agent,
  events,
  attachments: new DefaultAttachmentStore(),
  slashRegistry: new SlashCommandRegistry(),
  model: 'fixture/terminal-model',
  banner: false,
  restoredMessages,
  chime: false,
  titleAnimation: false,
  enhanceController: { enabled: false, setEnabled: noop },
  statuslineHiddenItems: [],
  setStatuslineHiddenItems: noop,
  saveStatuslineHiddenItems: async () => {},
  getSettings: () => settings,
  saveSettings: async (next) => {
    settings = next;
    record({ type: 'settings', selectionMode: next.selectionMode });
    return null;
  },
});
record({ type: 'exit', code });
process.exit(code);
