import { 
  GoogleGenAI,
  Type,
  type Tool,
  type Part 
} from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import OAuth from 'oauth-1.0a';
import { createHmac } from 'crypto';
import axios from 'axios';
import { PostHog } from 'posthog-node';
import YahooFinance from 'yahoo-finance2';
import type { HistoricalResult } from 'yahoo-finance2/modules/historical';

import { config } from '../config/environmentalVariables.js';
import { logger } from '../utils/Logger.js';


// ─────────────────────────────────────────────
// POSTHOG CLIENT
// ─────────────────────────────────────────────
// Singleton — shared across all analyzeNews() calls.
// PostHog's @posthog/ai wrapper only intercepts generateContent() calls,
// NOT the chats.create()/sendMessage() agentic loop pattern we use here.
// We instrument manually instead, capturing one event per sendMessage() call
// with token usage from Gemini's usageMetadata so PostHog sees everything.

const phClient = new PostHog(
  config.posthog_api_key!,
  { host: config.posthog_host ?? "https://us.i.posthog.com" }
);

const yahooFinance = new YahooFinance();
// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

/** Incoming DTO — what callers pass into analyzeNews() */
export interface NewsObject {
  id: string;
  headline: string;
  body: string;
  source: string;
  url: string;
  publishedAt: string; // ISO 8601
  category?: string ;
  metadata?: Record<string, unknown>;
}

/**
 * Mirrors the public.articles row shape returned from Supabase.
 * BUG 2 FIX: The DB uses `title` and `content`, NOT `headline` / `body`.
 * Keeping this as a separate type from NewsObject prevents silent field-name
 * mismatches when Gemini returns related articles in contradiction/alignment results.
 */
export interface ArticleRecord {
  id: string;
  title: string;
  content: string | null;
  source: string | null;
  url: string;
  published_at: string | null;
  tickers: string[];
}

export interface StockRecord {
  ticker:       string;
  company_name: string;
  sector:       string | null;
  market_cap:   number | null;
}

export type ScoreLabel = "Low" | "Medium" | "High" | "Critical";
export type MarketPrediction = "buy" | "sell" | "hold" | "neutral";

export interface ContradictionResult {
  score: number;
  label: ScoreLabel;
  // BUG 2 FIX: was NewsObject[] — must be ArticleRecord[] because the data
  // comes from the articles table (title/content, not headline/body)
  contradictingArticles: ArticleRecord[];
  summary: string;
}

export interface AlignmentResult {
  score: number;
  label: ScoreLabel;
  // BUG 2 FIX: same as above
  aligningArticles: ArticleRecord[];
  boostedImpactScore: number;
  summary: string;
}

export interface MarketImpact {
  prediction: MarketPrediction;
  confidence: number;
  reasoning: string;
}

/** Result of a single tweet post attempt via the Twitter API */
export interface TweetPostResult {
  posted:        boolean;
  tweetId?:      string;   // Twitter's assigned ID — needed for quote-tweet chaining
  tweetUrl?:     string;   // https://twitter.com/i/web/status/<id>
  reason?:       string;   // populated when posted === false
  delayMinutes?: number;   // how long the tool waited before posting (tweet2 only)
}

export interface AnalysisResult {
  newsId: string;
  articleDbId: string;
  alreadyInDatabase: boolean;
  /** Result of the volatility gate in STEP 1A. SKIP = no analysis posted. */
  volatilityGate: "PROCEED" | "SKIP";
  /** VIX closing level at time of analysis. */
  vixLevel: number;
  /** VIX context bucket. */
  vixContext: "HIGH" | "ELEVATED" | "LOW";
  affectedTickers: string[];
  newTickersInserted: string[];
  contradiction: ContradictionResult | null;
  alignment: AlignmentResult | null;
  marketImpact: MarketImpact;
  signalQuality: "HIGH" | "MEDIUM" | "LOW";
  relevanceScore: number;
  isRepeatSubject: boolean;
  /**
   * Main tweet — plain text only, no link, no formatting.
   * Stored in analysis_results.tweet.
   */
  mainTweet: string;
  /**
   * Reply tweet — contains only the article URL.
   * Posted as first reply to mainTweet. Not stored in DB.
   */
  replyTweet: string;
  /**
   * Quote tweet — engagement-driven hook.
   * Only posted if mainTweet gets > 100 impressions in 20 minutes.
   * Not stored in DB.
   */
  quoteTweet: string;
  /** Result of posting the main tweet. */
  mainTweetPostResult: TweetPostResult;
  /** Result of posting the link reply. */
  replyPostResult: TweetPostResult;
  /**
   * Result of posting the quote tweet.
   * null → impressions threshold not met, skipped.
   */
  quoteTweetPostResult: TweetPostResult | null;
  /** Impressions on mainTweet after 20 min. */
  mainTweetImpressions: number;
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function scoreToLabel(score: number): ScoreLabel {
  if (score >= 75) return "Critical";
  if (score >= 50) return "High";
  if (score >= 25) return "Medium";
  return "Low";
}

// ─────────────────────────────────────────────
// GEMINI KEY ROTATION POOL
// ─────────────────────────────────────────────
// Supports up to 5 free-tier API keys from DIFFERENT Google Cloud projects.
// Each project gets its own 250 RPD and 10 RPM quota on gemini-2.5-flash.
//
// Add keys to your .env:
//   GEMINI_API_KEY_1=...
//   GEMINI_API_KEY_2=...
//   GEMINI_API_KEY_3=...   (optional)
//   GEMINI_API_KEY_4=...   (optional)
//   GEMINI_API_KEY_5=...   (optional)
//
// ─────────────────────────────────────────────
// GEMINI RATE LIMITER
// ─────────────────────────────────────────────
// Single API key with exponential backoff on 429s.

const GEMINI_MODEL        = "gemini-2.5-flash";
const GEMINI_RPM          = 10;                                         // paid tier: raise to 150
const GEMINI_MIN_GAP_MS   = Math.ceil((60 / GEMINI_RPM) * 1000);       // 6 000 ms
const GEMINI_MAX_RETRIES  = 6;
const GEMINI_BACKOFF_BASE = 15_000;                                     // 15 s — doubles each retry

let lastGeminiRequestAt = 0;

async function rateLimitedSend<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt++) {
    const elapsed = Date.now() - lastGeminiRequestAt;
    if (elapsed < GEMINI_MIN_GAP_MS) {
      await new Promise<void>((r) => setTimeout(r, GEMINI_MIN_GAP_MS - elapsed));
    }

    try {
      lastGeminiRequestAt = Date.now();
      return await fn();
    } catch (err: unknown) {
      const msg    = err instanceof Error ? err.message : String(err);
      const is429  = msg.includes("429") ||
        (typeof (err as Record<string, unknown>).status === "number" &&
          (err as Record<string, unknown>).status === 429);

      if (!is429 || attempt === GEMINI_MAX_RETRIES) throw err;

      const waitMs = GEMINI_BACKOFF_BASE * Math.pow(2, attempt);
      logger.warn(
        `⏳ Gemini rate limit hit (attempt ${attempt + 1}/${GEMINI_MAX_RETRIES}). ` +
        `Retrying in ${waitMs / 1000}s...`
      );
      await new Promise<void>((r) => setTimeout(r, waitMs));
    }
  }
  throw new Error("rateLimitedSend: exceeded max retries");
}

// ─────────────────────────────────────────────
// SUPABASE CLIENT
// ─────────────────────────────────────────────

const supabase = createClient(
  config.supabase_url!,
  config.supabase_service_role_key!
);

// ─────────────────────────────────────────────
// TWITTER OAUTH 1.0A CLIENT
// ─────────────────────────────────────────────
// Requires four env vars:
//   TWITTER_API_KEY             (consumer key)
//   TWITTER_API_SECRET          (consumer secret)
//   TWITTER_ACCESS_TOKEN        (user access token)
//   TWITTER_ACCESS_TOKEN_SECRET (user access token secret)

const TWEETS_URL = "https://api.twitter.com/2/tweets";

const twitterOAuth = new OAuth({
  consumer: {
    key:    config.twitter_api_key!,
    secret: config.twitter_key_secret!,
  },
  signature_method: "HMAC-SHA1",
  hash_function(base_string, key) {
    return createHmac("sha1", key).update(base_string).digest("base64");
  },
});

const twitterToken = {
  key:    config.twitter_access_token!,
  secret: config.twitter_access_token_secret!,
};

// ── Auto-like helper ──────────────────────────────────────────────────────────
// Automatically likes every tweet posted by the account immediately after posting.
// Uses the Twitter v2 likes endpoint: POST /2/users/:id/likes
// The authenticated user's ID is fetched once at startup and cached.
// This is infrastructure — not an agent decision.

let cachedUserId: string | null = null;

