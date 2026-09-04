export class TokenBucket {
  constructor({ capacity }) {
    this.capacity = capacity;
    this.tokens = 0;
  }
  tryRemove() {
    return true;
  }
  available() {
    return this.tokens;
  }
}
