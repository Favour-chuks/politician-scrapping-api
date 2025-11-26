import { getValkeyClient } from '../config/valkey.js';

export class ValkeyAdvanced {
  public client = getValkeyClient();

  async hset(key: string, field: string, value: string): Promise<void> {
    await this.client.hset(key, field, value);
  }

  async hmset(key: string, data: Record<string, string>): Promise<void> {
    await this.client.hmset(key, data);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return await this.client.hget(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return await this.client.hgetall(key);
  }

  async hmget(key: string, fields: string[]): Promise<(string | null)[]> {
    return await this.client.hmget(key, ...fields);
  }

  async hdel(key: string, field: string): Promise<boolean> {
    const result = await this.client.hdel(key, field);
    return result === 1;
  }

  async hexists(key: string, field: string): Promise<boolean> {
    const result = await this.client.hexists(key, field);
    return result === 1;
  }

  async hkeys(key: string): Promise<string[]> {
    return await this.client.hkeys(key);
  }

  async hincrby(key: string, field: string, increment: number): Promise<number> {
    return await this.client.hincrby(key, field, increment);
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    return await this.client.rpush(key, ...values);
  }

  async lpush(key: string, ...values: string[]): Promise<number> {
    return await this.client.lpush(key, ...values);
  }

  async rpop(key: string): Promise<string | null> {
    return await this.client.rpop(key);
  }

  async lpop(key: string): Promise<string | null> {
    return await this.client.lpop(key);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return await this.client.lrange(key, start, stop);
  }

  async lgetall(key: string): Promise<string[]> {
    return await this.lrange(key, 0, -1);
  }

  async llen(key: string): Promise<number> {
    return await this.client.llen(key);
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    await this.client.ltrim(key, start, stop);
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    return await this.client.sadd(key, ...members);
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    return await this.client.srem(key, ...members);
  }

  async sismember(key: string, member: string): Promise<boolean> {
    const result = await this.client.sismember(key, member);
    return result === 1;
  }

  async smembers(key: string): Promise<string[]> {
    return await this.client.smembers(key);
  }

  async scard(key: string): Promise<number> {
    return await this.client.scard(key);
  }

  async srandmember(key: string, count?: number): Promise<string | string[]> {
     if (count) {
    return await this.client.srandmember(key, count);
  }
  const result = await this.client.srandmember(key);
  return result ?? '';
  }

  
  async spop(key: string): Promise<string | null> {
    return await this.client.spop(key);
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    return await this.client.zadd(key, score, member);
  }

  async zaddMultiple(
    key: string,
    members: Array<{ score: number; member: string }>
  ): Promise<number> {
    const args: (number | string)[] = [];
    members.forEach(({ score, member }) => {
      args.push(score, member);
    });
    return await this.client.zadd(key, ...args);
  }

  async zrange(key: string, start: number, stop: number, withScores: boolean = false): Promise<string[]> {
    if (withScores) {
      return await this.client.zrange(key, start, stop, 'WITHSCORES');
    }
    return await this.client.zrange(key, start, stop);
  }

  async zrevrange(key: string, start: number, stop: number, withScores: boolean = false): Promise<string[]> {
    if (withScores) {
      return await this.client.zrevrange(key, start, stop, 'WITHSCORES');
    }
    return await this.client.zrevrange(key, start, stop);
  }

  async zrank(key: string, member: string): Promise<number | null> {
    return await this.client.zrank(key, member);
  }

  async zscore(key: string, member: string): Promise<string | null> {
    return await this.client.zscore(key, member);
  }

  async zincrby(key: string, increment: number, member: string): Promise<string> {
    return await this.client.zincrby(key, increment, member);
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    return await this.client.zrem(key, ...members);
  }

  async zcard(key: string): Promise<number> {
    return await this.client.zcard(key);
  }

  async getTopN(key: string, n: number): Promise<Array<{ member: string; score: number }>> {
    const results = await this.zrevrange(key, 0, n - 1, true);
    
    if(!results) {
      throw new Error("No results found in sorted set")
    }
    
    const leaderboard: Array<{ member: any; score: any }> = [];
    for (let i = 0; i < results.length; i += 2) {
     let member = results[i];
     let score = results[i + 1];
     if(!member || !score) {
       throw new Error("Invalid member or score in sorted set results")
     }
     leaderboard.push({
        member: member,
        score: parseFloat(score)
      });
    }
    
    return leaderboard;
  }


  async trackWrite(key: string, operation: string): Promise<void> {
  const writeLog = 'system:write-log';
  const timestamp = Date.now();
  
  const entry = JSON.stringify({
    key,
    operation,
  });
  
  // Add to sorted set with timestamp as score
  await this.client.zadd(writeLog, timestamp, entry);
  
  // Keep only last 1000 entries to prevent memory issues
  await this.client.zremrangebyrank(writeLog, 0, -1001);
}

  async getLastWrites(n: number = 10): Promise<Array<{
   key: string;
   operation: string;
   timestamp: number;
   timestampISO: string;
 }>> {
   const writeLog = 'system:write-log';
   
   const entries = await this.client.zrevrange(writeLog, 0, n - 1, 'WITHSCORES');
   
   const writes: Array<{
     key: string;
     operation: string;
     timestamp: number;
     timestampISO: string;
   }> = [];
   
   for (let i = 0; i < entries.length; i += 2) {
     const data = entries[i];
     const timestamp = parseFloat(entries[i + 1] || '0');
     
     if (data) {
       try {
         const parsed = JSON.parse(data);
         writes.push({
           key: parsed.key,
           operation: parsed.operation,
           timestamp,
           timestampISO: new Date(timestamp).toISOString()
         });
       } catch (error) {
         throw error;
       }
     }
   }
   
   return writes;
 }

 async getWriteStats(minutesAgo: number = 60): Promise<{
   totalWrites: number;
   operationBreakdown: Record<string, number>;
   topKeys: Array<{ key: string; count: number }>;
 }> {
   const writeLog = 'system:write-log';
   const cutoffTime = Date.now() - (minutesAgo * 60 * 1000);
   
   const entries = await this.client.zrangebyscore(writeLog, cutoffTime, '+inf', 'WITHSCORES');
   
   const operationCounts: Record<string, number> = {};
   const keyCounts: Record<string, number> = {};
   
   for (let i = 0; i < entries.length; i += 2) {
     const data = entries[i];
     
     if (data) {
       try {
         const parsed = JSON.parse(data);
         
         operationCounts[parsed.operation] = (operationCounts[parsed.operation] || 0) + 1;
         
         keyCounts[parsed.key] = (keyCounts[parsed.key] || 0) + 1;
       } catch (error) {
        throw error
       }
     }
   }
   
   const topKeys = Object.entries(keyCounts)
     .sort((a, b) => b[1] - a[1])
     .slice(0, 10)
     .map(([key, count]) => ({ key, count }));
   
   return {
     totalWrites: entries.length / 2,
     operationBreakdown: operationCounts,
     topKeys
   };
 }
}

export default ValkeyAdvanced;