import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FRACTION_DIGITS } from './src/contract.js';
import { formatCents } from './src/money.js';

// CORE_SENTINEL_frozen-contract

assert.equal(FRACTION_DIGITS, 2);
assert.equal(formatCents(150), '1.50');
assert.equal(formatCents(1), '0.01');
assert.equal(formatCents(0), '0.00');
assert.equal(formatCents(-20), '-0.20');
assert.equal(formatCents(99), '0.99');

const contractSrc = readFileSync(new URL('./src/contract.js', import.meta.url), 'utf8');
assert.match(contractSrc, /CORE_CONTRACT_FROZEN/);
assert.match(contractSrc, /export const FRACTION_DIGITS = 2;/);
