export class CommandCache {
  constructor(limit = 500) {
    this.limit = limit;
    this.entries = new Map();
  }

  run(key, operation) {
    let pending = this.entries.get(key);
    if (pending) return pending;
    pending = Promise.resolve().then(operation);
    this.entries.set(key, pending);
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);
    return pending;
  }
}