async function getAuthenticatedUserId(): Promise<string | null> {
  if (cachedUserId) return cachedUserId;

  const url = "https://api.twitter.com/2/users/me";
  const authHeader = twitterOAuth.toHeader(
    twitterOAuth.authorize({ url, method: "GET" }, twitterToken)
  );

  try {
    const res = await axios.get(url, {
      headers: {
        Authorization: authHeader["Authorization"],
        Accept:        "application/json",
      },
    });
    cachedUserId = res.data?.data?.id as string ?? null;
    if (cachedUserId) logger.info(`🐦 Twitter user ID cached: ${cachedUserId}`);
    return cachedUserId;
  } catch (err: unknown) {
    logger.warn(`Could not fetch Twitter user ID: ${err}`);
    return null;
  }
}

async function likeTweet(tweetId: string): Promise<void> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    logger.warn(`⚠️  Auto-like skipped — could not resolve user ID for tweet ${tweetId}`);
    return;
  }

  const url = `https://api.twitter.com/2/users/${userId}/likes`;
  const authHeader = twitterOAuth.toHeader(
    twitterOAuth.authorize({ url, method: "POST" }, twitterToken)
  );

  try {
    await axios.post(
      url,
      { tweet_id: tweetId },
      {
        headers: {
          Authorization:  authHeader["Authorization"],
          "Content-Type": "application/json",
          Accept:         "application/json",
        },
      }
    );
    logger.info(`❤️  Auto-liked tweet: ${tweetId}`);
  } catch (err: unknown) {
    // Non-fatal — failed likes don't affect the pipeline
    const reason = axios.isAxiosError(err)
      ? `${err.response?.status} ${JSON.stringify(err.response?.data)}`
      : String(err);
    logger.warn(`Auto-like failed for ${tweetId}: ${reason}`);
  }
}

// ─────────────────────────────────────────────
// MACRO PROXY MAPPING
// ─────────────────────────────────────────────
// Moved out of the system prompt to save ~300 tokens per turn.
// Referenced in system prompt as "MACRO_PROXIES constant".
// The agent uses this via the tool declaration description.

export const MACRO_PROXIES: Record<string, string[]> = {
  "uk_rates":        ["EWU", "HSBA", "LLOY", "BARC", "GBP=X"],
  "us_fed":          ["SPY", "QQQ", "TLT", "IEF"],
  "us_inflation":    ["TIP", "RINF", "SPY"],
  "oil_energy":      ["USO", "XLE", "OXY", "CVX", "XOM"],
  "gold":            ["GLD", "IAU", "GDX"],
  "europe_ecb":      ["EZU", "FEZ", "EWG"],
  "china_hk":        ["FXI", "MCHI", "EWH"],
  "geopolitical":    ["GLD", "USO", "LMT", "RTX", "NOC"],
  "crypto_reg":      ["BTC-USD", "ETH-USD", "COIN", "MSTR"],
  "usd_dxy":         ["UUP", "EEM", "GLD"],
  "us_recession":    ["SPY", "QQQ", "TLT", "HYG"],
  "semiconductors":  ["NVDA", "AMD", "INTC", "SMH"],
  "banking_credit":  ["XLF", "JPM", "BAC", "KRE"],
};

// ─────────────────────────────────────────────
// TOOL IMPLEMENTATIONS
// ─────────────────────────────────────────────

