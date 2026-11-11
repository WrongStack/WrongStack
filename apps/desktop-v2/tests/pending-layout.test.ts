// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  acknowledgePendingLayout,
  pendingLayoutValue,
  stagePendingLayout,
} from '../src/pending-layout';

describe('window-local unacknowledged layout recovery', () => {
  afterEach(() => sessionStorage.clear());

  it('keeps a later A → B → A change when the first A is acknowledged', () => {
    const a = JSON.stringify({ selected: 'alpha' });
    const old = stagePendingLayout('layout', a);
    stagePendingLayout('layout', JSON.stringify({ selected: 'beta' }));
    const latest = stagePendingLayout('layout', a);
    acknowledgePendingLayout('layout', old);
    expect(pendingLayoutValue('layout')).toBe(a);
    acknowledgePendingLayout('layout', latest);
    expect(pendingLayoutValue('layout')).toBeNull();
  });

  it('ignores corrupt or non-object recovery values instead of breaking host restoration', () => {
    for (const value of ['{', 'null', '[]', '42']) {
      stagePendingLayout('layout', value);
      expect(pendingLayoutValue('layout')).toBeNull();
    }
    stagePendingLayout('layout', JSON.stringify({ selected: 'alpha' }));
    sessionStorage.setItem(sessionStorage.key(0)!, '{');
    expect(pendingLayoutValue('layout')).toBeNull();
  });
});
