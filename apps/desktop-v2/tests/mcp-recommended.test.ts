// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { IntegrationSettings } from '../src/IntegrationSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  // jsdom has no modal dialogs; opening one only has to mark it open here.
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
});

async function mount(servers: Record<string, unknown>[] = []) {
  const command = vi.fn(async (type: string) =>
    type === 'mcp.list' ? { servers } : { message: 'Added.' },
  );
  const host = document.createElement('div');
  await act(async () =>
    createRoot(host).render(createElement(IntegrationSettings, { command: command as never })),
  );
  const add = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === 'Add connection',
  );
  act(() => add?.click());
  return { host, command };
}

function choose(select: HTMLSelectElement, value: string) {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('recommended MCP servers in the add dialog', () => {
  it('fills a local server and saves its extra configuration, disabled', async () => {
    const { host, command } = await mount();
    const picker = host.querySelector<HTMLSelectElement>('[aria-label="Recommended MCP server"]');
    choose(picker as HTMLSelectElement, 'github');
    expect(host.querySelector<HTMLInputElement>('[aria-label="Connection name"]')?.value).toBe(
      'github',
    );
    expect(host.querySelector<HTMLInputElement>('[aria-label="MCP executable"]')?.value).toBe(
      'npx',
    );
    expect(host.textContent).toContain('Needs GITHUB_PERSONAL_ACCESS_TOKEN');
    await act(async () =>
      host.querySelector('dialog form')?.dispatchEvent(new Event('submit', { bubbles: true })),
    );
    expect(command).toHaveBeenCalledWith(
      'mcp.add',
      expect.objectContaining({
        name: 'github',
        enabled: false,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        description: expect.stringContaining('GitHub'),
      }),
      ['mcp.operation_result'],
    );
  });

  it('fills a remote endpoint and lists configured servers as added', async () => {
    const { host } = await mount([{ name: 'filesystem' }]);
    const picker = host.querySelector<HTMLSelectElement>(
      '[aria-label="Recommended MCP server"]',
    ) as HTMLSelectElement;
    const filesystem = [...picker.options].find((option) => option.value === 'filesystem');
    expect(filesystem?.disabled).toBe(true);
    expect(filesystem?.textContent).toContain('(added)');
    choose(picker, 'context7');
    expect(host.querySelector<HTMLInputElement>('[aria-label="MCP server URL"]')?.value).toBe(
      'https://mcp.context7.com/mcp',
    );
  });
});
