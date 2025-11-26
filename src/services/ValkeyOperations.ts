import { getValkeyClient } from '../config/valkey.js';

export class ValkeyOperations {
  private client = getValkeyClient();

  /**
   * Set a simple key-value pair
   * @param key
   * @param value
   * @param ttl
   */
  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (ttl) {
      await this.client.setex(key, ttl, value);
    } else {
      await this.client.set(key, value);
    }
  }

  async pingValkey(): Promise<string> {
    return await this.client.ping();
  }
  
  async setIfNotExists(key: string, value: string): Promise<boolean> {
    const result = await this.client.setnx(key, value);
    return result === 1;
  }

  async setMultiple(data: Record<string, string>): Promise<void> {
    const pipeline = this.client.pipeline();
    
    Object.entries(data).forEach(([key, value]) => {
      pipeline.set(key, value);
    });
    
    await pipeline.exec();
  }

  async setObject<T>(key: string, obj: T, ttl?: number): Promise<void> {
    const value = JSON.stringify(obj);
    await this.set(key, value, ttl);
  }

  async get(key: string): Promise<string | null> {
    return await this.client.get(key);
  }

  async getMultiple(keys: string[]): Promise<(string | null)[]> {
    return await this.client.mget(...keys);
  }

  async getObject<T>(key: string): Promise<T | null> {
    const value = await this.client.get(key);
    if (!value) return null;
    
    try {
      return JSON.parse(value) as T;
    } catch (error) {
      throw error
    }
  }

  async exists(key: string): Promise<boolean | any> {
    const result = await this.client.exists(key);
    return result === 1;
  }

  async getTTL(key: string): Promise<number> {
    return await this.client.ttl(key);
  }

  /**
   * Find keys by pattern
   * WARNING: Use with caution in production - can be slow
   * @param pattern - Pattern to match (e.g., "user:*", "session:123:*")
   */
  async findKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';

    do {
      const [newCursor, foundKeys] = await this.client.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100
      );
      cursor = newCursor;
      keys.push(...foundKeys);
    } while (cursor !== '0');

    return keys;
  }

  async findAndGetAll(pattern: string): Promise<Record<string, string>> {
    const keys = await this.findKeys(pattern);
    
    if (keys.length === 0) return {};
    
    const values = await this.client.mget(...keys);
    
    const result: Record<string, string> = {};
    keys.forEach((key, index) => {
      if (values[index]) {
        result[key] = values[index]!;
      }
    });
    
    return result;
  }

  async countKeys(pattern: string): Promise<number> {
    const keys = await this.findKeys(pattern);
    return keys.length;
  }

  async delete(key: string): Promise<boolean> {
    const result = await this.client.del(key);
    return result === 1;
  }

  async deleteMultiple(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return await this.client.del(...keys);
  }

  async deleteByPattern(pattern: string): Promise<number> {
    const keys = await this.findKeys(pattern);
    if (keys.length === 0) return 0;
    return await this.deleteMultiple(keys);
  }

  async increment(key: string, by: number = 1): Promise<number> {
    return await this.client.incrby(key, by);
  }

  async decrement(key: string, by: number = 1): Promise<number> {
    return await this.client.decrby(key, by);
  }

  async updateTTL(key: string, ttl: number): Promise<boolean> {
    const result = await this.client.expire(key, ttl);
    return result === 1;
  }

  async removeTTL(key: string): Promise<boolean> {
    const result = await this.client.persist(key);
    return result === 1;
  }

  async getAllKeys(): Promise<string[]> {
    return await this.client.keys('*');
  }

  async flushDatabase(): Promise<void> {
    await this.client.flushdb();
  }

  async getDatabaseSize(): Promise<number> {
    return await this.client.dbsize();
  }
}

export default ValkeyOperations;