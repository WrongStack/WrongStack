import { UserRepo } from './repo.js';

export class BillingService {
  constructor(repo = new UserRepo()) {
    this.repo = repo;
  }
  emailFor(id) {
    return this.repo.find(id)?.email ?? null;
  }
}
