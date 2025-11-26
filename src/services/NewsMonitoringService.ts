import axios, { type AxiosInstance } from 'axios';
import crypto from 'crypto';
import Parser from 'rss-parser';
import CacheableLookup from 'cacheable-lookup';
import dns from 'dns';
import https from 'https';

import type { Article, KeywordWeight } from '../models/Article.js';
import { keywordWeights, contentThresholds, getTrend } from '../config/keywords.js';

import ValkeyAdvanced from './ValkeyAdvanced.js';
import ValkeyOperations from './ValkeyOperations.js';
import { db } from '../database/supabase.database.js';
import AiAssignment from './AiAssignment.js';



export class NewsMonitoringService {
  private keywordWeights: KeywordWeight[] = keywordWeights;
  private contentThresholds = contentThresholds;
  private valkeyOps = new ValkeyOperations();
  private valkeyAdvanced = new ValkeyAdvanced();
  public seenRssState: Map<string, Set<string>> = new Map();
  private rssParser = new Parser();
  private dnsCache = new CacheableLookup;
  private httpsAgent = new https.Agent;
  private tokenDocFreq: Map<string, number> = new Map();
  private totalKeywordTokens = 0;
  private DNS_SERVERS: string[][] = [
  ['8.8.8.8', '8.8.4.4'],      // Google
  ['1.1.1.1', '1.0.0.1'],      // Cloudflare
  ['9.9.9.9', '149.112.112.112'], // Quad9
  ];
  private resolverPool: { client: AxiosInstance, servers: string[] }[] = [];
  
  private readonly maxRetries = 3;