const toolImplementations: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {

  // ── scan_ticker_volatility ────────────────────────────────────────────────
  // Fetches volatility metrics for a list of tickers from Yahoo Finance.
  // Called FIRST in STEP 1 — gates the entire analysis.
  //
  // Metrics computed per ticker:
  //   HV30    — 30-day historical volatility (annualised std dev of log returns)
  //             Low < 15% | Medium 15–35% | High > 35%
  //   ATR14%  — 14-day Average True Range as % of current price
  //             Low < 0.8% | Medium 0.8–2% | High > 2%
  //   IVProxy — implied volatility proxy: if options data available, use IV from
  //             nearest ATM call. Falls back to "unavailable" for ETFs/indices.
  //   VIXLevel — current ^VIX close. Context for overall market fear.
  //             Low < 15 | Elevated 15–25 | High > 25
  //
  // Gate logic:
  //   PROCEED  — at least one ticker has HV30 > 15% OR ATR14% > 0.8%
  //              OR VIX > 20 (elevated market environment)
  //   SKIP     — ALL tickers are low volatility AND VIX < 20
  //              News in a dead market is noise — don't post it.
  scan_ticker_volatility: async (args: Record<string, unknown>) => {
    const { tickers } = args as { tickers: string[] };

    if (!tickers || tickers.length === 0) {
      return { gate: "SKIP", reason: "no_tickers", results: [] };
    }

    // ── Fetch VIX for market-wide context ────────────────────────────────────
    let vixLevel = 0;
    try {
      const vixData = await yahooFinance.quote("^VIX", { fields: ["regularMarketPrice"] });
      vixLevel = (vixData as { regularMarketPrice?: number }).regularMarketPrice ?? 0;
    } catch {
      logger.warn("VIX fetch failed — proceeding without market context");
    }

    // ── Helper: compute HV30 from daily close prices ──────────────────────────
    function computeHV30(closes: number[]): number {
      if (closes.length < 2) return 0;
      const logReturns: number[] = [];
      for (let i = 1; i < closes.length; i++) {
        logReturns.push(Math.log(closes[i]! / closes[i - 1]!));
      }
      const mean = logReturns.reduce((s, r) => s + r, 0) / logReturns.length;
      const variance = logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (logReturns.length - 1);
      return Math.sqrt(variance) * Math.sqrt(252) * 100; // annualised %
    }

    // ── Helper: compute ATR14 as % of price ──────────────────────────────────
    function computeATRPct(
      highs: number[], lows: number[], closes: number[], currentPrice: number
    ): number {
      if (highs.length < 2) return 0;
      const trs: number[] = [];
      for (let i = 1; i < Math.min(highs.length, 15); i++) {
        const hl  = highs[i]!  - lows[i]!;
        const hpc = Math.abs(highs[i]!  - closes[i - 1]!);
        const lpc = Math.abs(lows[i]!   - closes[i - 1]!);
        trs.push(Math.max(hl, hpc, lpc));
      }
      const atr14 = trs.reduce((s, t) => s + t, 0) / trs.length;
      return currentPrice > 0 ? (atr14 / currentPrice) * 100 : 0;
    }

    // ── Per-ticker analysis ───────────────────────────────────────────────────
    const results: Array<{
      ticker:   string;
      hv30:     number;
      atr14Pct: number;
      ivProxy:  string;
      price:    number;
      verdict:  "LOW" | "MEDIUM" | "HIGH";
      reason:   string;
    }> = [];

    const end   = new Date();
    const start = new Date(end.getTime() - 45 * 24 * 60 * 60 * 1000); // 45 days for ATR buffer

    await Promise.allSettled(
      tickers.map(async (ticker) => {
        try {
          // Historical OHLC for HV and ATR
          const historical = await yahooFinance.historical(ticker, {
            period1: start.toISOString().slice(0, 10),
            period2: end.toISOString().slice(0, 10),
            interval: "1d",
          }) as HistoricalResult;

          if (!historical || historical.length < 5) {
            results.push({
              ticker, hv30: 0, atr14Pct: 0, ivProxy: "unavailable",
              price: 0, verdict: "LOW", reason: "insufficient_data",
            });
            return;
          }

          const closes  = historical.map((d:any) => d.close);
          const highs    = historical.map((d:any) => d.high);
          const lows     = historical.map((d:any) => d.low);
          const price    = closes[closes.length - 1];

          const hv30    = computeHV30(closes.slice(-31));
          const atr14Pct = computeATRPct(highs, lows, closes, price);

          // IV proxy — options chain, nearest expiry ATM call
          let ivProxy = "unavailable";
          try {
            const optionChain = await yahooFinance.options(ticker) as {
            expirationDates?: Date[];
            options?: Array<{
              calls?: Array<{ strike?: number; impliedVolatility?: number }>;
            }>;
          };
          const nearExpiry = optionChain.expirationDates?.[0];
          if (nearExpiry) {
            const chain = await yahooFinance.options(ticker, { date: nearExpiry }) as typeof optionChain;
            const atmCall = chain.options?.[0]?.calls?.find(
              (c) => Math.abs((c.strike ?? 0) - price) / price < 0.05
            );
            }
          } catch {
            // Options not available for this ticker — use "unavailable"
          }

          // Verdict
          const verdict: "LOW" | "MEDIUM" | "HIGH" =
            hv30 > 35 || atr14Pct > 2
              ? "HIGH"
              : hv30 > 15 || atr14Pct > 0.8
                ? "MEDIUM"
                : "LOW";

          const reason =
            verdict === "HIGH"   ? `HV30=${hv30.toFixed(1)}%, ATR14=${atr14Pct.toFixed(2)}%` :
            verdict === "MEDIUM" ? `HV30=${hv30.toFixed(1)}%, ATR14=${atr14Pct.toFixed(2)}%` :
                                   `HV30=${hv30.toFixed(1)}% and ATR14=${atr14Pct.toFixed(2)}% both low`;

          results.push({ ticker, hv30, atr14Pct, ivProxy, price, verdict, reason });

        } catch (err) {
          logger.warn(`Volatility fetch failed for ${ticker}: ${err}`);
          results.push({
            ticker, hv30: 0, atr14Pct: 0, ivProxy: "error",
            price: 0, verdict: "LOW", reason: `fetch_error: ${String(err)}`,
          });
        }
      })
    );

    // ── Gate decision ─────────────────────────────────────────────────────────
    const anyActive = results.some((r) => r.verdict !== "LOW");
    const vixElevated = vixLevel > 20;
    const gate: "PROCEED" | "SKIP" = (anyActive || vixElevated) ? "PROCEED" : "SKIP";

    const highCount   = results.filter((r) => r.verdict === "HIGH").length;
    const mediumCount = results.filter((r) => r.verdict === "MEDIUM").length;

    return {
      gate,
      vixLevel:   parseFloat(vixLevel.toFixed(2)),
      vixContext: vixLevel > 25 ? "HIGH" : vixLevel > 15 ? "ELEVATED" : "LOW",
      summary:    `${highCount} HIGH, ${mediumCount} MEDIUM volatility ticker(s). VIX=${vixLevel.toFixed(1)}.`,
      skipReason: gate === "SKIP"
        ? "All tickers show low volatility and VIX < 20 — news unlikely to move prices."
        : undefined,
      results,
    };
  },

  // ── detect_tickers ────────────────────────────────────────────────────────
  // Reads from: public.stocks (ticker, company_name, sector, market_cap)
  detect_tickers: async (args: Record<string, unknown>) => {
    const { headline, body } = args as { headline: string; body: string };
    const text = `${headline} ${body}`;

    // Phase 1 — token scan against stocks.ticker
    const tokens = Array.from(
      new Set((text.match(/\b[A-Z]{1,10}\b/g) ?? []))
    );

    const { data: tickerMatches, error: tickerErr } = await supabase
      .from("stocks")
      .select("ticker, company_name, sector, market_cap")
      .in("ticker", tokens);

    if (tickerErr) logger.warn(`stocks ticker lookup error: ${tickerErr.message}`);

    // Phase 2 — company name scan against stocks.company_name
    const { data: allStocks, error: allErr } = await supabase
      .from("stocks")
      .select("ticker, company_name, sector, market_cap")
      .limit(500);

    if (allErr) logger.warn(`stocks full lookup error: ${allErr.message}`);

    const upperText = text.toUpperCase();
    const companyMatches: StockRecord[] = [];

    for (const stock of allStocks ?? []) {
      const alreadyFound = tickerMatches?.some((m) => m.ticker === stock.ticker);
      if (!alreadyFound && upperText.includes(stock.company_name.toUpperCase())) {
        companyMatches.push(stock as StockRecord);
      }
    }

    const confirmed: StockRecord[] = [
      ...((tickerMatches ?? []) as StockRecord[]),
      ...companyMatches,
    ];

    return {
      confirmedFromDB: confirmed,
      totalFound: confirmed.length,
      note:
        "These tickers were verified against the stocks table. " +
        "For any ticker you infer from context that is NOT in this list, " +
        "call insert_ticker first, then include it in affectedTickers.",
    };
  },

  // ── insert_ticker ─────────────────────────────────────────────────────────
  // Writes to: public.stocks
  // Columns: ticker (PK), company_name, sector, market_cap
  // updated_at is handled automatically by the update_stocks_updated_at trigger
  insert_ticker: async (args: Record<string, unknown>) => {
    const { ticker, company_name, sector, market_cap } = args as {
      ticker:       string;
      company_name: string;
      sector?:      string;
      market_cap?:  number;
    };

    const sanitizedTicker = ticker.toUpperCase().trim().slice(0, 10);

    const { data, error } = await supabase
      .from("stocks")
      .upsert(
        {
          ticker:       sanitizedTicker,
          company_name: company_name.trim(),
          sector:       sector ?? null,
          market_cap:   market_cap ?? null,
        },
        { onConflict: "ticker", ignoreDuplicates: false }
      )
      .select()
      .single();

    if (error) return { inserted: false, reason: error.message };

    logger.info(`New ticker saved: ${sanitizedTicker} — ${company_name}`);
    return { inserted: true, record: data };
  },

  // ── check_news_in_database ────────────────────────────────────────────────
  // Reads from: public.articles
  // Queries against articles.id and articles.title (NOT `headline` — that column doesn't exist)
  check_news_in_database: async (args: Record<string, unknown>) => {
    const { newsId, headline } = args as { newsId: string; headline: string };

    // Exact ID check
    const { data: byId } = await supabase
      .from("articles")
      .select("id, title, published_at")
      .eq("id", newsId)
      .maybeSingle();

    if (byId) return { exists: true, match: byId };

    // Fuzzy title match — articles.title is the equivalent of NewsObject.headline
    const snippet = headline.slice(0, 60);
    const { data: byTitle } = await supabase
      .from("articles")
      .select("id, title, published_at")
      .ilike("title", `%${snippet}%`)   // FIX: was .ilike("headline") — column is `title`
      .limit(1);

    const match = byTitle?.[0] ?? null;
    return { exists: !!match, match };
  },

  // ── save_news_to_database ─────────────────────────────────────────────────
  // Writes to: public.articles + public.article_stocks
  //
  // articles columns used:
  //   title        ← news.headline  (NOT a `headline` column — doesn't exist)
  //   content      ← news.body      (NOT a `body` column — doesn't exist)
  //   source, url, published_at, category, metadata, tickers, scraped_at, analyzed_at
  //
  // BUG 6 FIX: analyzed_at was never set — now written on first analysis.
  // BUG 4 FIX: article_stocks junction table now populated after article insert.
  save_news_to_database: async (args: Record<string, unknown>) => {
    const { news, tickers } = args as { news: NewsObject; tickers: string[] };
    const now = new Date().toISOString();

    const { data: article, error } = await supabase
      .from("articles")
      .insert({
        title:        news.headline,   // articles.title  ← NewsObject.headline
        content:      news.body,       // articles.content ← NewsObject.body
        source:       news.source,
        url:          news.url,
        published_at: news.publishedAt,
        category:     news.category ?? null,
        metadata:     news.metadata ?? {},
        tickers,
        scraped_at:   now,
        analyzed_at:  now,             // BUG 6 FIX: column exists in schema, was never set
      })
      .select("id, title, url")
      .single();

    if (error) {
      if (error.code === "23505") return { saved: false, reason: "duplicate", articleId: null };
      throw new Error(`articles insert error: ${error.message}`);
    }

    // BUG 4 FIX: populate article_stocks junction table
    // Schema: article_stocks(article_id FK→articles, ticker FK→stocks, confidence, trend, impact_level, explanation)
    if (article && tickers.length > 0) {
      const articleStockRows = tickers.map((ticker) => ({
        article_id:   article.id,
        ticker,
        confidence:   70,             // default — will be refined by Gemini's analysis
        trend:        "neutral" as const,
        impact_level: "medium" as const,
        explanation:  "Detected via ticker/company-name scan at ingestion time.",
      }));

      const { error: asErr } = await supabase
        .from("article_stocks")
        .insert(articleStockRows);

      if (asErr) logger.warn(`article_stocks insert error: ${asErr.message}`);
    }

    return { saved: true, articleId: article?.id ?? null };
  },

  // ── fetch_related_news ────────────────────────────────────────────────────
  // Reads from: public.articles
  // BUG 1 FIX: was selecting `headline, body` — those columns DO NOT EXIST in articles.
  // Correct column names are `title` (= headline) and `content` (= body).
  fetch_related_news: async (args: Record<string, unknown>) => {
    const { tickers, excludeId } = args as { tickers: string[]; excludeId: string };
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const { data, error } = await supabase
      .from("articles")
      .select("id, title, content, source, url, published_at, tickers")
      //            ↑ BUG 1 FIX: was "id, headline, body, ..." — those columns don't exist
      .overlaps("tickers", tickers)
      .gte("published_at", sevenDaysAgo.toISOString())
      .neq("id", excludeId)
      .order("published_at", { ascending: false })
      .limit(25);

    if (error) throw new Error(`articles fetch error: ${error.message}`);

    return {
      relatedArticles: data ?? [],   // field renamed from relatedNews → relatedArticles for clarity
      count: data?.length ?? 0,
      windowDays: 7,
    };
  },

  // ── check_tweet_quota ─────────────────────────────────────────────────────
  // Reads from: public.tweet_quota
  // Schema: tweet_quota(month PK, tweets_sent, last_tweet_date, daily_tweets_sent)
  // Checks both monthly and daily limits before allowing tweet generation.
  // Monthly limit: 500 tweets/month (Twitter Premium)
  // Daily limit:   50 tweets/day   (Twitter Premium)
  check_tweet_quota: async (_args: Record<string, unknown>) => {
    const MONTHLY_LIMIT = 180;  // 6/day × 30 days
    const DAILY_LIMIT   = 6;    // max 6 main tweets per day — replies and quote tweets excluded

    const now        = new Date();
    const monthKey   = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const todayKey   = now.toISOString().slice(0, 10); // "YYYY-MM-DD"

    const { data, error } = await supabase
      .from("tweet_quota")
      .select("month, tweets_sent, last_tweet_date, daily_tweets_sent")
      .eq("month", monthKey)
      .maybeSingle();

    if (error) {
      logger.warn(`tweet_quota read error: ${error.message}`);
      // Fail open — don't block tweet generation on a DB read error
      return { allowed: true, reason: "quota_read_error_fail_open", monthKey, todayKey };
    }

    // No row yet for this month → quota is fresh
    if (!data) {
      return {
        allowed:          true,
        reason:           "new_month",
        monthKey,
        todayKey,
        tweets_sent:      0,
        daily_tweets_sent: 0,
        monthly_remaining: MONTHLY_LIMIT,
        daily_remaining:   DAILY_LIMIT,
      };
    }

    // Reset daily counter if last_tweet_date is not today
    const effectiveDailyCount =
      data.last_tweet_date === todayKey ? data.daily_tweets_sent : 0;

    const monthlyRemaining = MONTHLY_LIMIT - data.tweets_sent;
    const dailyRemaining   = DAILY_LIMIT   - effectiveDailyCount;

    if (data.tweets_sent >= MONTHLY_LIMIT) {
      return {
        allowed:           false,
        reason:            "monthly_limit_reached",
        monthKey,
        tweets_sent:       data.tweets_sent,
        monthly_remaining: 0,
        daily_remaining:   dailyRemaining,
      };
    }

    if (effectiveDailyCount >= DAILY_LIMIT) {
      return {
        allowed:           false,
        reason:            "daily_limit_reached",
        todayKey,
        daily_tweets_sent: effectiveDailyCount,
        monthly_remaining: monthlyRemaining,
        daily_remaining:   0,
      };
    }

    return {
      allowed:           true,
      reason:            "within_limits",
      monthKey,
      todayKey,
      tweets_sent:       data.tweets_sent,
      daily_tweets_sent: effectiveDailyCount,
      monthly_remaining: monthlyRemaining,
      daily_remaining:   dailyRemaining,
    };
  },

  // ── post_tweet ────────────────────────────────────────────────────────────
  // Posts a main tweet via Twitter API v2 with OAuth 1.0a signing.
  // is_main_tweet=true → counts toward the 6/day quota.
  // is_main_tweet=false (quote tweet) → does NOT count toward quota.
  // quote_tweet_id → makes this a quote tweet of the referenced tweet.
  post_tweet: async (args: Record<string, unknown>) => {
    const { text, quote_tweet_id, is_main_tweet } = args as {
      text:             string;
      quote_tweet_id?:  string;   // ID of tweet to quote — omit for main tweet
      is_main_tweet?:   boolean;  // true = counts toward 6/day limit
    };

    const authHeader = twitterOAuth.toHeader(
      twitterOAuth.authorize({ url: TWEETS_URL, method: "POST" }, twitterToken)
    );

    const body: Record<string, unknown> = { text };
    if (quote_tweet_id) body.quote_tweet_id = quote_tweet_id;

    let tweetId: string;
    try {
      const response = await axios.post(TWEETS_URL, body, {
        headers: {
          Authorization:  authHeader["Authorization"],
          "Content-Type": "application/json",
          Accept:         "application/json",
        },
      });
      tweetId = response.data.data.id as string;
    } catch (err: unknown) {
      const reason = axios.isAxiosError(err)
        ? `${err.response?.status} ${JSON.stringify(err.response?.data)}`
        : String(err);
      logger.error(`Twitter post error: ${reason}`);
      return { posted: false, reason };
    }

    const tweetUrl = `https://twitter.com/i/web/status/${tweetId}`;
    logger.info(`✅ Tweet posted: ${tweetUrl}`);

    // Auto-like immediately — fire and forget, never blocks the pipeline
    likeTweet(tweetId);

    // Only update quota for main tweets — replies and quote tweets excluded
    if (is_main_tweet) {
      const now      = new Date();
      const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const todayKey = now.toISOString().slice(0, 10);

      const { data: currentQuota } = await supabase
        .from("tweet_quota")
        .select("tweets_sent, last_tweet_date, daily_tweets_sent")
        .eq("month", monthKey)
        .maybeSingle();

      const isNewDay        = currentQuota?.last_tweet_date !== todayKey;
      const newMonthlyTotal = (currentQuota?.tweets_sent     ?? 0) + 1;
      const newDailyTotal   = isNewDay ? 1 : (currentQuota?.daily_tweets_sent ?? 0) + 1;

      const { error: quotaErr } = await supabase
        .from("tweet_quota")
        .upsert(
          { month: monthKey, tweets_sent: newMonthlyTotal,
            last_tweet_date: todayKey, daily_tweets_sent: newDailyTotal,
            updated_at: now.toISOString() },
          { onConflict: "month" }
        );

      if (quotaErr) logger.warn(`tweet_quota update error: ${quotaErr.message}`);
    }

    return { posted: true, tweetId, tweetUrl };
  },

  // ── post_reply ────────────────────────────────────────────────────────────
  // Posts a reply to a tweet. Used to post the article URL as the first
  // reply to the main tweet — keeps the main tweet clean (plain text only).
  // Does NOT count toward the daily quota.
  post_reply: async (args: Record<string, unknown>) => {
    const { text, reply_to_tweet_id } = args as {
      text:               string;
      reply_to_tweet_id:  string;  // ID of the tweet to reply to
    };

    const authHeader = twitterOAuth.toHeader(
      twitterOAuth.authorize({ url: TWEETS_URL, method: "POST" }, twitterToken)
    );

    let tweetId: string;
    try {
      const response = await axios.post(
        TWEETS_URL,
        { text, reply: { in_reply_to_tweet_id: reply_to_tweet_id } },
        {
          headers: {
            Authorization:  authHeader["Authorization"],
            "Content-Type": "application/json",
            Accept:         "application/json",
          },
        }
      );
      tweetId = response.data.data.id as string;
    } catch (err: unknown) {
      const reason = axios.isAxiosError(err)
        ? `${err.response?.status} ${JSON.stringify(err.response?.data)}`
        : String(err);
      logger.error(`Twitter reply error: ${reason}`);
      return { posted: false, reason };
    }

    const replyUrl = `https://twitter.com/i/web/status/${tweetId}`;
    logger.info(`✅ Reply posted: ${replyUrl}`);

    // Auto-like immediately — fire and forget
    likeTweet(tweetId);

    return { posted: true, tweetId, replyUrl };
  },

  // ── check_tweet_metrics ───────────────────────────────────────────────────
  // Waits 20 minutes then fetches impression count for the main tweet.
  // Uses non_public_metrics which requires OAuth 1.0a user context — only
  // works for tweets owned by the authenticated account.
  // Returns { impressions, meetsThreshold } where threshold is 100.
  check_tweet_metrics: async (args: Record<string, unknown>) => {
    const { tweet_id } = args as { tweet_id: string };
    const IMPRESSION_THRESHOLD = 100;
    const WAIT_MINUTES         = 20;

    logger.info(`⏳ Waiting ${WAIT_MINUTES} min before checking tweet metrics...`);
    await new Promise<void>((resolve) =>
      setTimeout(resolve, WAIT_MINUTES * 60 * 1000)
    );

    const metricsUrl = `https://api.twitter.com/2/tweets/${tweet_id}?tweet.fields=non_public_metrics`;
    const authHeader = twitterOAuth.toHeader(
      twitterOAuth.authorize({ url: metricsUrl, method: "GET" }, twitterToken)
    );

    try {
      const response = await axios.get(metricsUrl, {
        headers: {
          Authorization: authHeader["Authorization"],
          Accept:        "application/json",
        },
      });

      const impressions: number =
        response.data?.data?.non_public_metrics?.impression_count ?? 0;

      logger.info(
        `📊 Tweet ${tweet_id} — ${impressions} impressions after ${WAIT_MINUTES} min ` +
        `(threshold: ${IMPRESSION_THRESHOLD})`
      );

      return {
        impressions,
        meetsThreshold: impressions >= IMPRESSION_THRESHOLD,
        threshold:      IMPRESSION_THRESHOLD,
        waitMinutes:    WAIT_MINUTES,
      };
    } catch (err: unknown) {
      const reason = axios.isAxiosError(err)
        ? `${err.response?.status} ${JSON.stringify(err.response?.data)}`
        : String(err);
      logger.error(`Metrics fetch error: ${reason}`);
      // Fail open — if metrics are unavailable, do not post quote tweet
      return { impressions: 0, meetsThreshold: false, reason };
    }
  },

  // ── like_tweet ────────────────────────────────────────────────────────────
  // Likes a tweet on behalf of the authenticated account.
  // Called automatically after every successful post — main tweet, reply,
  // and quote tweet. Liking your own posts signals engagement to the Twitter
  // algorithm and improves initial reach.
  //
  // Endpoint: POST /2/users/:userId/likes
  // Requires: tweet.write + like.write OAuth 1.0a user context scopes.
  // userId must be the numeric Twitter user ID of the authenticated account —
  // set TWITTER_USER_ID in your .env.
  like_tweet: async (args: Record<string, unknown>) => {
    const { tweet_id } = args as { tweet_id: string };

    if (!config.twitter_user_id) {
      logger.warn("TWITTER_USER_ID not set — skipping auto-like");
      return { liked: false, reason: "TWITTER_USER_ID not configured" };
    }

    const likeUrl = `https://api.twitter.com/2/users/${config.twitter_user_id}/likes`;
    const authHeader = twitterOAuth.toHeader(
      twitterOAuth.authorize({ url: likeUrl, method: "POST" }, twitterToken)
    );

    try {
      await axios.post(
        likeUrl,
        { tweet_id },
        {
          headers: {
            Authorization:  authHeader["Authorization"],
            "Content-Type": "application/json",
            Accept:         "application/json",
          },
        }
      );
      logger.info(`❤️  Liked tweet: ${tweet_id}`);
      return { liked: true, tweetId: tweet_id };
    } catch (err: unknown) {
      const reason = axios.isAxiosError(err)
        ? `${err.response?.status} ${JSON.stringify(err.response?.data)}`
        : String(err);
      logger.warn(`Auto-like failed for ${tweet_id}: ${reason}`);
      // Fail silently — a failed like must never crash the pipeline
      return { liked: false, reason };
    }
  },

  // ── save_analysis_result ──────────────────────────────────────────────────
  // BUG 3 FIX: analysis_results table existed in schema but was NEVER written to.
  // BUG 5 FIX: article_relationships table existed but was NEVER written to.
  //
  // Writes to: public.analysis_results
  //   Columns: article_id (FK→articles.id), affected_tickers, new_tickers_inserted,
  //            contradiction_score/label/summary, alignment_score/label/summary,
  //            boosted_impact_score, market_prediction, market_confidence,
  //            market_reasoning, tweet  ← stores tweet1 only (tweet2 not persisted per spec)
  //
  // Writes to: public.article_relationships (one row per related article pair)
  //   Columns: article_id_a (FK→articles), article_id_b (FK→articles),
  //            relationship_type ("contradiction"|"alignment"), score, label, summary
  save_analysis_result: async (args: Record<string, unknown>) => {
    const {
      articleId,
      affectedTickers,
      newTickersInserted,
      contradiction,
      alignment,
      marketImpact,
      tweet1,           // only tweet1 is persisted — tweet2 is API-response only
      relatedArticleIds,
      relationshipType,
      relationshipScore,
      relationshipLabel,
      relationshipSummary,
    } = args as {
      articleId:           string;
      affectedTickers:     string[];
      newTickersInserted:  string[];
      contradiction:       { score: number; label: string; summary: string } | null;
      alignment:           { score: number; label: string; summary: string; boostedImpactScore: number } | null;
      marketImpact:        { prediction: string; confidence: number; reasoning: string };
      tweet1:              string;
      relatedArticleIds:   string[];
      relationshipType:    "contradiction" | "alignment" | null;
      relationshipScore:   number | null;
      relationshipLabel:   string | null;
      relationshipSummary: string | null;
    };

    // ── Write to analysis_results ──────────────────────────────────────────
    const { data: analysisRow, error: arErr } = await supabase
      .from("analysis_results")
      .insert({
        article_id:             articleId,
        affected_tickers:       affectedTickers,
        new_tickers_inserted:   newTickersInserted,
        // Contradiction columns (all nullable in schema)
        contradiction_score:    contradiction?.score   ?? null,
        contradiction_label:    contradiction?.label   ?? null,
        contradiction_summary:  contradiction?.summary ?? null,
        // Alignment columns (all nullable in schema)
        alignment_score:        alignment?.score              ?? null,
        alignment_label:        alignment?.label              ?? null,
        alignment_summary:      alignment?.summary            ?? null,
        boosted_impact_score:   alignment?.boostedImpactScore ?? null,
        // Market impact (all NOT NULL in schema)
        market_prediction:      marketImpact.prediction,
        market_confidence:      marketImpact.confidence,
        market_reasoning:       marketImpact.reasoning,
        tweet:                  tweet1,   // analysis_results.tweet stores tweet1 only
      })
      .select("id")
      .single();

    if (arErr) {
      // article_id has a UNIQUE constraint — skip silently if already analyzed
      if (arErr.code === "23505") {
        logger.warn("analysis_results: duplicate article_id, skipping.");
      } else {
        throw new Error(`analysis_results insert error: ${arErr.message}`);
      }
    }

    // ── Write to article_relationships (BUG 5 FIX) ────────────────────────
    // relationship_type is constrained to: 'contradiction' | 'alignment'
    if (relationshipType && relatedArticleIds.length > 0 && relationshipScore !== null) {
      const relationshipRows = relatedArticleIds.map((relatedId) => ({
        article_id_a:      articleId,
        article_id_b:      relatedId,
        relationship_type: relationshipType,
        score:             relationshipScore,
        label:             relationshipLabel ?? scoreToLabel(relationshipScore),
        summary:           relationshipSummary ?? null,
      }));

      const { error: relErr } = await supabase
        .from("article_relationships")
        .insert(relationshipRows);

      if (relErr) logger.warn(`article_relationships insert error: ${relErr.message}`);
    }

    return {
      saved:                true,
      analysisResultId:     analysisRow?.id ?? null,
      relationshipsWritten: relatedArticleIds.length,
    };
  },
};

