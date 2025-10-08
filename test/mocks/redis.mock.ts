/**
 * Mock Redis service for integration testing
 */
export class MockRedisService {
  private store: Map<string, { value: string; expiresAt?: number }> = new Map();

  async connect(): Promise<void> {
    // No-op for mock
  }

  async set(key: string, val: string, expire?: number): Promise<void> {
    const expiresAt = expire ? Date.now() + expire * 1000 : undefined;
    this.store.set(key, { value: val, expiresAt });
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;

    // Check if expired
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async ping(): Promise<string> {
    return 'PONG';
  }

  async flushDb(): Promise<void> {
    this.store.clear();
  }

  async disconnect(): Promise<void> {
    this.store.clear();
  }

  // Test helper methods
  getAllKeys(): string[] {
    return Array.from(this.store.keys());
  }

  getStore(): Map<string, { value: string; expiresAt?: number }> {
    return this.store;
  }
}
