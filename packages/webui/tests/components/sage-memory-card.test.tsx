import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SageMemoryCard } from '../../src/components/SageMemoryCard.js';

const SAGE_LINES = [
  '--- SAGE: related project knowledge (Memory Injector) ---',
  '- [fact] <memory id="mem-1">remembered fact</memory> [tags=test]',
  '- [decision][high] <memory id="mem-2">another memory</memory>',
];

describe('<SageMemoryCard />', () => {
  it('renders nothing when sageLines is empty', () => {
    const { container } = render(<SageMemoryCard sageLines={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when sageLines contains only the header', () => {
    const { container } = render(
      <SageMemoryCard sageLines={[SAGE_LINES[0]!]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a separate bordered card for the SAGE block', () => {
    render(<SageMemoryCard sageLines={SAGE_LINES} toolName="glob" />);
    expect(screen.getByTestId('sage-memory-card')).toBeTruthy();
  });

  it('header carries the tool name and the memory count', () => {
    render(<SageMemoryCard sageLines={SAGE_LINES} toolName="glob" />);
    const header = screen.getByTestId('sage-memory-header');
    expect(header.textContent).toContain('SAGE Memory Injected');
    expect(header.textContent).toContain('glob');
    // Two memory lines → plural count label.
    expect(screen.getByText('2 memories')).toBeTruthy();
  });

  it('uses the singular "memory" label for a single injection', () => {
    const singleLine = [SAGE_LINES[0]!, SAGE_LINES[1]!];
    render(<SageMemoryCard sageLines={singleLine} toolName="read" />);
    expect(screen.getByText('1 memory')).toBeTruthy();
  });

  it('renders every memory line in its own list row', () => {
    render(<SageMemoryCard sageLines={SAGE_LINES} toolName="grep" />);
    const lines = screen.getAllByTestId('sage-memory-line');
    expect(lines).toHaveLength(2);
    expect(lines[0]?.textContent).toContain('remembered fact');
    expect(lines[1]?.textContent).toContain('another memory');
  });

  it('omits the tool-name suffix when toolName is not provided', () => {
    render(<SageMemoryCard sageLines={SAGE_LINES} />);
    const header = screen.getByTestId('sage-memory-header');
    expect(header.textContent).toContain('SAGE Memory Injected');
    expect(header.textContent?.includes('· ')).toBe(false);
  });
});