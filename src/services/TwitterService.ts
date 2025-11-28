import axios from 'axios';
import crypto from 'crypto';
import OAuth from 'oauth-1.0a';
import { config } from '../config/environmentalVariables.js';
import { supabase } from '../config/supabase.js';
import type { Database } from '../types/database.types.js';
import { logger } from '../utils/Logger.js';

type TweetQuota = Database['public']['Tables']['tweet_quota']['Insert']

interface TweetResponse {
  data: {
    id: string;
    text: string;
    edit_history_tweet_ids: string[];
  };
}

export class TwitterService {
  private oauth: any;
  private token: { key: string; secret: string };
  private readonly tweetsURL = 'https://api.twitter.com/2/tweets';
  private readonly MONTHLY_LIMIT = 495;
  private readonly DAILY_LIMIT = 17

  constructor() {
    const {twitter_api_key, twitter_key_secret, twitter_access_token, twitter_access_token_secret} = config;
    
    if (!twitter_api_key || !twitter_key_secret) {
      throw new Error('Missing Twitter API credentials. Check your .env file.');
    }
    
    if (!twitter_access_token || !twitter_access_token_secret) {
      throw new Error('Missing Twitter access tokens. Check your .env file.');
    }

    this.oauth = new OAuth({
      consumer: {
        key: twitter_api_key,
        secret: twitter_key_secret
      },
      signature_method: 'HMAC-SHA1',
      hash_function(base_string: string, key: string) {
        return crypto
          .createHmac('sha1', key)
          .update(base_string)
          .digest('base64');
      }
    });

    this.token = {
      key: twitter_access_token,
      secret: twitter_access_token_secret
    };
  }

