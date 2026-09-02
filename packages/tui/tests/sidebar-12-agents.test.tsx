import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { SidebarContent } from '../src/components/sidebar-content.js';
import type { FleetEntry } from '../src/app-state-fleet.js';

const WIDTH = 40;

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

describe('Sidebar 12+ subagent visual snapshot', () => {
  it('renders 13 agents (1 leader + 12 subagents) with correct 2-line rows and +N more', () => {
    const entries: Record<string, FleetEntry> = {};
    entries['leader'] = makeEntry('leader', 'Leader Agent', 'running', {
      ctxPct: 0.55,
      currentTool: { name: 'edit' } as never,
    });
    for (let i = 1; i <= 12; i++) {
      entries[`sub-${i}`] = makeEntry(
        `sub-${i}`,
        `agent-${String(i).padStart(2, '0')}`,
        'running',
        {
          ctxPct: 0.05 + i * 0.03,
          currentTool: { name: i % 3 === 0 ? 'grep' : i % 3 === 1 ? 'read' : 'bash' } as never,
        },
      );
    }

    const { lastFrame } = render(
      React.createElement(SidebarContent, {
        contextWindow: { used: 12000, max: 200000 },
        entries,
        fleetCounts: { running: 12, idle: 0, pending: 0, completed: 0 },
        width: WIDTH,
        showSwarmSection: true,
      }),
    );

    const frame = lastFrame() ?? '';
    console.log('\n========== SIDEBAR RENDER (13 agents) ==========\n');
    console.log(frame);
    console.log('\n========== END ==========\n');

    // Verify: leader is rendered
    const leaderLines = frame.split('\n').filter((l) => l.includes('Leader Agent'));
    expect(leaderLines.length).toBe(1);
    expect(leaderLines[0]).toContain('55%');

    // Verify: leader's second line shows tool
    const leaderToolLine = frame
      .split('\n')
      .filter((l) => l.includes('running') && l.includes('edit'));
    expect(leaderToolLine.length).toBeGreaterThanOrEqual(1);

    // Verify: 11 subagents visible (cap = 12 - 1 leader = 11)
    // Each subagent has a name line containing 'agent-'
    const agentNameLines = frame.split('\n').filter((l) => l.includes('agent-'));
    expect(agentNameLines.length).toBe(11); // capped at 11

    // Verify: +1 more (12 subagents - 11 cap = 1 hidden)
    expect(frame).toContain('+1 more');

    // Verify: each visible agent has a status line
    const statusLines = frame
      .split('\n')
      .filter(
        (l) =>
          l.includes('▎') &&
          l.includes('running') &&
          !l.includes('LIVE') &&
          !l.includes('running active'),
      );
    // 1 leader + 11 subagents = 12 aligned, accent-railed status lines
    expect(statusLines.length).toBe(12);
  });

  it('renders 20 subagents with correct cap and +N more count', () => {
    const entries: Record<string, FleetEntry> = {};
    entries['leader'] = makeEntry('leader', 'Leader Agent', 'running', { ctxPct: 0.8 });
    for (let i = 1; i <= 20; i++) {
      entries[`sub-${i}`] = makeEntry(`sub-${i}`, `worker-${i}`, 'running', {
        ctxPct: 0.1,
      });
    }

    const { lastFrame } = render(
      React.createElement(SidebarContent, {
        contextWindow: { used: 50000, max: 200000 },
        entries,
        fleetCounts: { running: 20, idle: 0, pending: 0, completed: 0 },
        width: WIDTH,
        showSwarmSection: true,
      }),
    );

    const frame = lastFrame() ?? '';
    console.log('\n========== SIDEBAR RENDER (20 subagents) ==========\n');
    console.log(frame);
    console.log('\n========== END ==========\n');

    // 20 subagents, cap = 11 → +9 more
    expect(frame).toContain('+9 more');

    // 11 worker name lines visible
    const workerLines = frame.split('\n').filter((l) => l.includes('worker-'));
    expect(workerLines.length).toBe(11);
  });

  it('renders with no leader (12 subagents only)', () => {
    const entries: Record<string, FleetEntry> = {};
    for (let i = 1; i <= 14; i++) {
      entries[`sub-${i}`] = makeEntry(`sub-${i}`, `bot-${i}`, 'running', {
        ctxPct: 0.2,
        currentTool: { name: 'test' } as never,
      });
    }

    const { lastFrame } = render(
      React.createElement(SidebarContent, {
        contextWindow: { used: 5000, max: 200000 },
        entries,
        fleetCounts: { running: 14, idle: 0, pending: 0, completed: 0 },
        width: WIDTH,
        showSwarmSection: true,
      }),
    );

    const frame = lastFrame() ?? '';
    console.log('\n========== SIDEBAR RENDER (14 subagents, no leader) ==========\n');
    console.log(frame);
    console.log('\n========== END ==========\n');

    // No leader → cap = 12 → +2 more
    expect(frame).toContain('+2 more');
    const botLines = frame.split('\n').filter((l) => l.includes('bot-'));
    expect(botLines.length).toBe(12);
  });
});
