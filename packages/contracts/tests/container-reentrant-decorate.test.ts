import { describe, expect, it } from 'vitest';
import { Container, type Token } from '../src/kernel/container.js';

describe('Container.resolve (F2220)', () => {
  it('snapshots decorators before iterating so reentrant decorate does not run mid-resolve', () => {
    const c = new Container();
    const T = Symbol('svc') as Token<string>;
    c.bind(T, () => 'base');
    let secondRan = false;
    c.decorate(T, (inner, container) => {
      container.decorate(T, (v) => {
        secondRan = true;
        return `${v}+late`;
      });
      return `${inner}+first`;
    });

    expect(c.resolve(T)).toBe('base+first');
    expect(secondRan).toBe(false);
  });
});