// ─────────────────────────────────────────────
// GEMINI TOOL DECLARATIONS
// ─────────────────────────────────────────────

const tools: Tool = {
  functionDeclarations: [
    {
      name: "scan_ticker_volatility",
      description:
        "Fetches volatility metrics for tickers from Yahoo Finance and returns a gate decision. " +
        "MUST be called first in STEP 1 before detect_tickers. " +
        "If gate=SKIP: set signalQuality=LOW, skip all remaining steps except STEP 8. " +
        "Returns per-ticker HV30, ATR14%, IV proxy, VIX level, and gate: PROCEED | SKIP.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          tickers: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description:
              "Tickers to scan. Use candidateTickers from metadata as starting point. " +
              "Include the most likely affected tickers based on the news headline.",
          },
        },
        required: ["tickers"],
      },
    },
    {
      name: "detect_tickers",
      description:
        "Detect stock tickers by querying the stocks table in two phases: " +
        "Phase 1 matches uppercase word-tokens against ticker symbols; " +
        "Phase 2 scans for known company names. Returns verified DB records.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          headline: { type: Type.STRING, description: "The news headline." },
          body:     { type: Type.STRING, description: "The full news body text." },
        },
        required: ["headline", "body"],
      },
    },
    {
      name: "insert_ticker",
      description:
        "Insert a new ticker into the stocks table when Gemini infers one not present in the DB. " +
        "Always call this before using any inferred ticker in the final result. " +
        "Uses upsert — safe to call even if the ticker already exists.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          ticker:       { type: Type.STRING, description: "Ticker symbol, max 10 chars uppercase. e.g. 'AAPL'" },
          company_name: { type: Type.STRING, description: "Full company name e.g. 'Apple Inc.'" },
          sector:       { type: Type.STRING, description: "Industry sector e.g. 'Technology'. Optional." },
          market_cap:   { type: Type.NUMBER, description: "Approximate market cap in USD. Optional." },
        },
        required: ["ticker", "company_name"],
      },
    },
    {
      name: "check_news_in_database",
      description:
        "Check whether this news item already exists in the articles table " +
        "by exact ID or fuzzy match on articles.title (equivalent to the news headline).",
      parameters: {
        type: Type.OBJECT,
        properties: {
          newsId:   { type: Type.STRING, description: "The news ID to look up." },
          headline: { type: Type.STRING, description: "Headline to fuzzy-match against articles.title." },
        },
        required: ["newsId", "headline"],
      },
    },
    {
      name: "save_news_to_database",
      description:
        "Persist the article to the articles table and populate the article_stocks junction table. " +
        "Returns the Supabase-generated articleId (UUID) — store this for save_analysis_result.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          news: {
            type: Type.OBJECT,
            description: "The full NewsObject. Its `headline` maps to articles.title, `body` maps to articles.content.",
          },
          tickers: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "All confirmed and inferred ticker symbols.",
          },
        },
        required: ["news", "tickers"],
      },
    },
    {
      name: "fetch_related_news",
      description:
        "Retrieve up to 25 articles from the last 7 days sharing at least one ticker. " +
        "Returns ArticleRecord objects — note fields are `title` and `content`, NOT `headline`/`body`.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          tickers: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Tickers to overlap-match against.",
          },
          excludeId: {
            type: Type.STRING,
            description: "The current article's Supabase UUID to exclude.",
          },
        },
        required: ["tickers", "excludeId"],
      },
    },
    {
      name: "check_tweet_quota",
      description:
        "Check the tweet_quota table to verify that daily and monthly tweet limits " +
        "have not been reached before generating tweets. Call this at the START of STEP 7. " +
        "If allowed is false, skip tweet generation and set tweet1/tweet2 to empty strings " +
        "with a note explaining which limit was reached.",
      parameters: {
        type: Type.OBJECT,
        properties: {},
      },
    },
    {
      name: "post_tweet",
      description:
        "Post the main tweet — plain text only, no link. " +
        "Pass is_main_tweet=true so it counts toward the 6/day quota. " +
        "Returns { posted, tweetId, tweetUrl }.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          text:          { type: Type.STRING,  description: "Plain text tweet content. No links, no formatting." },
          is_main_tweet: { type: Type.BOOLEAN, description: "Always true for the main tweet." },
        },
        required: ["text", "is_main_tweet"],
      },
    },
    {
      name: "post_reply",
      description:
        "Post a reply to the main tweet containing only the article URL. " +
        "Call immediately after post_tweet succeeds. " +
        "Does NOT count toward the daily quota. " +
        "Returns { posted, tweetId, replyUrl }.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          text:               { type: Type.STRING, description: "The article URL — nothing else." },
          reply_to_tweet_id:  { type: Type.STRING, description: "tweetId from the main tweet post_tweet result." },
        },
        required: ["text", "reply_to_tweet_id"],
      },
    },
    {
      name: "check_tweet_metrics",
      description:
        "Waits 20 minutes then fetches impression count for the main tweet. " +
        "Returns { impressions, meetsThreshold } where threshold is 100. " +
        "Call this after post_reply. If meetsThreshold=true, post the quote tweet. " +
        "If meetsThreshold=false or metrics unavailable, skip the quote tweet entirely.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          tweet_id: { type: Type.STRING, description: "tweetId from the main tweet post_tweet result." },
        },
        required: ["tweet_id"],
      },
    },
    {
      name: "like_tweet",
      description:
        "Automatically likes a tweet posted by this account. " +
        "Call after EVERY successful post — main tweet, reply, and quote tweet. " +
        "Liking your own posts signals engagement to the Twitter algorithm and " +
        "increases the chance of early distribution. " +
        "Fails silently — a failed like must never block the pipeline. " +
        "Returns { liked: boolean, tweetId }.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          tweet_id: {
            type: Type.STRING,
            description: "The tweetId of the tweet to like.",
          },
        },
        required: ["tweet_id"],
      },
    },
    {
      name: "save_analysis_result",
      description: "Persist analysis to analysis_results and article_relationships. MUST be called last.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          articleId:           { type: Type.STRING },
          affectedTickers:     { type: Type.ARRAY, items: { type: Type.STRING } },
          newTickersInserted:  { type: Type.ARRAY, items: { type: Type.STRING } },
          contradiction:       { type: Type.OBJECT, properties: { score: { type: Type.NUMBER }, label: { type: Type.STRING }, summary: { type: Type.STRING } } },
          alignment:           { type: Type.OBJECT, properties: { score: { type: Type.NUMBER }, label: { type: Type.STRING }, summary: { type: Type.STRING }, boostedImpactScore: { type: Type.NUMBER } } },
          marketImpact:        { type: Type.OBJECT, properties: { prediction: { type: Type.STRING }, confidence: { type: Type.NUMBER }, reasoning: { type: Type.STRING } }, required: ["prediction","confidence","reasoning"] },
          tweet1:              { type: Type.STRING },
          relatedArticleIds:   { type: Type.ARRAY, items: { type: Type.STRING } },
          relationshipType:    { type: Type.STRING },
          relationshipScore:   { type: Type.NUMBER },
          relationshipLabel:   { type: Type.STRING },
          relationshipSummary: { type: Type.STRING },
        },
        required: ["articleId", "affectedTickers", "newTickersInserted", "marketImpact", "tweet1", "relatedArticleIds"],
      },
    },
  ],
};

