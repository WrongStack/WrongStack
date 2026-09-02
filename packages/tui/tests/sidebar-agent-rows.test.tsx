import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { SidebarContent } from '../src/components/sidebar-content.js';
import type { FleetEntry } from '../src/app-state-fleet.js';

const WIDTH = 36; // typical sidebar width

function makeEntry(
  id: string,
  name: string,
  status: FleetEntry['status'],
  opts?: Partial<FleetEntry>,
): FleetEntry {
  return {
    id,
    name,
    status,
    ctxPct: opts?.ctxPct,
    currentTool: opts?.currentTool,
  } as FleetEntry;
}

describe('SidebarContent agent rows — 2-line format', () => {
  it('renders each agent as 2 lines (name+ctx% / status+tool)', () => {
    const entries: Record<string, FleetEntry> = {};
    const leader = makeEntry('leader', 'Leader Agent', 'running', {
      ctxPct: 0.42,
      currentTool: { name: 'read' } as never,
    });
    const sub1 = makeEntry('sub-1', 'bug-hunter', 'running', {
      ctxPct: 0.15,
      currentTool: { name: 'grep' } as never,
    });
    const sub2 = makeEntry('sub-2', 'refactor-planner', 'running', { ctxPct: 0.08 });
    entries['leader'] = leader;
    entries['sub-1'] = sub1;
    entries['sub-2'] = sub2;

    const { lastFrame } = render(
      React.createElement(SidebarContent, {
        contextWindow: { used: 1000, max: 10000 },
        entries,
        fleetCounts: { running: 2, idle: 0, pending: 0, completed: 0 },
        width: WIDTH,
        showSwarmSection: true,
      }),
    );

    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');

    // Leader: line 1 should have name + ctx%, line 2 should have status + tool
    const leaderLine1 = lines.find((l) => l.includes('Leader Agent'));
    const leaderLine2 = lines.find((l) => l.includes('running') && l.includes('read'));
    expect(leaderLine1).toBeDefined();
    expect(leaderLine1).toContain('42%');
    expect(leaderLine2).toBeDefined();
    expect(leaderLine2).toContain('running');

    // Sub-agent: bug-hunter with grep tool
    const subLine1 = lines.find((l) => l.includes('bug-hunter'));
    const subLine2 = lines.find((l) => l.includes('running') && l.includes('grep'));
    expect(subLine1).toBeDefined();
    expect(subLine1).toContain('15%');
    expect(subLine2).toBeDefined();

    // refactor-planner with no tool — line 2 should have just 'running'
    const plannerLine1 = lines.find((l) => l.includes('refactor-planner'));
    expect(plannerLine1).toBeDefined();
    expect(plannerLine1).toContain('8%');
  });

  it('hides the swarm summary and agent rows outside sidebar mode', () => {
    const entries = {
      leader: makeEntry('leader', 'Leader Agent', 'running', {
        ctxPct: 0.42,
        currentTool: { name: 'read' } as never,
      }),
    };

    const { lastFrame } = render(
      React.createElement(SidebarContent, {
        contextWindow: { used: 1000, max: 10000 },
        entries,
        fleetCounts: { running: 1, idle: 0, pending: 0, completed: 0 },
        width: WIDTH,
        showSwarmSection: false,
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('AGENT SWARM');
    expect(frame).not.toContain('Leader Agent');
    expect(frame).not.toContain('1 LIVE');
    expect(frame).not.toContain('running · read');
  });

  it('shows +N more when agents exceed the cap', () => {
    const entries: Record<string, FleetEntry> = {};
    const leader = makeEntry('leader', 'Leader Agent', 'running');
    entries['leader'] = leader;
    for (let i = 1; i <= 15; i++) {
      entries[`sub-${i}`] = makeEntry(`sub-${i}`, `agent-${i}`, 'running');
    }

    const { lastFrame } = render(
      React.createElement(SidebarContent, {
        contextWindow: { used: 1000, max: 10000 },
        entries,
        fleetCounts: { running: 15, idle: 0, pending: 0, completed: 0 },
        width: WIDTH,
        showSwarmSection: true,
      }),
    );

    const frame = lastFrame() ?? '';
    // 15 subagents, cap is 11 (12 - 1 leader) → +4 more
    expect(frame).toContain('+4 more');
  });

  it('shows focus indicator when focused=true', () => {
    const { lastFrame } = render(
      React.createElement(SidebarContent, {
        contextWindow: { used: 1000, max: 10000 },
        entries: {},
        fleetCounts: undefined,
        width: WIDTH,
        focused: true,
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('scroll');
    expect(frame).toContain('Shift+Tab');
  });

  it('does NOT show focus indicator when focused=false', () => {
    const { lastFrame } = render(
      React.createElement(SidebarContent, {
        contextWindow: { used: 1000, max: 10000 },
        entries: {},
        fleetCounts: undefined,
        width: WIDTH,
        focused: false,
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('Shift+Tab');
  });
});
