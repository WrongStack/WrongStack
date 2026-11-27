import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Field } from '../../src/components/chronicle-event-detail.js';

afterEach(cleanup);

describe('Chronicle Field accessible name', () => {
  it('names the input from the visible placeholder text', () => {
    render(
      <Field
        placeholder="Search event evidence"
        value=""
        onChange={() => undefined}
        onEnter={() => undefined}
        icon={<span aria-hidden="true">icon</span>}
      />,
    );

    const input = screen.getByPlaceholderText('Search event evidence');
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(screen.getByRole('textbox', { name: 'Search event evidence' })).toBe(input);
  });
});
