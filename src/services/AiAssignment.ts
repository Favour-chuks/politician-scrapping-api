import { GoogleGenAI } from '@google/genai';
import { config } from '../config/environmentalVariables.js';
import { tickerExtractor } from '../prompts/tickerExtractor.js';
import { logger } from '../utils/Logger.js';
import ValkeyOperations from '../../dist/services/ValkeyOperations.js';



export type AiAssignmentType = {
  label: string;
  name: string;
  confidence: number;
  explanation: string;
};

interface RateLimitConfig {
  requestsPerMinute: number;
  tokensPerMinute: number;
  requestsPerDay: number;
}

interface RequestRecord {
  timestamp: number;
  tokens: number;
}

class AiAssignment {
  private GeminiAi: GoogleGenAI;
  private rateLimits: RateLimitConfig;
  private ValkeyOps = new ValkeyOperations();
  private readonly RATE_LIMIT_PREFIX = 'gemini:ratelimit:';
  private readonly REQUEST_KEY = `${this.RATE_LIMIT_PREFIX}requests`;
  private readonly LAST_RESET_KEY = `${this.RATE_LIMIT_PREFIX}last_reset`;

  constructor(customLimits?: Partial<RateLimitConfig>) {
    const { gemini_api_key } = config;

    if (!gemini_api_key) {
      throw new Error("Gemini API Key is not defined in environment variables");
    }

    this.GeminiAi = new GoogleGenAI({ apiKey: gemini_api_key });
    
    // Default limits for gemini-2.5-flash (free tier)
    this.rateLimits = {
      requestsPerMinute: 5,
      tokensPerMinute: 250000,
      requestsPerDay: 20,
      ...customLimits
    };
  }

  /**
   * Estimate token count (rough approximation: 1 token ≈ 4 characters)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Get the last reset timestamp from Valkey
   */
  private async getLastResetTime(): Promise<number | null> {
    try {
      const data = await this.ValkeyOps.get(this.LAST_RESET_KEY)
      return data ? parseInt(data, 10) : null;
    } catch (error) {
      logger.error({ error }, 'Error fetching last reset time from Valkey');
      return null;
    }
  }

  /**
   * Set the last reset timestamp in Valkey
   */
  private async setLastResetTime(timestamp: number): Promise<void> {
    try {
      await this.ValkeyOps.set(this.LAST_RESET_KEY, timestamp.toString());
      } catch (error) {
      logger.error({ error }, 'Error saving last reset time to Valkey');
    }
  }

  /**
   * Get all request records from Valkey
   */
  private async getRequestHistory(): Promise<RequestRecord[]> {
    try {
      const data = await this.ValkeyOps.get(this.REQUEST_KEY)
      if (!data) {
        return [];
      }
      return JSON.parse(data);
    } catch (error) {
      logger.error({ error }, 'Error fetching request history from Valkey');
      return [];
    }
  }

  /**
   * Save request history to Valkey with 24-hour expiration
   */
  private async saveRequestHistory(records: RequestRecord[]): Promise<void> {
    try {
      await this.ValkeyOps.set(this.REQUEST_KEY, JSON.stringify(records),  86400)
    } catch (error) {
      logger.error({ error }, 'Error saving request history to Valkey');
    }
  }

  /**
   * Clean up old request records outside the time window
   */
  private cleanupOldRequests(records: RequestRecord[]): RequestRecord[] {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    // Keep only requests from the last 24 hours
    return records.filter(record => record.timestamp > oneDayAgo);
  }

  /**
   * Get requests within a specific time window
   */
  private getRecentRequests(
    records: RequestRecord[],
    timeWindowMs: number
  ): RequestRecord[] {
    const now = Date.now();
    const cutoff = now - timeWindowMs;
    return records.filter(record => record.timestamp > cutoff);
  }

  /**
   * Check if 24 hours have passed since the last reset
   */
  private async shouldResetDailyLimit(): Promise<boolean> {
    const lastResetTime = await this.getLastResetTime();
    
    if (!lastResetTime) {
      // No reset time found, this is the first run
      return false;
    }

    const now = Date.now();
    const timeSinceReset = now - lastResetTime;
    const oneDayMs = 24 * 60 * 60 * 1000;

    return timeSinceReset >= oneDayMs;
  }

