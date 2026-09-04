export class UserRepo {
  constructor(rows = []) {
    this.rows = rows;
  }
  find(id) {
    return this.rows.find((row) => row.id === id) ?? null;
  }
}