// ─────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are a financial news analysis engine with access to ELEVEN tools.

PRE-COMPUTED VALUES (read from metadata — do not recompute):
  metadata.candidateTickers      — Phase 1 ticker candidates
  metadata.articleAgeHours       — article age in hours
  metadata.isRepeatSubject       — true if same subject covered in last 24h
  metadata.repeatSubjectTickers  — which tickers triggered the repeat flag
  metadata.roughRelevanceFloor   — minimum possible relevance score
  metadata.corroboratingSourceCount
  metadata.corroboratingSources
  metadata.isMultiSourceStory

STEP 1 — VOLATILITY SCAN + TICKER DETECTION

── STEP 1A: VOLATILITY SCAN (always run first) ─────────────────────────────────
Call scan_ticker_volatility with candidateTickers from metadata.
If candidateTickers is empty, infer 2–3 tickers from the headline using the
MACRO PROXY MAPPING below before calling.

If gate = SKIP:
  The market is too quiet for this news to be tradeable.
  Set signalQuality="LOW", relevanceScore=0.
  Skip all steps except STEP 8. mainTweet="", replyTweet="", quoteTweet="".

If gate = PROCEED:
  Apply volatility boost/penalty to relevanceScore in STEP 6.5:
    Any HIGH volatility ticker  → +10
    VIX > 25                    → +10
    VIX 15–25                   → +5
    All LOW but VIX saved gate  → -5
  Continue to STEP 1B.

