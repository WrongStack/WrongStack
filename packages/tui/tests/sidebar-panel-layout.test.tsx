import { describe, expect, it } from 'vitest';
import { resolveSidebarLayout } from '../src/app-ui-state.js';
import { FleetPanelSidebar } from '../src/components/sidebar-panels.js';
import { RightSidebar } from '../src/components/sidebar.js';
import { Box, Text } from '../src/ink.js';
import { displayWidth } from '../src/terminal-width.js';
import { createTestState } from './helpers/create-test-state.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

describe('routed sidebar panel layout', () => {
  it(
    'keeps a nested panel visible without widening or vertically shifting the terminal row',
    { timeout: 5_000 },
    async () => {
      const columns = 80;
      const rows = 24;
      const state = createTestState({ monitorOpen: true });
      const { sidebarWidth, sidebarContentWidth, mainColumnWidth, overlayOpen } =
        resolveSidebarLayout(state, columns, { fleet: 'sidebar' }, false);

      expect(overlayOpen).toBe(false);
      expect(sidebarWidth).toBe(20);
      expect(sidebarContentWidth).toBe(16);
      expect(mainColumnWidth).toBe(60);
      const view = renderRealTty(
        <Box flexDirection="row" width={columns} height={rows} overflowX="hidden">
          <Box width={mainColumnWidth} height={rows} flexShrink={0}>
            <Text>{'M'.repeat(mainColumnWidth)}</Text>
          </Box>
          <RightSidebar width={sidebarWidth} maxHeight={rows}>
            <FleetPanelSidebar
              entries={{}}
              runningCount={0}
              width={sidebarContentWidth}
            />
          </RightSidebar>
        </Box>,
        { columns, rows },
      );

      await settle();
      const frame = view.lastFrame();
      expect(frame).toContain('AGENT SWA');
      expect(view.lines().length).toBeLessThanOrEqual(rows);
      for (const line of view.lines()) {
        expect(displayWidth(line)).toBeLessThanOrEqual(columns);
      }
      view.unmount();
    },
  );
});
