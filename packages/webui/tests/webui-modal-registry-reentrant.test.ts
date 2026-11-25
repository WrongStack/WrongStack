import { describe, expect, it } from 'vitest';
import {
  registerOpenModal,
  resetOpenModalRegistryForTests,
  subscribeToOpenModals,
} from '../src/lib/open-modal-registry';

describe('open-modal-registry re-entrant subscribe guard (F2302)', () => {
  it('does not notify listeners added during an active modal transition', () => {
    resetOpenModalRegistryForTests();
    let lateCalled = false;
    subscribeToOpenModals(() => {
      subscribeToOpenModals(() => {
        lateCalled = true;
      });
    });
    registerOpenModal('m1');
    resetOpenModalRegistryForTests();
    expect(lateCalled).toBe(false);
  });
});