── STEP 1B: TICKER DETECTION ───────────────────────────────────────────────────
Call detect_tickers with headline and body.
candidateTickers from metadata is Phase 1 already done.
For tickers inferred from context not returned: call insert_ticker first.

TICKER RANKING — TOP 5 ONLY:
  1. Direct subject of the news (earnings, deal, legal, CEO change)
  2. Named counterparty (merger target, major customer, competitor)
  3. Same-sector sympathy move
  4. Macro proxies — see mapping below
  5. Tangential mentions — EXCLUDE
Use fewer than 5 if not genuinely relevant. Never pad.
Store newly inserted in newTickersInserted[].

MACRO PROXY MAPPING — use MACRO_PROXIES constant (defined in code) for macro news.
Never leave affectedTickers empty when making a trade signal.
If the macro category is not in the constant, infer the most liquid ETF proxy.

STEP 2 — DATABASE CHECK
Call check_news_in_database. URL uniqueness already verified before this run.

STEP 3a — EXISTS: alreadyInDatabase=true, record articleDbId, skip to STEP 6.
STEP 3b — NEW: save_news_to_database → articleDbId → fetch_related_news.
fetch_related_news returns { id, title, content, source, url, published_at, tickers }.

STEP 4 — CONTRADICTION ANALYSIS
Score 0–100 (0–24 Low, 25–49 Medium, 50–74 High, 75–100 Critical).
If contradictionScore > 0: populate contradiction, alignment=null.

STEP 5 — ALIGNMENT ANALYSIS (only if contradictionScore == 0)
Score 0–100. boostedImpactScore = confidence + (alignmentScore x 0.25), cap 100.

CORROBORATING SOURCES — from metadata:
Confidence boost: +8 for 2 sources, +15 for 3, +20 for 4+. Cap 100.
State: "Confidence boosted: X sources reporting."

STEP 6 — MARKET IMPACT PREDICTION
prediction: "buy" | "sell" | "hold" | "neutral"
confidence: 0–100 (apply corroboration boost)
reasoning: 1–2 sentences

STEP 6.5 — RELEVANCE SCORING + POSTING DECISION

If metadata.isRepeatSubject=true:
  → isRepeatSubject=true, relevanceScore=0, signalQuality="LOW"
  → STEP 8 only. Skip STEP 7 and STEP 9.

Otherwise, build relevanceScore starting from metadata.roughRelevanceFloor:
  +25  Concrete data point: earnings figure, rate bps, deal size, ruling, price move >= 5%
  +20  "buy"/"sell" AND confidence >= 70
  +15  contradiction >= 50
  +10  High-profile tickers: AAPL, TSLA, NVDA, MSFT, AMZN, GOOGL, META, BTC, ETH, SPY, QQQ
  -20  Rumour/speculation/opinion with no verifiable data
  -15  "hold"/"neutral" AND confidence < 50
  Cap at 100, floor at 0.

