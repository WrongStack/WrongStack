/**
 * The `/context cliff` report and the Context X-Ray viewer.
 *
 * Both exist to answer one question honestly: where does compaction actually
 * fire, and does the model's long-context price boundary change that answer?
 * The report must therefore tell the four states apart — no tier published, a
 * tier the window-relative ladder already beats, a tier that cannot be applied
 * because the session has no known window, and a tier actively pulling the
 * trigger in — because recommending the wrong fix is worse than no report.
 *
 * The viewer is checked at its two real failure modes: it must render the
 * item-by-item rows the feature promises, and it must render *nothing* rather
 * than a half-populated panel when the server sent no snapshot.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ContextXRay } from '../../src/components/ContextXRay.js';

const ONE_M = 1_000_000;

function fixture() {
  return {
    system: {
      total: 24_000,
      bySource: { skills: 9_000, 'project-instructions': 8_000, identity: 7_000 },
    },
    tools: {
      total: 18_000,
      builtin: 12_000,
      mcp: 6_000,
      count: 42,
      mcpByServer: { kanban: 4_000, sage: 2_000 },
    },
    history: {
      total: 120_000,
      text: 20_000,
      toolInputs: 15_000,
      toolResults: 80_000,
      thinking: 4_000,
      other: 1_000,
      messageCount: 64,
    },
    volatile: { ledger: 1_200, nextsteps: 800, continuity: 400, memoryEvidence: 600, total: 3_000 },
    total: 165_000,
    effectiveMaxContext: ONE_M,
    usedPct: 0.165,
    warnings: [],
  };
}

const cliff = {
  binding: true,
  cliffTokens: 200_000,
  multiplier: 2,
  field: 'input',
  triggerTokens: 190_000,
  uncappedTriggerTokens: 691_398,
  targetTokens: 160_000,
  availableInputTokens: 987_712,
  inputTokens: 165_000,
  tokensToTrigger: 25_000,
};

describe('ContextXRay', () => {
  it('renders nothing when the server sent no snapshot', () => {
    const { container } = render(<ContextXRay maxContext={ONE_M} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when no window is known instead of dividing by zero', () => {
    // The snapshot's own denominator wins over the prop, so an unknown window
    // has to be unknown in both places.
    const noWindow = { ...fixture(), effectiveMaxContext: 0 };
    const { container } = render(
      <ContextXRay xray={noWindow as never} maxContext={0} className="mt-2" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows the four cost centers with the occupancy total', () => {
    render(<ContextXRay xray={fixture() as never} cliff={cliff as never} maxContext={ONE_M} />);

    expect(screen.getByText('Context X-Ray')).toBeTruthy();
    expect(screen.getByRole('img')).toBeTruthy();
    for (const label of ['System Prompt', 'Tools', 'Messages', 'Volatile blocks']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    // Item counts ride on the section rows, not the bar.
    expect(screen.getByText('(42)')).toBeTruthy();
    expect(screen.getByText('(64)')).toBeTruthy();
  });

  it('reveals what inside a section costs the tokens', () => {
    render(<ContextXRay xray={fixture() as never} maxContext={ONE_M} />);

    // File outputs and MCP servers are the rows the feature exists to show.
    expect(screen.queryByText('File outputs')).toBeNull();
    fireEvent.click(screen.getByText('Tools'));
    expect(screen.getByText('Built-in schemas')).toBeTruthy();
    expect(screen.getByText('MCP schemas')).toBeTruthy();
    expect(screen.getByText('mcp:kanban')).toBeTruthy();
    expect(screen.getByText('mcp:sage')).toBeTruthy();

    fireEvent.click(screen.getByText('Messages'));
    expect(screen.getByText('File outputs')).toBeTruthy();
    expect(screen.getByText('Tool inputs')).toBeTruthy();
    expect(screen.getByText('Text')).toBeTruthy();

    // Section names are data labels from the prompt builder, humanized by
    // turning separators into spaces — not title-cased.
    fireEvent.click(screen.getByText('System Prompt'));
    expect(screen.getByText('skills')).toBeTruthy();
    expect(screen.getByText('project instructions')).toBeTruthy();

    // Clicking the open section again collapses it.
    fireEvent.click(screen.getByText('System Prompt'));
    expect(screen.queryByText('skills')).toBeNull();
  });

  it('marks the price cliff and the trigger the ladder actually uses', () => {
    render(<ContextXRay xray={fixture() as never} cliff={cliff as never} maxContext={ONE_M} />);

    expect(screen.getByText(/Price cliff at 200k tokens/)).toBeTruthy();
    // The whole point: the trigger moved from ~691k (window) to 190k (cliff).
    expect(screen.getByText(/Compaction fires at 190k \(window-only: 691k\)/)).toBeTruthy();
  });

  it('still renders the breakdown when no cliff applies', () => {
    render(<ContextXRay xray={fixture() as never} maxContext={ONE_M} />);
    expect(screen.queryByText(/Price cliff/)).toBeNull();
    expect(screen.getByText('System Prompt')).toBeTruthy();
  });
});
