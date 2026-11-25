import { describe, expect, it } from 'vitest';
import { addFatalSalvageHook, runFatalSalvageSync } from '../src/utils/crash-shield.js';

describe('addFatalSalvageHook idempotent unregister', () => {
  it('does not remove a second registration when the first unregister is called twice', () => {
    let ran = 0;
    const hook = () => {
      ran += 1;
    };
    const off1 = addFatalSalvageHook(hook);
    const off2 = addFatalSalvageHook(hook);
    off1();
    off1();
    runFatalSalvageSync();
    expect(ran).toBe(1);
    off2();
    runFatalSalvageSync();
    expect(ran).toBe(1);
  });
});
