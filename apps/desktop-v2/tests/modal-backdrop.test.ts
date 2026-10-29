import { expect, it } from 'vitest';
import { outsideBox } from '../src/Modal';

it('treats only points beyond the dialog box as the backdrop', () => {
  const box = { left: 100, top: 50, right: 500, bottom: 400 };
  expect(outsideBox(box, 99, 200)).toBe(true);
  expect(outsideBox(box, 300, 401)).toBe(true);
  expect(outsideBox(box, 100, 50)).toBe(false);
  expect(outsideBox(box, 300, 200)).toBe(false);
});
