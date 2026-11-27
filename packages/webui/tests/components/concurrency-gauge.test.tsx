import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConcurrencyGauge } from '../../src/components/ui/concurrency-gauge';

describe('ConcurrencyGauge accessible name', () => {
  afterEach(cleanup);

  it('exposes the visual bar as a named image alongside its numeric label', () => {
    render(<ConcurrencyGauge current={3} max={4} />);

    expect(screen.getByText('3/4')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Fleet concurrency: 3/4' })).toBeTruthy();
  });

  it('keeps the accessible name when the numeric label is hidden', () => {
    render(<ConcurrencyGauge current={2} max={4} showLabel={false} />);

    expect(screen.queryByText('2/4')).toBeNull();
    expect(screen.getByRole('img', { name: 'Fleet concurrency: 2/4' })).toBeTruthy();
  });
});
