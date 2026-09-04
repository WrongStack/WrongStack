import assert from 'node:assert/strict';
import { AccountRepo, BillingService } from './src/index.js';

// CORE_SENTINEL_cross-file-rename

const repo = new AccountRepo([
  { id: '1', email: 'a@example.com' },
  { id: '2', email: 'b@example.com' },
]);
assert.equal(repo.find('2').email, 'b@example.com');
assert.equal(repo.find('missing'), null);

const billing = new BillingService(repo);
assert.equal(billing.emailFor('1'), 'a@example.com');
assert.equal(new BillingService().emailFor('x'), null);
