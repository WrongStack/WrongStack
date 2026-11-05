// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { ProjectToolsMenu } from '../src/ProjectToolsMenu';
import { owningTool, projectToolGroups, projectTools } from '../src/project-tools';
import { PROJECT_PAGES, type ProjectPage } from '../src/useDesktop';

const PINNED: ProjectPage[] = ['files', 'changes', 'memory', 'kanban'];

async function render(props: {
  page?: ProjectPage;
  variant?: 'launcher' | 'overview';
}): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  await act(async () =>
    createRoot(host).render(
      createElement(ProjectToolsMenu, {
        page: props.page,
        variant: props.variant ?? 'launcher',
        onOpen: () => {},
      }),
    ),
  );
  return host;
}

describe('the project tool catalog', () => {
  it('names every tool a project page, and no page twice', () => {
    for (const tool of projectTools) expect(PROJECT_PAGES).toContain(tool.id);
    expect(new Set(projectTools.map((tool) => tool.id)).size).toBe(projectTools.length);
  });

  it('gives every tool its own icon', () => {
    // The old launcher used the same Network icon for Code Atlas and the live fleet.
    const icons = projectTools.map((tool) => tool.Icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('leaves the live fleet to the roster instead of listing it as a tool', () => {
    expect(projectTools.map((tool) => tool.id)).not.toContain('live-fleet');
    expect(owningTool('live-fleet')).toBe('roster');
    expect(owningTool('roster')).toBe('roster');
    expect(owningTool(undefined)).toBeUndefined();
  });

  it('groups every tool, and covers every page the menus do not pin', () => {
    expect(projectToolGroups.every((group) => group.tools.length > 0)).toBe(true);
    const listed = new Set(projectTools.map((tool) => tool.id));
    for (const page of PROJECT_PAGES) {
      const expected = !PINNED.includes(page) && page !== 'overview' && page !== 'live-fleet';
      expect(listed.has(page), page).toBe(expected);
    }
  });
});

describe('the tool menus', () => {
  it('shows the same tools in both menus, grouped the same way', async () => {
    const launcher = await render({ variant: 'launcher' });
    const overview = await render({ variant: 'overview' });
    const groups = (host: HTMLElement) =>
      [...host.querySelectorAll('.project-tools-group h3')].map((node) => node.textContent);
    expect(groups(launcher)).toEqual(groups(overview));
    expect(groups(launcher).length).toBe(projectToolGroups.length);
    const tools = (host: HTMLElement) =>
      [...host.querySelectorAll('.project-tool strong')].map((node) => node.textContent);
    // The overview promotes the featured tools to their own cards.
    expect(tools(launcher).length).toBe(projectTools.length);
    expect(tools(overview).length).toBe(projectTools.filter((tool) => !tool.featured).length);
  });

  it('marks the open tool in both menus', async () => {
    const launcher = await render({ page: 'chronicle', variant: 'launcher' });
    const overview = await render({ page: 'chronicle', variant: 'overview' });
    for (const host of [launcher, overview]) {
      const current = host.querySelectorAll('.project-tool[aria-current="page"]');
      expect(current.length).toBe(1);
      expect(current[0]?.querySelector('strong')?.textContent).toBe('Chronicle');
    }
  });

  it('keeps the live fleet marked under the roster while it is open', async () => {
    const launcher = await render({ page: 'live-fleet', variant: 'launcher' });
    const current = launcher.querySelectorAll('.project-tool[aria-current="page"]');
    expect(current.length).toBe(1);
    expect(current[0]?.querySelector('strong')?.textContent).toBe('Agent Roster');
  });

  it('summarises each tool in the overview', async () => {
    const overview = await render({ variant: 'overview' });
    const cards = [...overview.querySelectorAll('.project-tool')];
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards)
      expect(
        card.querySelector('.project-tool-copy span')?.textContent?.trim().length,
      ).toBeGreaterThan(0);
  });
});
