import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { SidebarPanelCard } from '../src/components/sidebar-panel-frame.js';
import { Box, Text } from '../src/ink.js';
import { displayWidth } from '../src/terminal-width.js';
import { theme } from '../src/theme.js';

describe('Card frame integrity', () => {
  it('keeps the right │ bar in place when a child Text is too long', () => {
    // Even if a caller forgets `wrap="truncate"`, the Card walks the body
    // and forces every <Text> descendant to truncate. The right `│` bar
    // must always sit at the right edge of the card, never stranded off
    // the frame.
    const { lastFrame } = render(
      <Box width={28}>
        <SidebarPanelCard innerWidth={28} accent={theme.accent}>
          {() => (
            <>
              <Text>
                this is a very long unwrapped string that would normally wrap and break the frame
              </Text>
              <Text>short row</Text>
            </>
          )}
        </SidebarPanelCard>
      </Box>,
    );
    const lines = (lastFrame() ?? '').split('\n');
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(28);
    }
    // At least one body row should have BOTH side bars (the truncated long
    // text). The right `│` is the proof that the frame isn't broken.
    expect(lines.some((l) => l.startsWith('│') && l.endsWith('│'))).toBe(true);
  });

  it('preserves the frame on narrow rails where sides are off', () => {
    // On rails narrower than 18 cols the Card drops side bars entirely —
    // corners are enough. The body must still fit and the corners must
    // still appear.
    const { lastFrame } = render(
      <Box width={16}>
        <SidebarPanelCard innerWidth={16} accent={theme.accent}>
          {() => (
            <>
              <Text>short</Text>
              <Text>a much longer line that would overflow on a narrow rail</Text>
            </>
          )}
        </SidebarPanelCard>
      </Box>,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('╭');
    expect(frame).toContain('╰');
    for (const line of frame.split('\n')) {
      expect(displayWidth(line)).toBeLessThanOrEqual(16);
    }
  });
});
