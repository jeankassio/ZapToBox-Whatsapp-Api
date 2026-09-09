/** Timer-free TTL/LRU cache. Eviction only drops derived data, never credentials. */
export class BoundedCache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();
  constructor(private readonly maximum: number, private readonly ttlSeconds: number, private readonly now = Date.now) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || ttlSeconds <= 0) throw new Error('Invalid cache limits');
  }
  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= this.now()) return undefined;
    this.entries.set(key, entry);
    return entry.value as T;
  }
  set<T>(key: string, value: T, ttlSeconds = this.ttlSeconds): boolean {
    this.entries.delete(key);
    while (this.entries.size >= this.maximum) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
    return true;
  }
  del(key: string | string[]): number {
    return (Array.isArray(key) ? key : [key]).reduce((count, item) => count + Number(this.entries.delete(item)), 0);
  }
  flushAll(): void { this.entries.clear(); }
  get size(): number { return this.entries.size; }
}
