import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePagination } from '../../src/hooks/usePagination';

describe('usePagination', () => {
  it('returns the requested page and clamps when the collection shrinks', () => {
    const { result, rerender } = renderHook(({ items }) => usePagination(items, 3), {
      initialProps: { items: [1, 2, 3, 4, 5, 6, 7] },
    });

    act(() => result.current.setPage(3));
    expect(result.current.pageItems).toEqual([7]);

    rerender({ items: [1, 2, 3, 4] });
    expect(result.current.page).toBe(2);
    expect(result.current.pageItems).toEqual([4]);
  });

  it('returns to the first page when the reset key changes', () => {
    const { result, rerender } = renderHook(
      ({ query }) => usePagination([1, 2, 3, 4, 5], 2, query),
      { initialProps: { query: 'first' } },
    );

    act(() => result.current.setPage(2));
    rerender({ query: 'second' });
    expect(result.current.page).toBe(1);
    expect(result.current.pageItems).toEqual([1, 2]);
  });
});
