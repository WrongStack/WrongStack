import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { markdownComponents } from '../../src/components/MessageBubble/utils';

describe('markdownComponents table renderer', () => {
  it('wraps table inside an overflow-x-auto container', () => {
    const TableComp = markdownComponents.table;
    const TheadComp = markdownComponents.thead;
    const TbodyComp = markdownComponents.tbody;
    const TrComp = markdownComponents.tr;
    const ThComp = markdownComponents.th;
    const TdComp = markdownComponents.td;

    const { container } = render(
      <TableComp>
        <TheadComp>
          <TrComp>
            <ThComp>Header 1</ThComp>
            <ThComp>Header 2</ThComp>
          </TrComp>
        </TheadComp>
        <TbodyComp>
          <TrComp>
            <TdComp>Data 1</TdComp>
            <TdComp>Data 2</TdComp>
          </TrComp>
        </TbodyComp>
      </TableComp>,
    );

    const wrapper = container.querySelector('.overflow-x-auto');
    expect(wrapper).toBeTruthy();
    expect(screen.getByText('Header 1')).toBeDefined();
    expect(screen.getByText('Data 1')).toBeDefined();
  });
});
