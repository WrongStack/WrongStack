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
// (URL, detail, IPC rows, status glyph on the URL row) where
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
  it('renders the URL, healthy glyph, and WrongTrace IPC rows when the health body reports a socket path', () => {
    const { lastFrame } = mount({
      url: 'http://localhost:3444',
      status: 'ok',
      latencyMs: 23,
      socketPath: '\\\\.\\pipe\\wrongtrace',
      version: '0.3.3',
    });
    const frame = lastFrame();
    expect(frame).toContain('WRONGPROXY');
    expect(frame).toContain('http://localhost:3444');
    // Healthy glyph is rendered on the URL row prefix — independent
    // of the title-row pill truncation, so the assertion is stable.
    expect(frame).toContain('✓');
    // WrongTrace IPC info sourced from the /api/health body. The row
    // labels carry the `·` rail so the asserts don't collide with the
    // ever-present "proxy daemon" kicker text.
    expect(frame).toContain('· ipc');
    expect(frame).toContain('wrongtrace');
    expect(frame).toContain('· daemon');
    expect(frame).toContain('0.3.3');
  });

  it('omits the IPC rows entirely for an HTTP-only daemon (no socket_path in the health body)', () => {
    const { lastFrame } = mount({
      url: 'http://localhost:3444',
      status: 'ok',
      latencyMs: 12,
      // No socketPath / version — an HTTP-only daemon keeps the card
      // at its minimal height with no filler rows.
    });
    const frame = lastFrame();
    expect(frame).toContain('http://localhost:3444');
    expect(frame).not.toContain('· ipc');
    expect(frame).not.toContain('· daemon');
  });

  it('renders the unreachable detail and the failure glyph when the daemon is offline', () => {
    const { lastFrame } = mount({
      url: 'http://localhost:3444',
      status: 'down',
      latencyMs: 2003,
      detail: 'ECONNREFUSED',
    });
    const frame = lastFrame();
    expect(frame).toContain('WRONGPROXY');
    // Failure glyph on the URL row prefix — a stable signal that
    // survives pill/title-row truncation because it lives in the body.
    expect(frame).toContain('×');
    // `proxy.detail` is appended under the URL row; mirrors the
    // Connections panel's per-service `detail` line shape.
    expect(frame).toContain('ECONNREFUSED');
    // A down daemon reported no IPC metadata, so no IPC rows.
    expect(frame).not.toContain('ipc');
  });

  it('renders an idle twin (no latency, no IPC rows) when proxy is null', () => {
    const { lastFrame } = mount(null);
    const frame = lastFrame();
    expect(frame).toContain('WRONGPROXY');
    // No latency when no probe has run — the panel falls back to a
    // muted "?" pill so a mount/unmount race during a settings toggle
    // never flashes an inconsistent state.
    expect(frame).not.toContain('ms');
    expect(frame).not.toContain('ipc');
  });
});