HARD RULE: if affectedTickers is empty → return to STEP 1 and resolve macro proxies.
A trade signal without tickers is not actionable and must not be posted.

REPEAT SUBJECT OVERRIDE (from relatedArticleIds):
  New data point not in related articles → keep signalQuality, add "UPDATE:" to tweet
  Same story rehashed → downgrade to LOW

POSTING THRESHOLDS:
  relevanceScore >= 80 → signalQuality="HIGH"   (post main tweet + quote if performance met)
  relevanceScore 70–79 → signalQuality="MEDIUM" (post main tweet only)
  relevanceScore < 70  → signalQuality="LOW"    (save analysis, no tweets)

STEP 7 — TWEET GENERATION
Skip if isRepeatSubject=true OR relevanceScore < 70.
Call check_tweet_quota. If allowed=false: mainTweet="", replyTweet="", quoteTweet="", skip to STEP 8.

── MAIN TWEET ──────────────────────────────────────────────────────────────────
Purpose: A high-quality trade signal backed by news sentiment.
Format: Plain text only. No asterisks, no ALL CAPS labels, no bullet points,
no SIGNAL:/VERDICT:/SOURCE: headers. Write like a smart analyst talking to
a colleague — natural sentences, no Twitter formatting tricks.

Structure:
  Opening sentence: state what happened and what it means for the market.
  Second sentence: the key number or data point that backs the signal.
  Third sentence: the directional call — buy/sell/hold — with confidence and why.
  Fourth sentence (optional): contradiction or alignment context if meaningful.
  Final line: $TICKER tags and #hashtags only — no other text on this line.

Rules:
  - Tickers as $TICKER inline in the text AND on the final line
  - Confidence score stated naturally: "with 78% confidence" not "Confidence: 78%"
  - No article URL in this tweet — link goes in the reply
  - Max 4–5 sentences before the ticker/hashtag line
  - No filler: "it is worth noting", "importantly", "in conclusion"
  - Not financial advice — add naturally at end if it fits

Example for UK rates story:
  The Bank of England is now expected to hold rates at 3.75% through mid-2026,
  with markets pricing in a potential hike to 4.0% by June as oil above $100
  feeds directly into UK inflation. This is a meaningful shift from the rate cut
  cycle priced just weeks ago. Sell signal on UK equities with 70% confidence —
  rising rates and geopolitical inflation pressure are a direct headwind for
  margins and valuations. Worth watching closely.

  $EWU $HSBA $LLOY $BARC #BankOfEngland #UKMarkets #RateDecision #Stagflation

── REPLY TWEET (link only) ─────────────────────────────────────────────────────
Content: The article URL and nothing else.
This is the first reply to the main tweet — keeps the main tweet clean.
replyTweet = the full article URL as a bare string.

── QUOTE TWEET (HIGH signals only, posted based on 20min performance) ──────────
Purpose: Engagement hook that pulls people into the main tweet.
Format: 2–3 short sentences. No formatting. Conversational. No labels.

Structure:
  Hook sentence: counterintuitive statement, sharp question, or tension.
  1–2 follow-up sentences: the sharpest signal or what makes this different.
  Final sentence: directional pull — "Full breakdown below" with $TICKER and hashtags.

Rules:
  - No ALL CAPS except $TICKER
  - No bullet points
  - No article URL — the link is already in the reply
  - Short and punchy — this is what gets retweeted

ANTI-HALLUCINATION RULES — apply throughout every step:

NUMBERS AND DATA:
- Every figure in mainTweet and quoteTweet MUST appear verbatim in the article body.
- Do NOT round, estimate, or paraphrase numbers. If the body says "$94.9B" write "$94.9B".
- Do NOT extrapolate: "revenues grew 15% so next quarter could be..." is fabrication.
- If no concrete number exists in the article, do not invent one to fill the tweet.
- Confidence scores are your assessment of market direction — not invented statistics.

TICKERS:
- Only include tickers that were returned by detect_tickers, inserted via insert_ticker,
  or are from the MACRO PROXY MAPPING table.
- Do NOT invent ticker symbols. "UKBO", "BOEQ", "OILX" are not real tickers.
- If you are unsure whether a symbol exists, call insert_ticker to verify — if it
  fails the upsert, the ticker is invalid.

MARKET PREDICTIONS:
- prediction and confidence must be grounded in the article content.
- Do NOT cite analyst forecasts, price targets, or external data not in the article body.
- If the article is ambiguous, use "neutral" with low confidence — do not fabricate conviction.
- reasoning must quote or directly reference a specific claim from the article.

TWEET CONTENT:
- Every factual claim in mainTweet must trace back to a sentence in the article body.
- If you cannot point to the source sentence, remove the claim.
- quoteTweet hooks must be based on the actual signal, not invented drama.
- Do NOT write "analysts say", "markets expect", "sources suggest" unless the article
  itself contains those exact claims from named sources.

STEP 8 — PERSIST ANALYSIS (MANDATORY — always run, even for repeat subjects)
Call save_analysis_result: articleId, affectedTickers, newTickersInserted,
contradiction or null, alignment or null, marketImpact, mainTweet (stored as tweet),
relatedArticleIds, relationshipType, relationshipScore, relationshipLabel, relationshipSummary.

STEP 9 — TWEET POSTING
Skip entirely if isRepeatSubject=true OR relevanceScore < 70.

CRITICAL: NEVER fabricate any post result. Call each tool and WAIT for its response.
Copy EXACT values returned — never invent tweetId, tweetUrl, or any field.

── POST MAIN TWEET ─────────────────────────────────────────────────────────────
Call post_tweet({ text: mainTweet, is_main_tweet: true }).
Wait for response. Store tweetId as mainTweetId.

── POST LINK REPLY ─────────────────────────────────────────────────────────────
Call post_reply({ text: replyTweet, reply_to_tweet_id: mainTweetId }).
Wait for response. Store result as replyPostResult.

── CHECK PERFORMANCE (HIGH signals only) ────────────────────────────────────────
If signalQuality="HIGH" AND mainTweet posted successfully:
  Call check_tweet_metrics({ tweet_id: mainTweetId }).
  The tool waits 20 minutes then returns { impressions, meetsThreshold }.
  Store impressions as mainTweetImpressions.

  If meetsThreshold=true (impressions > 100):
    Call post_tweet({ text: quoteTweet, quote_tweet_id: mainTweetId, is_main_tweet: false }).
    Store result as quoteTweetPostResult.
  If meetsThreshold=false:
    quoteTweetPostResult = null.

If mainTweet failed to post: skip reply and quote tweet entirely.