  /**
   * Automatically reset if 24 hours have passed since last reset
   */
  private async autoResetIfNeeded(): Promise<void> {
    const shouldReset = await this.shouldResetDailyLimit();
    
    if (shouldReset) {
      logger.info('24 hours have passed, automatically resetting daily limits');
      await this.ValkeyOps.delete(this.REQUEST_KEY)
      // await this.valkeyClient.del(this.REQUEST_KEY);
      await this.setLastResetTime(Date.now());
    }
  }

  /**
   * Check if we can make a request without exceeding limits
   */
  private async checkRateLimits(estimatedTokens: number): Promise<{
    allowed: boolean;
    reason?: string;
    waitTimeMs?: number;
  }> {
    // Auto-reset if 24 hours have passed
    await this.autoResetIfNeeded();

    const allRecords = await this.getRequestHistory();
    const cleanedRecords = this.cleanupOldRequests(allRecords);

    // Save cleaned records back to Valkey
    if (cleanedRecords.length !== allRecords.length) {
      await this.saveRequestHistory(cleanedRecords);
    }

    const now = Date.now();
    const lastResetTime = await this.getLastResetTime();

    // Check requests per minute
    const requestsLastMinute = this.getRecentRequests(
      cleanedRecords,
      60 * 1000
    );
    if (requestsLastMinute.length >= this.rateLimits.requestsPerMinute) {
      const oldestRequest = requestsLastMinute[0];
      const waitTime = oldestRequest? 60 * 1000 - (now - oldestRequest.timestamp) : 60 * 1000
      return {
        allowed: false,
        reason: `Rate limit: ${this.rateLimits.requestsPerMinute} requests per minute exceeded`,
        waitTimeMs: waitTime
      };
    }

    // Check tokens per minute
    const tokensLastMinute = requestsLastMinute.reduce(
      (sum, record) => sum + record.tokens,
      0
    );
    if (tokensLastMinute + estimatedTokens > this.rateLimits.tokensPerMinute) {
      const oldestRequest = requestsLastMinute[0];
      const waitTime = oldestRequest? 60 * 1000 - (now - oldestRequest.timestamp) : 60 * 1000
      return {
        allowed: false,
        reason: `Token limit: ${this.rateLimits.tokensPerMinute} tokens per minute exceeded`,
        waitTimeMs: waitTime
      };
    }

    // Check requests per day
    const requestsLastDay = cleanedRecords;
    if (requestsLastDay.length >= this.rateLimits.requestsPerDay) {
      // Calculate wait time until next reset (24 hours from last reset)
      if (lastResetTime) {
        const nextResetTime = lastResetTime + (24 * 60 * 60 * 1000);
        const waitTime = nextResetTime - now;
        
        return {
          allowed: false,
          reason: `Daily limit: ${this.rateLimits.requestsPerDay} requests per day exceeded`,
          waitTimeMs: Math.max(waitTime, 0)
        };
      } else {
        // No last reset time, wait 24 hours from oldest request
        const oldestRequest = requestsLastDay[0];
        const waitTime = oldestRequest ? 24 * 60 * 60 * 1000 - (now - oldestRequest.timestamp) : 24 * 60 * 60 * 1000;
        return {
          allowed: false,
          reason: `Daily limit: ${this.rateLimits.requestsPerDay} requests per day exceeded`,
          waitTimeMs: Math.max(waitTime, 0)
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Record a request in Valkey
   */
  private async recordRequest(tokens: number): Promise<void> {
    try {
      const records = await this.getRequestHistory();
      
      // If this is the first request, set the reset time
      const lastResetTime = await this.getLastResetTime();
      if (!lastResetTime) {
        await this.setLastResetTime(Date.now());
      }

      records.push({
        timestamp: Date.now(),
        tokens
      });

      // Keep only last 24 hours of data
      const cleanedRecords = this.cleanupOldRequests(records);
      await this.saveRequestHistory(cleanedRecords);
    } catch (error) {
      logger.error({ error }, 'Error recording request in Valkey');
    }
  }

  /**
   * Wait until rate limits allow the next request
   */
  private async waitForRateLimit(estimatedTokens: number): Promise<void> {
    let attempts = 0;
    const maxAttempts = 100; // Increased for long waits

    while (attempts < maxAttempts) {
      const check = await this.checkRateLimits(estimatedTokens);

      if (check.allowed) {
        return;
      }

      const waitTimeHours = (check.waitTimeMs || 0) / (1000 * 60 * 60);
      const waitTimeMinutes = (check.waitTimeMs || 0) / (1000 * 60);

      logger.warn(
        {
          reason: check.reason,
          waitTimeHours: waitTimeHours.toFixed(2),
          waitTimeMinutes: Math.ceil(waitTimeMinutes),
          nextResetTime: new Date(Date.now() + (check.waitTimeMs || 0)).toISOString(),
          attempt: attempts + 1
        },
        'Rate limit reached, waiting for next period...'
      );

      // For long waits (>5 minutes), wait in chunks and log progress
      if ((check.waitTimeMs || 0) > 5 * 60 * 1000) {
        const chunkWaitTime = Math.min(5 * 60 * 1000, check.waitTimeMs || 1000);
        await new Promise(resolve => setTimeout(resolve, chunkWaitTime));
      } else {
        // For short waits, just wait it out
        await new Promise(resolve =>
          setTimeout(resolve, (check.waitTimeMs || 1000) + 100)
        );
      }

      attempts++;
    }

    throw new Error('Rate limit wait exceeded maximum attempts');
  }

  async geminiAiAssignment(
    content: string,
    retries: number = 3
  ): Promise<AiAssignmentType[]> {
    const prompt = tickerExtractor(content);

    // Estimate tokens for the prompt
    const promptText = JSON.stringify(prompt);
    const estimatedTokens = this.estimateTokens(promptText);

    logger.info(
      {
        estimatedTokens,
        contentLength: content.length
      },
      'Preparing Gemini API request'
    );

    // Wait if we're at rate limit (will wait up to 24 hours if needed)
    await this.waitForRateLimit(estimatedTokens);

    for (let i = 0; i < retries; i++) {
      try {
        // Record the request before making it
        await this.recordRequest(estimatedTokens);

        const response = await this.GeminiAi.models.generateContent({
          model: "gemini-2.5-flash",
          contents: prompt,
          config: { temperature: 0.2 }
        });

        if (!response.text) {
          throw new Error("Empty response from Gemini API");
        }

        const cleaned = response.text
          .replace(/```json\n?/g, '')
          .replace(/```\n?/g, '')
          .trim();

        const startIdx = cleaned.indexOf('[');
        const endIdx = cleaned.lastIndexOf(']');

        if (startIdx === -1 || endIdx === -1) {
          throw new Error("No JSON array in response");
        }

        const jsonStr = cleaned.substring(startIdx, endIdx + 1);
        const result: AiAssignmentType[] = JSON.parse(jsonStr);

        logger.info('Gemini API request successful');
        return result;

      } catch (error: any) {
        const isLastRetry = i === retries - 1;

        // Handle rate limit errors from API
        if (error.status === 429) {
          logger.warn('Received 429 from Gemini API, adjusting backoff');
          const delay = Math.pow(2, i + 2) * 1000;
          if (!isLastRetry) {
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        }

        const shouldRetry = error.status === 503 || error.status === 429;

        if (isLastRetry || !shouldRetry) {
          throw new Error(`Gemini API error: ${error}`);
        }

        const delay = Math.pow(2, i + 1) * 1000;
        logger.info(`Retry ${i + 1}/${retries} in ${delay / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw new Error("Unreachable");
  }

  /**
   * Get current rate limit status from Valkey
   */
  async getRateLimitStatus(): Promise<{
    requestsLastMinute: number;
    tokensLastMinute: number;
    requestsLastDay: number;
    limits: RateLimitConfig;
    nextResetTime: Date | null;
  }> {
    const allRecords = await this.getRequestHistory();
    const cleanedRecords = this.cleanupOldRequests(allRecords);

    const requestsLastMinute = this.getRecentRequests(cleanedRecords, 60 * 1000);
    const tokensLastMinute = requestsLastMinute.reduce(
      (sum, record) => sum + record.tokens,
      0
    );

    const lastResetTime = await this.getLastResetTime();
    const nextResetTime = lastResetTime 
      ? new Date(lastResetTime + (24 * 60 * 60 * 1000))
      : null;

    return {
      requestsLastMinute: requestsLastMinute.length,
      tokensLastMinute,
      requestsLastDay: cleanedRecords.length,
      limits: this.rateLimits,
      nextResetTime
    };
  }

  /**
   * Manual reset - use only if you want to force a new period
   */
  async manualReset(): Promise<void> {
    try {
      await this.ValkeyOps.delete(this.REQUEST_KEY)
      await this.setLastResetTime(Date.now());
      logger.info('Manual reset complete - new 24-hour period started');
    } catch (error) {
      logger.error({ error }, 'Error during manual reset');
    }
  }
}

export default AiAssignment;