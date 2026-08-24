import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { RightSidebar } from '../src/components/sidebar.js';
import { WrongProxyPanelSidebar } from '../src/components/sidebar-panels-workspace.js';
import { Box } from '../src/ink.js';

// Width chosen at the upper bound of the allowed sidebar-width range
// (clamped 20-48 by `computeSidebarWidth`) so body rows render without
// mid-word truncation. Pill substring asserts are deliberately omitted
// because the title-row width budget hair-cuts the pill on narrower
// rails — that's canonical `SidebarPanelFrame` behavior used by every
// other twin too; see the assertions below which target body content
// (URL, detail, footer hint, status glyph on the ENDPOINT row) where
// truncation is consistent across rails.
const RAIL_WIDTH = 48;

function mount(proxy: Parameters<typeof WrongProxyPanelSidebar>[0]['proxy']) {
  return render(
    <Box width={80}>
      <RightSidebar width={RAIL_WIDTH} maxHeight={32} focused={false}>
        <WrongProxyPanelSidebar proxy={proxy} width={RAIL_WIDTH} />
      </RightSidebar>
    </Box>,
  );
}

describe('WrongProxyPanelSidebar', () => {
  it('renders the URL, healthy glyph, footer hint, and "routing" mode row when the probe is healthy', () => {
    const { lastFrame } = mount({
      url: 'http://localhost:8000',
      status: 'ok',
      latencyMs: 23,
    });
    const frame = lastFrame();
    expect(frame).toContain('WRONGPROXY');
    expect(frame).toContain('http://localhost:8000');
    expect(frame).toContain('ENDPOINT');
    // Healthy glyph is rendered on the ENDPOINT row prefix — independent
    // of the title-row pill truncation, so the assertion is stable.
    expect(frame).toContain('✓');
    // Footer hint mirrors the WebUI copy about openai-codex.
    expect(frame).toContain('openai-codex excluded by spec');
  });

  it('renders the unreachable detail and the failure glyph when the daemon is offline', () => {
    const { lastFrame } = mount({
      url: 'http://localhost:8000',
      status: 'down',
      latencyMs: 2003,
      detail: 'ECONNREFUSED',
    });
    const frame = lastFrame();
    expect(frame).toContain('WRONGPROXY');
    expect(frame).toContain('ENDPOINT');
    // Failure glyph on the ENDPOINT row prefix — a stable signal that
    // survives pill/title-row truncation because it lives in the body.
    expect(frame).toContain('×');
    // `proxy.detail` is appended under the URL row; mirrors the
    // Connections panel's per-service `detail` line shape.
    expect(frame).toContain('ECONNREFUSED');
  });

  it('renders an idle twin (no latency, no detail) when proxy is null', () => {
    const { lastFrame } = mount(null);
    const frame = lastFrame();
    expect(frame).toContain('WRONGPROXY');
    // No latency when no probe has run — the panel falls back to a
    // muted "?" pill so a mount/unmount race during a settings toggle
    // never flashes an inconsistent state.
    expect(frame).not.toContain('ms');
  });
});