RULES:
- Never skip check_tweet_quota or save_analysis_result.
- affectedTickers: max 5, ranked. Never empty when making a trade signal.
- isRepeatSubject=true → save always, post never.
- relevanceScore < 70 → save only. 70–79 → main tweet only. >= 80 → main + performance-based quote.
- Quote tweet only posts if impressions > 100 in 20 minutes — never post it unconditionally.
- Every number in a tweet must exist verbatim in the article body — never invent figures.
- Every ticker must be verified via detect_tickers or the MACRO PROXY MAPPING — never invent symbols.
- Every factual claim must trace to a specific sentence in the article body — no extrapolation.
- Return ONLY valid JSON. No markdown. No preamble.
{
  "newsId": string, "articleDbId": string, "alreadyInDatabase": boolean,
  "volatilityGate": "PROCEED"|"SKIP", "vixLevel": number, "vixContext": "HIGH"|"ELEVATED"|"LOW",
  "affectedTickers": string[], "newTickersInserted": string[],
  "relevanceScore": number, "signalQuality": "HIGH"|"MEDIUM"|"LOW",
  "isRepeatSubject": boolean,
  "contradiction": { "score": number, "label": "Low"|"Medium"|"High"|"Critical", "contradictingArticles": ArticleRecord[], "summary": string } | null,
  "alignment": { "score": number, "label": "Low"|"Medium"|"High"|"Critical", "aligningArticles": ArticleRecord[], "boostedImpactScore": number, "summary": string } | null,
  "marketImpact": { "prediction": "buy"|"sell"|"hold"|"neutral", "confidence": number, "reasoning": string },
  "mainTweet": string, "replyTweet": string, "quoteTweet": string,
  "mainTweetPostResult": { "posted": boolean, "tweetId"?: string, "tweetUrl"?: string, "reason"?: string },
  "replyPostResult": { "posted": boolean, "tweetId"?: string, "replyUrl"?: string, "reason"?: string },
  "quoteTweetPostResult": { "posted": boolean, "tweetId"?: string, "tweetUrl"?: string, "reason"?: string } | null,
  "mainTweetImpressions": number
}
`;

// ─────────────────────────────────────────────
// MAIN ANALYSIS FUNCTION
// ─────────────────────────────────────────────

export async function analyzeNews(news: NewsObject): Promise<AnalysisResult> {

  if (!config.gemini_api_key) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  const genAI = new GoogleGenAI({ apiKey: config.gemini_api_key });

  const chat = genAI.chats.create({
    model: GEMINI_MODEL,
    config: {
      tools: [tools],
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    },
  });

  // ── PostHog run-level accumulators ────────────────────────────────────────
  let phInputTokens  = 0;
  let phOutputTokens = 0;
  let phTurnCount    = 0;
  const phToolCalls: string[] = [];
  const phTraceId = `news-${news.id}-${Date.now()}`;

  // Wraps sendMessage with rate limiting + PostHog token accumulation
  const send = async (msgPayload: Parameters<typeof chat.sendMessage>[0]) => {
    const res = await rateLimitedSend(() => chat.sendMessage(msgPayload));

    const usage = (res as Record<string, any>).usageMetadata as
      { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
    phInputTokens  += usage?.promptTokenCount     ?? 0;
    phOutputTokens += usage?.candidatesTokenCount ?? 0;
    phTurnCount    += 1;

    return res;
  };

  let response = await send({
    message: `Analyze this news object:\n${JSON.stringify(news, null, 2)}`,
  });

  // ── Agentic loop ──────────────────────────────────────────────────────────
  while (true) {
    const candidate = response.candidates?.[0];
    if (!candidate) throw new Error("Gemini returned no candidate.");

    const parts: Part[] | undefined = candidate.content?.parts;
    if (!parts) throw new Error("Gemini returned no parts.");

    const functionCallParts = parts.filter((p) => p.functionCall);

    if (functionCallParts.length === 0) {
      // No function calls — Gemini is done, parse final JSON
      const rawText = parts.find((p) => p.text)?.text ?? "";
      const cleaned = rawText.replace(/```json|```/gi, "").trim();

      let result: AnalysisResult;
      try {
        result = JSON.parse(cleaned);
      } catch {
        throw new Error(`Failed to parse Gemini final JSON:\n${rawText}`);
      }

      // Enforce correct score labels regardless of what Gemini produced
      if (result.contradiction) {
        result.contradiction.label = scoreToLabel(result.contradiction.score);
      }
      if (result.alignment) {
        result.alignment.label = scoreToLabel(result.alignment.score);
        result.alignment.boostedImpactScore = Math.min(100, result.alignment.boostedImpactScore);
      }

      result.newTickersInserted    = result.newTickersInserted    ?? [];
      result.volatilityGate        = result.volatilityGate        ?? "SKIP";
      result.vixLevel              = result.vixLevel              ?? 0;
      result.vixContext            = result.vixContext            ?? "LOW";
      result.relevanceScore        = result.relevanceScore        ?? 0;
      result.signalQuality         = result.signalQuality         ?? "LOW";
      result.isRepeatSubject       = result.isRepeatSubject       ?? false;
      result.mainTweet             = result.mainTweet             ?? "";
      result.replyTweet            = result.replyTweet            ?? "";
      result.quoteTweet            = result.quoteTweet            ?? "";
      result.mainTweetPostResult   = result.mainTweetPostResult   ?? { posted: false, reason: "not_attempted" };
      result.replyPostResult       = result.replyPostResult       ?? { posted: false, reason: "not_attempted" };
      result.quoteTweetPostResult  = result.quoteTweetPostResult  ?? null;
      result.mainTweetImpressions  = result.mainTweetImpressions  ?? 0;
      
      // ! TODO: comeback and talk about this 
      // result.tweet1              = result.tweet1              ?? "";
      // result.tweet2              = result.tweet2              ?? "";
      // result.tweet1PostResult    = result.tweet1PostResult    ?? { posted: false, reason: "not_attempted" };
      // result.tweet2PostResult    = result.tweet2PostResult    ?? null;
      // result.tweet2AlgoDecision  = result.tweet2AlgoDecision  ?? "";

      // ── Fire PostHog summary event for this analysis run ────────────────
      // One event per article — captures full token usage, cost estimate,
      // tool call sequence, and outcome so you can track spend in PostHog.
      const estimatedCostUsd =
        (phInputTokens  / 1_000_000) * 0.30 +   // $0.30 per M input tokens
        (phOutputTokens / 1_000_000) * 2.50;     // $2.50 per M output tokens

      phClient.capture({
        distinctId:  `news-analyzer`,
        event:       "$ai_generation",
        properties: {
          // Standard PostHog AI properties
          $ai_trace_id:       phTraceId,
          $ai_model:          GEMINI_MODEL,
          $ai_provider:       "google",
          $ai_input_tokens:   phInputTokens,
          $ai_output_tokens:  phOutputTokens,
          $ai_total_tokens:   phInputTokens + phOutputTokens,
          // Custom properties for your dashboard
          news_id:            news.id,
          news_source:        news.source,
          news_category:      news.category ?? null,
          affected_tickers:   result.affectedTickers,
          market_prediction:  result.marketImpact.prediction,
          confidence:         result.marketImpact.confidence,
          turn_count:         phTurnCount,
          tool_calls:         phToolCalls,
          tweet1_posted:      result.mainTweetPostResult.posted,
          tweet2_posted:      result.replyPostResult?.posted ?? false,
          tweet2_skipped:     result.replyPostResult === null,
          already_in_db:      result.alreadyInDatabase,
          estimated_cost_usd: parseFloat(estimatedCostUsd.toFixed(6)),
        },
      });

      // Flush async — don't block the return
      phClient.flush().catch((e) =>
        logger.warn(`PostHog flush error: ${e}`)
      );

      return result;
    }

    // Execute tool calls and return results to Gemini
    const toolResults = await Promise.all(
      functionCallParts.map(async (part) => {
        const { name, args } = part.functionCall!;
        if (!name) throw new Error("Tool call had no name.");

        logger.info(`🔧 Tool call → ${name}`);
        logger.debug(`   Args: ${JSON.stringify(args, null, 2)}`);

        // Track tool call sequence for PostHog
        phToolCalls.push(name);

        const impl = toolImplementations[name];
        if (!impl) throw new Error(`No implementation for tool: ${name}`);

        const toolResult = await impl(args as Record<string, unknown>);
        logger.debug(`   ✅ Result: ${JSON.stringify(toolResult, null, 2)}`);

        return {
          functionResponse: { name, response: toolResult },
        } as Part;
      })
    );

    response = await send({ message: toolResults });
  }
}

// ─────────────────────────────────────────────
// EXAMPLE USAGE
// ─────────────────────────────────────────────

export async function main() {
  const exampleNews: NewsObject = {
    id: "news-20240315-001",
    headline: "Apple beats Q2 estimates with $94.9B revenue; announces $90B buyback",
    body: `Apple Inc. reported second-quarter revenue of $94.9 billion on Tuesday,
           surpassing Wall Street expectations of $92.1 billion. CEO Tim Cook cited
           record iPhone 15 sales in India and double-digit Services growth as key
           drivers. The company also announced a $90 billion share repurchase program,
           the largest in Apple history. EPS came in at $1.53 vs $1.43 expected.`,
    source: "Reuters",
    url: "https://reuters.com/technology/apple-q2-2024-earnings",
    publishedAt: new Date().toISOString(),
    category: "earnings",
    metadata: { sentiment: "positive", region: "US", sector: "Technology" },
  };

  logger.info(`📰 Analyzing news: ${exampleNews.headline}`);

  try {
    const result = await analyzeNews(exampleNews);
    logger.info(`📊 ANALYSIS COMPLETE\n${JSON.stringify(result, null, 2)}`);

    // Tweet 1 post result
    if (result.mainTweetPostResult.posted) {
      logger.info(`✅ Tweet 1 posted: ${result.mainTweetPostResult.tweetUrl}`);
    } else {
      logger.warn(`⚠️  Tweet 1 not posted: ${result.mainTweetPostResult.reason}`);
    }

    // Tweet 2 algo decision + post result
    // logger.info(`🤖 Tweet 2 algo decision: ${result.tweet2AlgoDecision}`);
    if (result.quoteTweetPostResult === null) {
      logger.info(`⏭️  Tweet 2 skipped (low engagement potential)`);
    } else if (result.quoteTweetPostResult?.posted) {
      logger.info(`✅ Tweet 2 posted after ${result.quoteTweetPostResult.delayMinutes} min: ${result.quoteTweetPostResult.tweetUrl}`);
    } else {
      logger.warn(`❌ Tweet 2 failed: ${result.quoteTweetPostResult?.reason}`);
    }

    if (result.newTickersInserted.length > 0) {
      logger.info(`📝 New tickers added to stocks DB: ${result.newTickersInserted}`);
    }
  } catch (err) {
    logger.error(`❌ Analysis failed: ${err}`);
    process.exit(1);
  }
}