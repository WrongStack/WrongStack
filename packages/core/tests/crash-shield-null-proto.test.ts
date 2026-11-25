import { describe, expect, it } from 'vitest';
import { installCrashShield } from '../src/utils/crash-shield.js';

describe('installCrashShield (F2209)', () => {
  it('reports null-prototype rejection reasons instead of silently dropping the log', () => {
    const handlers = new Map<string, (r: unknown) => void>();
    const writes: string[] = [];
    const uninstall = installCrashShield({
      target: {
        on(ev, fn) {
          handlers.set(ev, fn);
        },
        off(ev) {
          handlers.delete(ev);
        },
      },
      write(s) {
        writes.push(s);
      },
      exit() {},
    });

    handlers.get('unhandledRejection')?.(Object.create(null));
    uninstall();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('[unprintable error]');
  });
});
