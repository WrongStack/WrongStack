import { describe, expect, it } from 'vitest';
import { RunController } from '../run-controller.js';

const settle = () => new Promise<void>((r) => setImmediate(r));

describe('RunController.onAbort registration-scoped unsubscribe (F2)', () => {
  it('a repeated unsubscribe removes only its own registration, not a sibling sharing the fn', async () => {
    // Same cleanup fn registered twice (e.g. two tools sharing one release
    // callback). Opting out of registration 1 — defensively, twice — must
    // leave registration 2 live so its cleanup still fires on abort.
    const c = new RunController();
    let fires = 0;
    const fn = () => {
      fires++;
    };
    const off1 = c.onAbort(fn);
    c.onAbort(fn);
    off1();
    off1();
    c.abort();
    await settle();
    expect(fires).toBe(1);
  });

  it('opting out of both duplicate registrations fires nothing', async () => {
    const c = new RunController();
    let fires = 0;
    const fn = () => {
      fires++;
    };
    const off1 = c.onAbort(fn);
    const off2 = c.onAbort(fn);
    off1();
    off1();
    off2();
    off2();
    c.abort();
    await settle();
    expect(fires).toBe(0);
  });

  it('duplicate registrations without opt-out still fire twice in LIFO order', async () => {
    const c = new RunController();
    const order: string[] = [];
    const fn = () => void order.push('dup');
    c.onAbort(fn);
    c.onAbort(() => void order.push('other'));
    c.onAbort(fn);
    c.abort();
    await settle();
    expect(order).toEqual(['dup', 'other', 'dup']);
  });

  it('repeated unsubscribe of a single registration is a safe no-op', async () => {
    const c = new RunController();
    let fires = 0;
    const off = c.onAbort(() => {
      fires++;
    });
    off();
    off();
    off();
    c.abort();
    await settle();
    expect(fires).toBe(0);
  });

  it('registration-scoped opt-out also holds on the normal dispose path', async () => {
    const c = new RunController();
    let fires = 0;
    const fn = () => {
      fires++;
    };
    const off1 = c.onAbort(fn);
    c.onAbort(fn);
    off1();
    off1();
    await c.dispose();
    await settle();
    expect(fires).toBe(1);
  });
});