  /**
   * Get current month in YYYY-MM format
   */
  private getCurrentMonth(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  /**
   * Get current date in YYYY-MM-DD format
   */
  private getCurrentDate(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  /**
   * Get or create tweet quota for current month
   */
  private async getTweetQuota(): Promise<TweetQuota> {
    if (!supabase) {
      // Return a default quota when Supabase is not available
      const currentMonth = this.getCurrentMonth();
      const currentDate = this.getCurrentDate();
      return {
        month: currentMonth,
        tweets_sent: 0,
        last_tweet_date: currentDate,
        daily_tweets_sent: 0
      };
    }

    const currentMonth = this.getCurrentMonth();
    const currentDate = this.getCurrentDate();

    // Try to get existing quota
    const { data, error } = await supabase
      .from('tweet_quota')
      .select('*')
      .eq('month', currentMonth)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = not found
      throw error;
    }

    // If no quota exists or it's a new month, create one
    if (!data) {
      const newQuota: TweetQuota = {
        month: currentMonth,
        tweets_sent: 0,
        last_tweet_date: currentDate,
        daily_tweets_sent: 0
      };

      const { data: created, error: createError } = await supabase
        .from('tweet_quota')
        .insert(newQuota)
        .select()
        .single();

      if (createError || created !== null ) throw createError;

      return created;
    }

    // Reset daily counter if it's a new day
    if (data.last_tweet_date !== currentDate) {
      const { data: updated, error: updateError } = await supabase
        .from('tweet_quota')
        .update({
          last_tweet_date: currentDate,
          daily_tweets_sent: 0
        })
        .eq('month', currentMonth)
        .select()
        .single();

      if (updateError || updated !== null) throw updateError;
      return updated;
    }
    
    return data;
  }

  /**
   * Check if we can send a tweet based on limits
   */
  async canTweet(): Promise<{ allowed: boolean; reason?: string; dailyLimit?: number; dailySent?: number }> {
    const {tweets_sent, daily_tweets_sent, last_tweet_date, } = await this.getTweetQuota();

    if(
        last_tweet_date === null || last_tweet_date === undefined ||
        daily_tweets_sent === null || daily_tweets_sent === undefined ||
        tweets_sent === null || tweets_sent === undefined
      ) {
        throw new Error("Tweet quota data is incomplete");
    }

    // Check monthly limit
    if (tweets_sent >= this.MONTHLY_LIMIT) {
      return {
        allowed: false,
        reason: 'Monthly limit reached (495 tweets)'
      };
    }

    // Calculate daily limit
    const tweetsRemaining = this.MONTHLY_LIMIT - tweets_sent;
    

    // Check daily limit
    if (daily_tweets_sent >= this.DAILY_LIMIT) {
      return {
        allowed: false,
        reason: `Daily limit reached (${this.DAILY_LIMIT} tweets)`,
        dailyLimit: this.DAILY_LIMIT,
        dailySent: daily_tweets_sent
      };
    }

    return {
      allowed: true,
      dailyLimit: this.DAILY_LIMIT,
      dailySent: daily_tweets_sent
    };
  }

  /**
   * Increment tweet counters
   */
  private async incrementTweetCount(): Promise<void> {
    if (!supabase) {
      logger.warn('Supabase not configured - tweet count not persisted');
      return;
    }

    const currentMonth = this.getCurrentMonth();

    const { error } = await supabase
      .rpc('increment_tweet_count', { month_param: currentMonth });

    if (error) throw error;
  }

  /**
   * Post a tweet with news and ticker information
   */
  async tweet(text: string): Promise<TweetResponse> {
    try {
      // Check if we can tweet
      const canTweetResult = await this.canTweet();
      if (!canTweetResult.allowed) {
        throw new Error(`Cannot tweet: ${canTweetResult.reason}`);
      }

      // Validate tweet length
      if (text.length > 280) {
        throw new Error(`Tweet too long: ${text.length} characters (max 280)`);
      }

      const authHeader = this.oauth.toHeader(
        this.oauth.authorize({
          url: this.tweetsURL,
          method: 'POST'
        }, this.token)
      );

      const response = await axios.post(
        this.tweetsURL,
        { text },
        {
          headers: {
            Authorization: authHeader["Authorization"],
            "Content-Type": "application/json",
            "Accept": "application/json"
          }
        }
      );

      // Increment counters after successful tweet
      await this.incrementTweetCount();

      logger.info(`✅ Tweet sent. Daily: ${canTweetResult.dailySent! + 1}/${canTweetResult.dailyLimit!}`);

      return response.data;

    } catch (error: any) {
      if (error.response) {
        throw new Error(
          `Twitter API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`
        );
      }
      throw new Error(`Failed to post tweet: ${error.message}`);
    }
  }

  /**
   * Get current quota status
   */
  async getQuotaStatus(): Promise<{
    monthlyLimit: number;
    monthlySent: number;
    monthlyRemaining: number;
    dailyLimit: number;
    dailySent: number;
    dailyRemaining: number;
  }> {
    const {tweets_sent, daily_tweets_sent, last_tweet_date, } = await this.getTweetQuota();
    
    if(
        last_tweet_date === null || last_tweet_date === undefined ||
        daily_tweets_sent === null || daily_tweets_sent === undefined ||
        tweets_sent === null || tweets_sent === undefined
      ) {
        throw new Error("Tweet quota data is incomplete");
    }
    const tweetsRemaining = this.MONTHLY_LIMIT - tweets_sent;

    return {
      monthlyLimit: this.MONTHLY_LIMIT,
      monthlySent: tweets_sent,
      monthlyRemaining: tweetsRemaining,
      dailyLimit: this.DAILY_LIMIT,
      dailySent: daily_tweets_sent,
      dailyRemaining: this.DAILY_LIMIT - daily_tweets_sent
    };
  }

  /**
   * Format news article with tickers into tweet text
   */
  formatNewsTweet(
    title: string, 
    tickers: Array<{ label: string; confidence: number }>,
    url?: string
  ): string {
    const topTickers = tickers
      .slice(0, 3)
      .map(t => `$${t.label} ${(t.confidence * 100).toFixed(0)}%`)
      .join(' | ');

    let tweet = `${title}\n\n📊 ${topTickers}`;

    if (url && tweet.length + url.length + 2 <= 280) {
      tweet += `\n\n${url}`;
    }

    const hashtags = '\n\n#StockMarket #Trading';
    if (tweet.length + hashtags.length <= 280) {
      tweet += hashtags;
    }

    return tweet;
  }
}