  constructor() {
    dns.setDefaultResultOrder('ipv4first');
    this.dnsCache.install(this.httpsAgent);

    const seenTokenDocs: Record<string, Set<string>> = {};
    for (const { keyword } of this.keywordWeights) {
      const toks = keyword.toLowerCase().split(/\W+/).filter(Boolean);
      this.totalKeywordTokens += toks.length;
      const uniq = new Set(toks);
      for (const t of uniq) {
        if (!seenTokenDocs[t]) seenTokenDocs[t] = new Set();
        seenTokenDocs[t].add(keyword);
      }
    }
    for (const [t, set] of Object.entries(seenTokenDocs)) {
      this.tokenDocFreq.set(t, set.size);
    }

    
    for (const servers of this.DNS_SERVERS) {
    const resolver = new dns.Resolver();
    resolver.setServers(servers);

    const lookup = new CacheableLookup({ resolver, maxTtl: 60 });

    const httpsAgent = new https.Agent({
      keepAlive: true,
      rejectUnauthorized: process.env.NODE_ENV === 'production'
    });

  lookup.install(httpsAgent);

  const client = axios.create({
    httpsAgent,
    timeout: 20000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
      'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  this.resolverPool.push({ client, servers });
  }
  }
  
 
  private async smartGet(url: string, maxRetries = this.maxRetries) {
    let lastError: any = null;

  for (let i = 0; i < Math.min(maxRetries, this.resolverPool.length); i++) {
    const resolver = this.resolverPool[i];
    
    if(!resolver) return;

    try {
      const res = await resolver.client.get(url);
      return res;
    } catch (error: any) {
      lastError = error;
      const code = error.code || error.message || 'Unknown';

      if (['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code))
        continue;

      break;
    }}
    
    throw lastError;
  }

  async monitorRssFeedWithRedis(feedUrl: string): Promise<Article[]> {
    const results: Article[] = [];
    
    try {
      const res = await this.rssParser.parseURL(feedUrl);
      if (!res) return [];
      
      const items = (res.items || []) as any[];
      if (!items.length) return [];

      const feedKey = `rss:seen:${crypto.createHash('md5').update(feedUrl).digest('hex')}`;
      const feedExists = await this.valkeyOps.exists(feedKey);

      if (!feedExists) {
        await this.valkeyAdvanced.sadd(feedKey, '__init__');
        await this.valkeyAdvanced.srem(feedKey, '__init__');
      }

      for (const it of items) {
        const title = it.title || '';
        const link = it.link || '';
        const description = it.contentSnippet ?? it.content ?? it['content:encoded'] ?? it.description ?? '';
        const pubDate = it.isoDate ? new Date(it.isoDate) : (it.pubDate ? new Date(it.pubDate) : new Date());
        const encodedContent = it['content:encoded'] ? this.extractTextFromHtml(it['content:encoded']) : '';
        const categories = (it.categories || [])
          .map((cat: any) => (typeof cat === 'object' && cat._ ? cat._ : String(cat)))
          .join(', ');
        
        const rawId = it.guid ?? it.id ?? `${link}|${pubDate.toISOString()}`;
        const itemId = crypto.createHash('sha1').update(String(rawId)).digest('hex');

        const alreadySeen = await this.valkeyAdvanced.sismember(feedKey, itemId);
        if (alreadySeen) continue;

        const content = `${title} --- ${this.extractTextFromHtml(String(description))} --- ${encodedContent} --- ${categories}`.trim().toLowerCase();

        const analysis = this.matchKeywords(content);
        
        if (
          analysis.totalPoints >= this.contentThresholds.rss.minimumScore &&
          analysis.uniqueKeywordCount >= this.contentThresholds.rss.requiredKeywords
        ) {
          await this.valkeyAdvanced.sadd(feedKey, itemId);
          
          const aiAnalysis = await new AiAssignment().geminiAiAssignment(content);
          const trend = await getTrend(content)
          const article: Article = {
            id: itemId,
            title,
            content,
            url: link || feedUrl,
            source: feedUrl,
            publishDate: pubDate,
            keywords: analysis.matches.map(m => m.keyword).filter((k): k is string => typeof k === 'string'),
            relevanceScore: analysis.totalPoints > 100? 100 : analysis.totalPoints,
            isRssFeed: true,
            aiAnalysis,
            trend
          };
          
          results.push(article);
        }
      }
      
      if (results.length > 0) {
        await db.processArticlesInBatches(results);
        await db.logScraping(feedUrl, 'success');
      }
      
      return results;
      
    } catch (error: any) {
      try {
        await db.logScraping(feedUrl, 'failed', [error.message]);
      } catch (logError) {
        throw error('Failed to log scraping error', logError)
      }
      
      throw error(error)
    }
  }
  
  private escapeRegex(str: string) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private extractTextFromHtml(html: string): string {
    let t = html.replace(/<script[\s\S]*?<\/script>/gi, ' ');
    t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
    t = t.replace(/<[^>]+>/g, ' ');
    return this.decodeHtmlEntities(t).replace(/\s+/g, ' ').trim();
  }

  private decodeHtmlEntities(str: string): string {
    return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }

  private matchKeywords(content: string) {
    const matches: Array<{ keyword: string; count: number; points: number; category?: string|undefined }> = [];
    let totalPoints = 0;
    const matchedKeywords = new Map<string, { count: number; points: number; category?: string|undefined }>();
    const matchedCategories = new Set<string>();

    const normalizedContent = content.replace(/[\u200B-\u200D\uFEFF]/g, ''); // remove zero-width chars

    if (!content || !content.trim()) {
      return { totalPoints: 0, matches: [], uniqueKeywordCount: 0, matchedCategories: new Set() };
    }

    for (const { keyword, points, category } of this.keywordWeights) {
      if (!keyword || !keyword.trim()) continue;

      const pattern = `\\b${this.escapeRegex(keyword)}\\b`;
      const regex = new RegExp(pattern, 'gi');
      const found = normalizedContent.match(regex);
      
      if (found && found.length > 0) {
        const count = found.length;
        if (matchedKeywords.has(keyword)) {
          const existing = matchedKeywords.get(keyword)!;
          existing.count += count;
          matchedKeywords.set(keyword, existing);
        } else {
          const entry: { count: number; points: number; category?: string } = { count, points };
          if (category !== undefined) entry.category = category;
          matchedKeywords.set(keyword, entry);
          if (category !== undefined) matchedCategories.add(category);
        }
        totalPoints += count * points;
      }
    }

    for (const [keyword, val] of matchedKeywords.entries()) {
      matches.push({ keyword, count: val.count, points: val.points, category: val.category });
    }

    return {
      totalPoints,
      matches,
      uniqueKeywordCount: matches.length,
      matchedCategories
    };
  }
}