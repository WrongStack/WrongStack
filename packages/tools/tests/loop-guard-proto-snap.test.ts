import { describe, expect, it } from 'vitest';
import { createContinuationAttemptTracker } from '../src/auto-proceed-loop-guard.js';

describe('createContinuationAttemptTracker snapshot proto key (F2003)', () => {
  it('preserves __proto__ todo IDs as own enumerable snapshot keys', () => {
    const tracker = createContinuationAttemptTracker();
    tracker.recordAttempt('todo-1');
    tracker.recordAttempt('__proto__');
    const snap = tracker.snapshot();
    expect(Object.hasOwn(snap, '__proto__')).toBe(true);
    expect(
      (Object.getOwnPropertyDescriptor(snap, '__proto__')?.value as { attempts: number })?.attempts,
    ).toBe(1);
  });
});
