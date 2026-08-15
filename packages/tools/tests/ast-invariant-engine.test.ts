import { describe, expect, it } from 'vitest';
import { polyglotInvariantEngine } from '../src/codebase-index/ast-invariant-engine.js';

describe('PolyglotInvariantEngine (AST Invariant Engine)', () => {
  const engine = polyglotInvariantEngine;

  describe('TypeScript & JavaScript Invariants', () => {
    it('INV-001: detects deleted or renamed exported symbols', async () => {
      const orig = `
export function processOrder(id: string) { return true; }
export class OrderService {}
export interface OrderConfig { timeout: number; }
`;
      const mod = `
export function processOrder(id: string) { return true; }
// OrderService and OrderConfig deleted!
`;
      const res = await engine.evaluate({ originalCode: orig, modifiedCode: mod, lang: 'ts' });
      expect(res.valid).toBe(false);
      expect(
        res.violations.some((v) => v.ruleId === 'INV-001' && v.symbolName === 'OrderService'),
      ).toBe(true);
      expect(
        res.violations.some((v) => v.ruleId === 'INV-001' && v.symbolName === 'OrderConfig'),
      ).toBe(true);
    });

    it('INV-002: rejects adding mandatory parameters to existing functions', async () => {
      const orig = `
export function calculateTotal(items: number[]): number {
  return items.reduce((a, b) => a + b, 0);
}
`;
      const mod = `
export function calculateTotal(items: number[], currency: string): number {
  return items.reduce((a, b) => a + b, 0);
}
`;
      const res = await engine.evaluate({ originalCode: orig, modifiedCode: mod, lang: 'ts' });
      expect(res.valid).toBe(false);
      expect(res.violations).toHaveLength(1);
      expect(res.violations[0]?.ruleId).toBe('INV-002');
      expect(res.violations[0]?.symbolName).toBe('calculateTotal');
      expect(res.violations[0]?.message).toContain('calculateTotal');
      expect(res.violations[0]?.details?.addedParameter).toBe('currency');
    });

    it('INV-002: allows adding optional or defaulted parameters in TypeScript', async () => {
      const orig = `
export function calculateTotal(items: number[]): number {
  return items.reduce((a, b) => a + b, 0);
}
`;
      const mod = `
export function calculateTotal(items: number[], currency?: string, discount: number = 0, ...tags: string[]): number {
  return items.reduce((a, b) => a + b, 0);
}
`;
      const res = await engine.evaluate({ originalCode: orig, modifiedCode: mod, lang: 'ts' });
      expect(res.valid).toBe(true);
      expect(res.violations).toHaveLength(0);
    });

    it('INV-003: rejects adding mandatory fields to interfaces and type aliases', async () => {
      const orig = `
export interface UserPayload {
  id: string;
  name: string;
}

export type AuthToken = {
  token: string;
};
`;
      const mod = `
export interface UserPayload {
  id: string;
  name: string;
  email: string; // Mandatory!
}

export type AuthToken = {
  token: string;
  expiresAt: number; // Mandatory!
};
`;
      const res = await engine.evaluate({ originalCode: orig, modifiedCode: mod, lang: 'ts' });
      expect(res.valid).toBe(false);
      expect(
        res.violations.some((v) => v.ruleId === 'INV-003' && v.symbolName === 'UserPayload.email'),
      ).toBe(true);
      expect(
        res.violations.some(
          (v) => v.ruleId === 'INV-003' && v.symbolName === 'AuthToken.expiresAt',
        ),
      ).toBe(true);
    });

    it('INV-003: allows adding optional fields to interfaces and type aliases', async () => {
      const orig = `
export interface UserPayload {
  id: string;
  name: string;
}
`;
      const mod = `
export interface UserPayload {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
}
`;
      const res = await engine.evaluate({ originalCode: orig, modifiedCode: mod, lang: 'ts' });
      expect(res.valid).toBe(true);
      expect(res.violations).toHaveLength(0);
    });

    it('INV-004: detects breaking async / return type alterations', async () => {
      const orig = `
export async function fetchData(): Promise<string[]> {
  return ["a", "b"];
}
`;
      const mod = `
export function fetchData(): string[] {
  return ["a", "b"];
}
`;
      const res = await engine.evaluate({ originalCode: orig, modifiedCode: mod, lang: 'ts' });
      expect(res.valid).toBe(false);
      expect(
        res.violations.some((v) => v.ruleId === 'INV-004' && v.symbolName === 'fetchData'),
      ).toBe(true);
    });
  });

  describe('Python Polyglot Invariants', () => {
    it('INV-001: detects deleted public functions in Python', async () => {
      const orig = `
def public_api():
    return 42

def _internal_helper():
    return 1
`;
      const mod = `
def _internal_helper():
    return 1
`;
      const res = await engine.evaluate({ originalCode: orig, modifiedCode: mod, lang: 'py' });
      expect(res.valid).toBe(false);
      expect(
        res.violations.some((v) => v.ruleId === 'INV-001' && v.symbolName === 'public_api'),
      ).toBe(true);
      // _internal_helper is not exported public API, so not reported as breaking export
      expect(res.violations.some((v) => v.symbolName === '_internal_helper')).toBe(false);
    });

    it('INV-002: rejects adding mandatory positional parameters in Python', async () => {
      const orig = `
def process_data(data, format="json"):
    return data
`;
      const mod = `
def process_data(data, user_id, format="json"):
    return data
`;
      const res = await engine.evaluate({ originalCode: orig, modifiedCode: mod, lang: 'py' });
      expect(res.valid).toBe(false);
      expect(
        res.violations.some((v) => v.ruleId === 'INV-002' && v.symbolName === 'process_data'),
      ).toBe(true);
    });

    it('INV-002: allows adding default/keyword arguments or *args in Python', async () => {
      const orig = `
def process_data(data, format="json"):
    return data
`;
      const mod = `
def process_data(data, format="json", timeout=30, *extra_args):
    return data
`;
      const res = await engine.evaluate({ originalCode: orig, modifiedCode: mod, lang: 'py' });
      expect(res.valid).toBe(true);
      expect(res.violations).toHaveLength(0);
    });
  });

  describe('Go Polyglot Invariants', () => {
    it('INV-001: detects deleted exported Go functions', async () => {
      const orig = `
package service

func HandleRequest(r *Request) error {
    return nil
}

func privateHelper() {
}
`;
      const mod = `
package service

func privateHelper() {
}
`;
      const res = await engine.evaluate({ originalCode: orig, modifiedCode: mod, lang: 'go' });
      expect(res.valid).toBe(false);
      expect(
        res.violations.some((v) => v.ruleId === 'INV-001' && v.symbolName === 'HandleRequest'),
      ).toBe(true);
      expect(res.violations.some((v) => v.symbolName === 'privateHelper')).toBe(false);
    });

    it('INV-002: rejects adding parameters to Go functions because Go lacks optional/default params', async () => {
      const orig = `
package service

func Calculate(a int, b int) int {
    return a + b
}
`;
      const mod = `
package service

func Calculate(a int, b int, c int) int {
    return a + b + c
}
`;
      const res = await engine.evaluate({ originalCode: orig, modifiedCode: mod, lang: 'go' });
      expect(res.valid).toBe(false);
      expect(
        res.violations.some((v) => v.ruleId === 'INV-002' && v.symbolName === 'Calculate'),
      ).toBe(true);
    });

    it('INV-003: rejects adding new methods to Go interfaces', async () => {
      const orig = `
package service

type Reader interface {
    Read(p []byte) (n int, err error)
}
`;
      const mod = `
package service

type Reader interface {
    Read(p []byte) (n int, err error)
    Close() error
}
`;
      const res = await engine.evaluate({ originalCode: orig, modifiedCode: mod, lang: 'go' });
      expect(res.valid).toBe(false);
      expect(
        res.violations.some((v) => v.ruleId === 'INV-003' && v.symbolName.includes('Close')),
      ).toBe(true);
    });
  });

  describe('Rust Polyglot Invariants', () => {
    it('INV-001: detects deleted pub fn in Rust', async () => {
      const orig = `
pub fn fetch_user(id: u64) -> Option<User> {
    None
}

fn internal_compute() {}
`;
      const mod = `
fn internal_compute() {}
`;
      const res = await engine.evaluate({ originalCode: orig, modifiedCode: mod, lang: 'rs' });
      expect(res.valid).toBe(false);
      expect(
        res.violations.some((v) => v.ruleId === 'INV-001' && v.symbolName === 'fetch_user'),
      ).toBe(true);
    });

    it('INV-002: rejects modifying pub fn parameter count in Rust', async () => {
      const orig = `
pub fn connect(host: &str) -> Connection {
    Connection::new(host)
}
`;
      const mod = `
pub fn connect(host: &str, port: u16) -> Connection {
    Connection::new_with_port(host, port)
}
`;
      const res = await engine.evaluate({ originalCode: orig, modifiedCode: mod, lang: 'rs' });
      expect(res.valid).toBe(false);
      expect(res.violations.some((v) => v.ruleId === 'INV-002' && v.symbolName === 'connect')).toBe(
        true,
      );
    });
  });

  describe('Non-Breaking Safe Refactoring', () => {
    it('passes when internal function body changes without modifying signatures', async () => {
      const orig = `
export function add(a: number, b: number): number {
  return a + b;
}
`;
      const mod = `
export function add(a: number, b: number): number {
  // Optimized implementation
  const res = a + b;
  return res;
}
`;
      const res = await engine.evaluate({ originalCode: orig, modifiedCode: mod, lang: 'ts' });
      expect(res.valid).toBe(true);
      expect(res.violations).toHaveLength(0);
    });

    it('passes when new exported functions or classes are added', async () => {
      const orig = `
export function existingFunc(a: string): string {
  return a;
}
`;
      const mod = `
export function existingFunc(a: string): string {
  return a;
}

export function newAwesomeFeature(): boolean {
  return true;
}
`;
      const res = await engine.evaluate({ originalCode: orig, modifiedCode: mod, lang: 'ts' });
      expect(res.valid).toBe(true);
      expect(res.violations).toHaveLength(0);
    });
  });
});
