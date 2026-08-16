export class SerialKeyedWorkQueue {
  private readonly pending = new Set<string>();
  private tail: Promise<void> = Promise.resolve();

  enqueue(key: string, work: () => Promise<void>): boolean {
    if (this.pending.has(key)) return false;
    this.pending.add(key);
    this.tail = this.tail
      .catch(() => undefined)
      .then(work)
      .finally(() => { this.pending.delete(key); });
    return true;
  }

  has(key: string): boolean {
    return this.pending.has(key);
  }
}