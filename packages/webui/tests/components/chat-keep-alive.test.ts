import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Chat must never be unmounted.
 *
 * The transcript is virtualized and owns state that cannot be rebuilt for
 * free: row measurements, the scroll offset, an unsent composer draft with
 * its staged attachments, and the live stream target. Gating it behind
 * `currentView === 'chat' && …` (or swapping it out for a subagent tab) threw
 * all of that away, so every return to chat paid a full re-render and landed
 * in the wrong place.
 *
 * These are SOURCE invariants rather than render assertions on purpose:
 * mounting the real ChatView needs a mock surface large enough that the test
 * would pin the mocks, not the behaviour — while the regression this guards
 * against is a one-line edit to the JSX that a source check catches exactly.
 * The runtime half (a parked view keeps its box so the virtualizer does not
 * re-measure) lives in the `.ws-view-parked` rule, asserted below.
 */

const SRC = path.resolve(__dirname, '../../src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('chat keep-alive', () => {
  it('ViewRouter never gates ChatView behind the active view', () => {
    const src = read('components/ViewRouter.tsx');

    expect(src).toContain('<ChatView />');
    // The exact shape of the regression: a conditional render of the chat
    // branch. Other views may (and should) stay conditional.
    expect(src).not.toMatch(/currentView === 'chat' &&\s*\(?\s*<>/);
    expect(src).not.toMatch(/currentView === 'chat' &&\s*<ChatView/);
    // Instead it is always mounted and parked when another view is in front.
    expect(src).toMatch(/currentView !== 'chat' && 'ws-view-parked'/);
    expect(src).toMatch(/currentView !== 'chat' \? \{ inert: true/);
  });

  it('keeps the session dock and AGENTS strip mounted, parked outside chat', () => {
    const src = read('components/ViewRouter.tsx');
    const dockIndex = src.indexOf('<WorkspaceDock />');
    const agentTabsIndex = src.indexOf('<AgentTabs />');
    const chatParkIndex = src.indexOf("currentView !== 'chat' && 'ws-view-parked'");
    const chatViewIndex = src.indexOf('<ChatView />');

    expect(dockIndex).toBeGreaterThan(-1);
    expect(agentTabsIndex).toBeGreaterThan(-1);
    expect(chatParkIndex).toBeGreaterThan(-1);
    expect(chatViewIndex).toBeGreaterThan(-1);
    // The dock strip and AGENTS switcher belong to the chat surface: they sit
    // INSIDE the parked wrapper so they are simply not displayed on other
    // views, yet stay mounted (subscriptions and state never tear down).
    // They still render above the transcript.
    expect(chatParkIndex).toBeLessThan(dockIndex);
    expect(chatParkIndex).toBeLessThan(agentTabsIndex);
    expect(agentTabsIndex).toBeLessThan(chatViewIndex);
  });

  it('keeps the workspace dock inspector available outside chat', () => {
    const src = read('App.tsx');
    const inspector = src.slice(src.indexOf('<WorkspaceDockInspector') - 220);

    expect(inspector).toContain('{sessionId && (');
    expect(inspector).not.toContain("currentView === 'chat'");
  });

  it('binds the session surface to the active lane pointer, not nullable SessionInfo', () => {
    const src = read('App.tsx');
    const binding = src.slice(
      src.indexOf('const sessionRecordId'),
      src.indexOf('const sideContextBreakdownOpen'),
    );

    expect(binding).toContain('const activeSessionId = useActiveSessionId()');
    expect(binding).toContain('const sessionId = activeSessionId ?? sessionRecordId');
    expect(binding).not.toContain('const sessionId = useSessionStore((s) => s.session?.id)');
  });

  it('ChatView keeps the leader transcript mounted under a subagent tab', () => {
    const src = read('components/ChatView/index.tsx');

    // The leader pane is parked, not swapped out by a ternary.
    expect(src).toMatch(/subagentMode && 'ws-view-parked'/);
    expect(src).not.toMatch(/\{subagentMode \? \(/);
    // The composer too: unmounting it discarded an unsent draft.
    const composer = src.slice(src.indexOf('ws-chat-input-wrap') - 3000);
    expect(composer).not.toMatch(/\{!subagentMode && \(/);
  });

  it('parks views out of flow instead of hiding them, so measurements survive', () => {
    const css = read('index.css');
    const rule = css.slice(css.indexOf('.ws-view-parked'));

    expect(rule).toContain('position: absolute');
    expect(rule).toContain('visibility: hidden');
    expect(rule).toContain('pointer-events: none');
    // `display: none` measures 0x0, which collapses the virtualizer's window
    // and drops scrollTop — the very thing parking exists to avoid.
    expect(rule.slice(0, rule.indexOf('}'))).not.toContain('display: none');
  });

  it('anchors parked views to a positioned container in App', () => {
    const src = read('App.tsx');
    const routerIdx = src.indexOf('<ViewRouter');
    const wrapper = src.slice(Math.max(0, routerIdx - 400), routerIdx);

    // Without a positioning context the parked view would anchor to the
    // viewport and stop matching the work surface it must keep measuring.
    expect(wrapper).toMatch(/className="relative flex min-h-0 min-w-0 flex-1 flex-col"/);
  });

  it('does not force a scroll jump when returning from a subagent tab', () => {
    const src = read('components/ChatView/index.tsx');

    // The old fix-up existed only because the VList remounted at the top.
    // With the pane parked it would yank the reader away from their place.
    expect(src).not.toContain('wasSubagentMode');
  });
});
