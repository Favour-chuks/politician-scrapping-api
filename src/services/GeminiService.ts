import { PostHog } from 'posthog-node'
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
  category?: string;
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
  affectedTickers: string[];
  newTickersInserted: string[];
  contradiction: ContradictionResult | null;
  alignment: AlignmentResult | null;
  marketImpact: MarketImpact;
  /**
   * Tweet 1 — data/analysis post (main tweet).
   * Contains: tickers, market prediction + confidence, contradiction/alignment
   * signal + score, source name, news URL, hashtags. Signal emojis (📈📉⚡⚠️).
   * Stored in analysis_results.tweet in the DB.
   */
  tweet1: string;
  /**
   * Tweet 2 — opinion/take (quote-tweet of tweet1).
   * Gemini's human, conversational interpretation of the news and its market
   * implications. NOT stored in DB — returned in API response only.
   */
  tweet2: string;
  /** Result of posting tweet1 to Twitter. Populated after STEP 9. */
  tweet1PostResult: TweetPostResult;
  /**
   * Result of posting tweet2 as a quote-tweet.
   * null  → Gemini decided the content wouldn't perform well, skipped entirely.
   * object with posted:false → Gemini tried but it failed after retries.
   */
  tweet2PostResult: TweetPostResult | null;
  /** Gemini's reasoning for whether tweet2 was worth posting. */
  tweet2AlgoDecision: string;
}

/** Result of a single tweet post attempt via the Twitter API */
export interface TweetPostResult {
  posted:        boolean;
  tweetId?:      string;   // Twitter's assigned ID — needed for quote-tweet chaining
  tweetUrl?:     string;   // https://twitter.com/i/web/status/<id>
  reason?:       string;   // populated when posted === false
  delayMinutes?: number;   // how long the tool waited before posting (tweet2 only)
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
 

// ─────────────────────────────────────────────
// SUPABASE CLIENT
// ─────────────────────────────────────────────

const supabase = createClient(
  config.supabase_url!,
  config.supabase_service_role_key!
);

// ─────────────────────────────────────────────
// TOOL IMPLEMENTATIONS
// ─────────────────────────────────────────────

const toolImplementations: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {

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
    const MONTHLY_LIMIT = 500;
    const DAILY_LIMIT   = 50;

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
  // Posts a tweet via Twitter API v2 with OAuth 1.0a signing (oauth-1.0a + axios).
  //
  // For tweet2 (quote-tweet): Gemini passes delay_minutes (3–12, randomised).
  // The tool sleeps for that duration BEFORE posting — the delay happens
  // server-side so no external scheduler is needed.
  // ⚠️  NOTE: analyzeNews() blocks for the delay duration. Fine for a background
  // worker — set your HTTP timeout accordingly if called via a web API.
  //
  // After a successful post, tweet_quota is incremented in Supabase.
  post_tweet: async (args: Record<string, unknown>) => {
    const { text, quote_tweet_id, delay_minutes } = args as {
      text:            string;
      quote_tweet_id?: string;  // tweet1's Twitter ID — only present for tweet2
      delay_minutes?:  number;  // Gemini chooses 3–12, randomised per call
    };
 
    // ── Optional delay before posting (tweet2 only) ────────────────────────
    if (delay_minutes && delay_minutes > 0) {
      logger.info(`⏳ Waiting ${delay_minutes} min before posting quote-tweet...`);
      await new Promise<void>((resolve) =>
        setTimeout(resolve, delay_minutes * 60 * 1000)
      );
    }
 
    // ── Sign request and post via axios ───────────────────────────────────
    const authHeader = twitterOAuth.toHeader(
      twitterOAuth.authorize({ url: TWEETS_URL, method: "POST" }, twitterToken)
    );
 
    const body: Record<string, string> = { text };
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
      return { posted: false, reason, delayMinutes: delay_minutes ?? 0 };
    }
 
    const tweetUrl = `https://twitter.com/i/web/status/${tweetId}`;
    logger.info(`✅ Tweet posted: ${tweetUrl}`);
 
    // ── Update tweet_quota in Supabase ─────────────────────────────────────
    // Fetch current row first so we can increment atomically without a DB func.
    const now      = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const todayKey = now.toISOString().slice(0, 10);  // "YYYY-MM-DD"
 
    const { data: currentQuota } = await supabase
      .from("tweet_quota")
      .select("tweets_sent, last_tweet_date, daily_tweets_sent")
      .eq("month", monthKey)
      .maybeSingle();
 
    const isNewDay         = currentQuota?.last_tweet_date !== todayKey;
    const newMonthlyTotal  = (currentQuota?.tweets_sent       ?? 0) + 1;
    const newDailyTotal    = isNewDay
      ? 1
      : (currentQuota?.daily_tweets_sent ?? 0) + 1;
 
    const { error: quotaErr } = await supabase
      .from("tweet_quota")
      .upsert(
        {
          month:             monthKey,
          tweets_sent:       newMonthlyTotal,
          last_tweet_date:   todayKey,
          daily_tweets_sent: newDailyTotal,
          updated_at:        now.toISOString(),
        },
        { onConflict: "month" }
      );
 
    if (quotaErr) logger.warn(`tweet_quota update error: ${quotaErr.message}`);
 
    return {
      posted:       true,
      tweetId,
      tweetUrl,
      delayMinutes: delay_minutes ?? 0,
    };
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
        "Post a tweet via the Twitter API v2 (OAuth 2.0 user context). " +
        "Call once for tweet1 (no quote_tweet_id, no delay). " +
        "Call again for tweet2 only if you decide the content will perform well — " +
        "pass the tweet1 tweetId as quote_tweet_id and choose a random delay_minutes between 3 and 12. " +
        "The tool waits the delay before posting and updates tweet_quota in the DB after success. " +
        "Returns { posted, tweetId, tweetUrl } on success or { posted: false, reason } on failure.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          text: {
            type: Type.STRING,
            description: "The full tweet text to post.",
          },
          quote_tweet_id: {
            type: Type.STRING,
            description:
              "The tweetId of tweet1. Only provide this when posting tweet2 as a quote-tweet. " +
              "Omit entirely when posting tweet1.",
          },
          delay_minutes: {
            type: Type.NUMBER,
            description:
              "Minutes to wait before posting. Only used for tweet2. " +
              "Choose a random value between 3 and 12 — vary it each time to avoid pattern detection. " +
              "Omit when posting tweet1.",
          },
        },
        required: ["text"],
      },
    },
    {
      name: "save_analysis_result",
      description:
        "Persist the completed analysis to analysis_results AND write all contradiction/alignment " +
        "article pairs to article_relationships. MUST be called as the final step. " +
        "Pass tweet1 as the tweet to store — tweet2 is NOT stored in the DB.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          articleId:           { type: Type.STRING, description: "Supabase UUID from save_news_to_database." },
          affectedTickers:     { type: Type.ARRAY, items: { type: Type.STRING }, description: "All affected tickers." },
          newTickersInserted:  { type: Type.ARRAY, items: { type: Type.STRING }, description: "Tickers added to stocks table this run." },
          contradiction: {
            type: Type.OBJECT,
            description: "Contradiction result, or omit if none.",
            properties: {
              score:   { type: Type.NUMBER },
              label:   { type: Type.STRING },
              summary: { type: Type.STRING },
            },
          },
          alignment: {
            type: Type.OBJECT,
            description: "Alignment result, or omit if none.",
            properties: {
              score:              { type: Type.NUMBER },
              label:              { type: Type.STRING },
              summary:            { type: Type.STRING },
              boostedImpactScore: { type: Type.NUMBER },
            },
          },
          marketImpact: {
            type: Type.OBJECT,
            description: "Market impact prediction.",
            properties: {
              prediction: { type: Type.STRING },
              confidence: { type: Type.NUMBER },
              reasoning:  { type: Type.STRING },
            },
            required: ["prediction", "confidence", "reasoning"],
          },
          tweet1:              { type: Type.STRING,  description: "The data/analysis tweet. Stored in analysis_results.tweet." },
          relatedArticleIds:   { type: Type.ARRAY, items: { type: Type.STRING }, description: "UUIDs of contradicting or aligning articles for article_relationships." },
          relationshipType:    { type: Type.STRING,  description: "'contradiction' or 'alignment'. Null if neither." },
          relationshipScore:   { type: Type.NUMBER,  description: "Score (0–100) for the relationship." },
          relationshipLabel:   { type: Type.STRING,  description: "Label: Low/Medium/High/Critical." },
          relationshipSummary: { type: Type.STRING,  description: "Summary of the relationship." },
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
You are a financial news analysis engine with access to EIGHT tools. Follow this exact workflow:
 
STEP 1 — TICKER DETECTION (DB-backed)
Call detect_tickers with the news headline and body.
Combines two phases: token scan + company-name scan against the stocks table.
Result includes "confirmedFromDB" — verified StockRecord objects { ticker, company_name, sector, market_cap }.
 
For each ticker you infer from context (subsidiaries, brands, executives) NOT in confirmedFromDB:
  → Call insert_ticker to add it to the stocks table.
  → Include it in affectedTickers after insert returns { inserted: true }.
 
── TICKER RANKING — KEEP THE TOP 5 ONLY ──────────────────────────────────────
After collecting all confirmed and inferred tickers, rank them by market relevance
and keep only the 5 most directly affected. Do NOT include every ticker mentioned
in passing — only those whose price, valuation, or business model is materially
impacted by this specific news event.
 
Ranking criteria (highest to lowest priority):
  1. Company is the direct subject of the news (earnings, deal, legal action, CEO change)
  2. Company is a named counterparty (merger target, major customer, direct competitor)
  3. Company operates in the same sector and would move sympathetically
  4. Broad market proxies (SPY, QQQ, VIX) — only include if the news is macro-level
  5. Tangentially related companies — EXCLUDE these entirely
 
If fewer than 5 tickers are genuinely relevant, use fewer — do not pad to 5.
affectedTickers must contain only the final ranked list of up to 5 tickers.
Collect newly inserted ones separately as newTickersInserted[].
 
STEP 2 — DATABASE CHECK
Call check_news_in_database using the news ID and headline.
 
STEP 3a — IF ARTICLE EXISTS:
  Set alreadyInDatabase = true. Record its UUID as articleDbId. Skip to STEP 6.
 
STEP 3b — IF ARTICLE DOES NOT EXIST:
  Call save_news_to_database with the NewsObject and all tickers.
  It returns { saved: true, articleId: "<uuid>" }.
  Store that UUID as articleDbId — required for STEP 8.
  Then call fetch_related_news with tickers and articleDbId as excludeId.
 
IMPORTANT: Articles returned by fetch_related_news have fields:
    { id, title, content, source, url, published_at, tickers }
    Use 'title' where you would expect 'headline', and 'content' where you would expect 'body'.
 
STEP 4 — CONTRADICTION ANALYSIS
Identify fetched articles that CONTRADICT the current news.
Score 0–100:
  0–24 → Low | 25–49 → Medium | 50–74 → High | 75–100 → Critical
 
Collect contradicting article UUIDs into relatedArticleIds[].
If contradictionScore > 0: populate contradiction, set alignment to null.
 
STEP 5 — ALIGNMENT ANALYSIS (only if contradictionScore == 0)
Find articles that ALIGN with the current news.
Score 0–100 using the same scale.
Collect aligning article UUIDs into relatedArticleIds[].
boostedImpactScore = base confidence + (alignmentScore x 0.25), capped at 100.
 
STEP 6 — MARKET IMPACT PREDICTION
prediction: "buy" | "sell" | "hold" | "neutral"
confidence: 0–100
reasoning: 1–2 sentences grounded in the news
 
STEP 6.5 — SIGNAL QUALITY GATE
Before generating tweets, evaluate whether this news is worth posting about at all.
This is a separate decision from the tweet2 algo decision — it governs tweet1 too.
 
Set signalQuality to "HIGH", "MEDIUM", or "LOW" based on the following:
 
  HIGH — post tweet1 AND run tweet2 algo decision normally:
  - prediction is "buy" or "sell" AND confidence >= 70
  - OR contradiction score >= 50 (High or Critical)
  - OR corroboratingSourceCount >= 3
  - OR the news contains a concrete, specific data point (earnings number,
    rate decision, M&A deal size, regulatory ruling, price move >= 5%)
 
  MEDIUM — post tweet1 only, skip tweet2 entirely:
  - prediction is "buy" or "sell" AND confidence 50–64
  - OR alignment score >= 50 AND confidence >= 55
  - OR corroboratingSourceCount == 2
  - OR news is macro-relevant but lacks a specific data point
 
  LOW — skip ALL tweet posting, still save analysis:
  - prediction is "hold" or "neutral" AND confidence < 50
  - OR the news is a rumour, speculation, or opinion piece with no hard data
  - OR the news is more than 6 hours old AND corroboratingSourceCount == 1
  - OR the news adds nothing new to a story already posted about this cycle
 
If signalQuality is LOW: set tweet1 = "", tweet2 = "", skip to STEP 8.
If signalQuality is MEDIUM: generate tweet1, set tweet2 = "", skip tweet2 posting.
If signalQuality is HIGH: generate both tweets, run tweet2 algo decision normally.
 
Include signalQuality in the final JSON output.
 
── REPEAT SUBJECT CHECK ───────────────────────────────────────────────────────
Look at the relatedArticleIds collected in STEP 4 or STEP 5.
If ANY of those related articles already have a tweet posted about them
(i.e. they appeared in fetch_related_news and share 2+ tickers with this article),
this subject has already been covered recently. In that case:
  - If the current news adds a NEW concrete data point not in the related articles
    → treat as HIGH and post with a clear "UPDATE:" framing in the tweet
  - If the current news is essentially the same story rehashed
    → downgrade signalQuality to LOW and skip posting
 
CORROBORATING SOURCES SIGNAL (read metadata before STEP 6 and STEP 7)
The news object may contain these fields in metadata:
  - corroboratingSourceCount  — number of platforms reporting this same story
  - corroboratingSources      — list of source names (e.g. ["BBC", "Reuters", "Bloomberg"])
  - isMultiSourceStory        — true when count >= 2
 
Use this signal as follows:
 
  MARKET CONFIDENCE BOOST (apply in STEP 6):
  - 1 source  → no adjustment — use your base confidence
  - 2 sources → add +8 to confidence (capped at 100)
  - 3 sources → add +15 to confidence (capped at 100)
  - 4+ sources → add +20 to confidence (capped at 100)
  Include the boost in your reasoning: "Confidence boosted: X platforms reporting."
 
  TWEET2 ALGO DECISION (apply in STEP 7):
  - 3+ sources reporting → near-certain POST regardless of other signals
  - 2 sources reporting  → counts as a strong POST signal on its own
  - 1 source             → use the normal algo decision criteria
 
  TWEET2 CONTENT (when isMultiSourceStory is true):
  Cross-platform coverage is one of the strongest engagement signals you can use.
  People share things that feel like consensus reality — when multiple major outlets
  are all saying the same thing, it creates urgency and FOMO.
  Weave the source count into tweet2 naturally. Examples:
    - "BBC, Reuters AND Bloomberg are all reporting this."
    - "When X platforms break the same story simultaneously, pay attention."
    - "This isn't one outlet. This is [source1], [source2], [source3] — all at once."
  Do NOT just list sources mechanically. Frame it as a signal.
 
STEP 7 — TWEET GENERATION
 
If signalQuality is LOW: tweet1 = "", tweet2 = "". Skip to STEP 8.
If signalQuality is MEDIUM: generate tweet1 only, tweet2 = "". Skip tweet2 posting.
If signalQuality is HIGH: generate both tweets below.
 
Before writing any tweets, call check_tweet_quota.
  If { allowed: false }: set tweet1 and tweet2 to empty strings. Skip to STEP 8.
  If { allowed: true }: proceed to generate tweets based on signalQuality above.
 
You have Twitter Premium — there is NO character limit. Write as much as needed.
Use signal emojis naturally: 📈 (bullish/buy), 📉 (bearish/sell), ⚡ (breaking/high impact), ⚠️ (contradiction/risk).
Let tone, length, and style emerge from the content — do not follow a rigid template.
 
── TWEET 1 — Data & Analysis (main post) ──────────────────────────────────────
Purpose: A complete market briefing that stands alone. Every line earns its place.
 
STRUCTURE — short punchy sentences, one point per line, blank line between sections:
 
Line 1: Signal opener — ALL CAPS signal word + ticker + what happened
  Examples:
    "⚡ BREAKING: $NVDA crushes Q3 — $35.1B revenue vs $33.2B expected"
    "📉 SELL SIGNAL: $SPY hits new 2026 low as stagflation fears mount"
    "⚠️ CONTRADICTION: $AAPL guidance conflicts with supply chain reports"
 
[blank line]
 
Lines 2–4: Key data points — one fact per line, numbers in full
  - Use exact figures: +5.7%, $94.9B, 112% YoY — never round or simplify
  - Lead each line with the most important number
  - Bold the most critical figure using *asterisks*: "*$103/barrel* — first time since 2022"
 
[blank line]
 
SIGNAL: [prediction in ALL CAPS] | Confidence: [score]%
VERDICT: [1 sentence — what this means for the market right now]
 
[blank line]
 
If contradiction or alignment exists:
  ⚠️ CONTRADICTION ([label]): [one line summary]
  OR
  ✅ ALIGNMENT ([label]): [one line summary]
 
[blank line]
 
SOURCE: [source name] | [URL]
[hashtags on final line]
 
FORMATTING RULES for tweet1:
- Signal word always ALL CAPS: BREAKING, BUY, SELL, HOLD, EARNINGS, MERGER, RATE DECISION
- Section labels always present: SIGNAL: / VERDICT: / SOURCE:
- Numbers and percentages always in full — never "nearly 6%", always "+5.7%"
- Maximum 6–8 lines total — dense but not overwhelming
- No filler phrases: "it is worth noting", "importantly", "analysts say"
 
── TWEET 2 — Engagement Driver (quote-tweet of tweet1) ────────────────────────
Purpose: Stop the scroll and pull people into tweet1. 2–3 sentences maximum.
This is a hook, not an analysis. Every word serves one goal: make them click.
 
STRUCTURE — hybrid prose opening followed by bullet points:
 
Sentence 1 (prose): The bold hook — a counterintuitive statement, a sharp question,
or a tension that demands resolution. This is the line people retweet.
  Examples:
    "The market is treating this like noise. It isn't."
    "Who's on the wrong side of this $NVDA trade right now?"
    "3 major outlets reporting the same thing simultaneously — that's not coincidence."
 
[blank line]
 
Bullet points (1–2 max): The sharpest supporting signals that back the hook
  • [one concrete signal — number, name, or fact]
  • [optional second signal — only if it adds something genuinely new]
 
[blank line]
 
Final line (prose): CTA that pulls toward tweet1
   "Full breakdown below ↓" / "Read the signal ↓" / "Full analysis ↓"
  Include $TICKER and relevant hashtags on this line
 
FORMATTING RULES for tweet2:
- Prose hook must be 1 sentence — no run-ons
- Bullet points use • character, not dashes
- Tickers in $TICKER format always present
- NO section labels (SIGNAL: / VERDICT:) — this is conversational, not analytical
- NO ALL CAPS in tweet2 except ticker symbols — the hook works through directness, not shouting
- Total length: hook + bullets + CTA — never longer than that
 
── ALGORITHM DECISION: IS TWEET 2 WORTH POSTING? ────────────────────────────
The question is not "do I have something to say?" — it is
"will this quote-tweet meaningfully amplify tweet1's reach?"
 
Post tweet2 if ANY of these are true:
  - Prediction is "buy" or "sell" AND confidence > 70 — directional conviction
    gets retweeted; wishy-washy calls do not
  - Contradiction score is High or Critical — conflict and disagreement in markets
    drives replies, quote-tweets and impressions faster than anything else
  - News is less than 2 hours old — recency is the single biggest algorithm boost;
    being early on a story compounds reach
  - Affected tickers include high-profile names (AAPL, TSLA, NVDA, MSFT, AMZN,
    GOOGL, META, BTC, ETH, SPY, QQQ) — large existing audiences = faster spread
  - Alignment score is High or Critical AND confidence > 65 — multiple sources
    pointing the same way signals a real move; traders share confirmation
  - corroboratingSourceCount >= 2 — when multiple platforms are reporting the same
    story it is consensus signal; audiences respond strongly to "everyone is saying this"
  - corroboratingSourceCount >= 3 — near-certain POST; this is the strongest
    real-time signal you can have that a story matters to the market
 
Skip tweet2 if ALL of the following are true:
  - Prediction is "hold" or "neutral" AND confidence < 50
  - News is more than 6 hours old
  - No contradiction or alignment signal above Medium
  - Tickers are low-profile with limited retail or institutional following
 
Write your honest reasoning in tweet2AlgoDecision. State which signals fired,
which did not, and the specific conclusion: POST or SKIP.
 
STEP 8 — PERSIST ANALYSIS (MANDATORY — do not skip)
Call save_analysis_result with:
  - articleId: UUID from save_news_to_database (or the existing article UUID)
  - affectedTickers, newTickersInserted
  - contradiction (or null), alignment (or null)
  - marketImpact
  - tweet1 (stored in analysis_results.tweet — tweet2 is NOT stored)
  - relatedArticleIds: UUIDs of all contradicting or aligning articles
  - relationshipType: "contradiction" | "alignment" | null
  - relationshipScore, relationshipLabel, relationshipSummary
 
This writes to both analysis_results and article_relationships.
 
⚠️  STEP 9 — TWEET POSTING (skip entirely if quota exhausted OR signalQuality is LOW)
 
If signalQuality is LOW: skip STEP 9 entirely.
If signalQuality is MEDIUM: post tweet1 only — do NOT post tweet2.
If signalQuality is HIGH: post tweet1, then run tweet2 algo decision normally.
 
CRITICAL: You MUST call post_tweet as a real tool call and wait for its response.
You are STRICTLY FORBIDDEN from inventing, guessing, or fabricating ANY of the
following: tweetId, tweetUrl, posted status, or any field inside tweet1PostResult
or tweet2PostResult. These values DO NOT EXIST until the tool runs and returns them.
Writing a fake tweetId like "1768400000000000001" will point to a non-existent tweet.
If you write post results without calling the tool, the pipeline is broken.
 
── POST TWEET 1 ──────────────────────────────────────────────
Call post_tweet with { text: tweet1 } only — no quote_tweet_id, no delay_minutes.
WAIT for the tool response before doing anything else.
Copy the EXACT values from the tool response into tweet1PostResult.
Store response.tweetId as tweet1Id — you need it for tweet2.
 
── POST TWEET 2 (only if signalQuality is HIGH AND algo decision was POST) ────
Choose a random delay between 3 and 12 minutes.
Vary it each run — do not always pick the same value.
Good examples: 4, 7, 11, 5, 9, 3, 12, 6. Pick freshly each time.
 
Call post_tweet with:
  { text: tweet2, quote_tweet_id: tweet1Id, delay_minutes: <your_chosen_value> }
 
WAIT for the tool response. Copy the EXACT values it returns into tweet2PostResult.
 
If tweet1 failed to post (tweet1PostResult.posted === false), do NOT attempt tweet2.
If you decided to skip tweet2, set tweet2PostResult to null.
 
IMPORTANT RULES:
- Complete ALL steps before returning the final JSON.
- Never skip check_tweet_quota before generating tweets.
- Never skip save_analysis_result — analysis is not persisted without it.
- NEVER fabricate tweetId, tweetUrl, or any post result — only use values the tool returned.
- affectedTickers must contain a maximum of 5 tickers, ranked by relevance.
- signalQuality must be set before any tweet is generated.
- LOW quality signals save analysis but never post tweets.
- Return ONLY valid JSON. No markdown fences. No preamble.
{
  "newsId": string,
  "articleDbId": string,
  "alreadyInDatabase": boolean,
  "affectedTickers": string[],
  "newTickersInserted": string[],
  "signalQuality": "HIGH" | "MEDIUM" | "LOW",
  "contradiction": {
    "score": number,
    "label": "Low"|"Medium"|"High"|"Critical",
    "contradictingArticles": ArticleRecord[],
    "summary": string
  } | null,
  "alignment": {
    "score": number,
    "label": "Low"|"Medium"|"High"|"Critical",
    "aligningArticles": ArticleRecord[],
    "boostedImpactScore": number,
    "summary": string
  } | null,
  "marketImpact": {
    "prediction": "buy"|"sell"|"hold"|"neutral",
    "confidence": number,
    "reasoning": string
  },
  "tweet1": string,
  "tweet2": string,
  "tweet1PostResult": { "posted": boolean, "tweetId"?: string, "tweetUrl"?: string, "reason"?: string },
  "tweet2PostResult": { "posted": boolean, "tweetId"?: string, "tweetUrl"?: string, "reason"?: string, "delayMinutes"?: number } | null,
  "tweet2AlgoDecision": string
}
`;

 

// ─────────────────────────────────────────────
// MAIN ANALYSIS FUNCTION
// ─────────────────────────────────────────────

export async function analyzeNews(news: NewsObject): Promise<AnalysisResult> {
  const { gemini_api_key } = config;

  if (!gemini_api_key) {
    return Promise.reject(new Error("Gemini API key is not configured."));
  }

  const genAI = new GoogleGenAI({ apiKey: gemini_api_key});

  const chat = genAI.chats.create({
    model: "gemini-2.5-flash-lite",
    config: {
      tools: [tools],
      systemInstruction: {
        parts: [{ text: SYSTEM_PROMPT }],
      },
      thinkingConfig: { 
        includeThoughts: false,
      }
    },
  });

   // Track which turn we're on so PostHog events are distinguishable
  let turnIndex = 0;

  // ── Helper: wrap sendMessage with PostHog tracking ──────────────────────
  async function sendTracked(payload: Parameters<typeof chat.sendMessage>[0]) {
    const startTime = Date.now();
    let response: Awaited<ReturnType<typeof chat.sendMessage>>;

    try {
      response = await chat.sendMessage(payload);
    } catch (err) {
      // Capture failed LLM calls too
      phClient.capture({
        distinctId: news.id,           // ties all events for this news item together
        event: "$ai_generation",
        properties: {
          $ai_provider:    "google",
          $ai_model:       "gemini-2.5-flash",
          $ai_error:       String(err),
          $ai_is_error:    true,
          $ai_latency:     (Date.now() - startTime) / 1000,
          news_id:         news.id,
          news_headline:   news.headline,
          turn_index:      turnIndex,
        },
      });
      throw err;
    }

    const usage = response.usageMetadata;

    // ✅ Capture one $ai_generation event per sendMessage call
    phClient.capture({
      distinctId: news.id,             // group all turns for this article together
      event: "$ai_generation",
      properties: {
        // ── Standard PostHog LLM properties ──
        $ai_provider:          "google",
        $ai_model:             "gemini-2.5-flash",
        $ai_input_tokens:      usage?.promptTokenCount        ?? 0,
        $ai_output_tokens:     usage?.candidatesTokenCount    ?? 0,
        $ai_total_tokens:      usage?.totalTokenCount         ?? 0,
        $ai_latency:           (Date.now() - startTime) / 1000,  // seconds
        $ai_is_error:          false,

        // ── Custom properties for your app ──
        news_id:               news.id,
        news_headline:         news.headline,
        news_source:           news.source,
        turn_index:            turnIndex,           // 0 = initial prompt, 1+ = tool returns
        is_tool_response_turn: turnIndex > 0,
      },
    });

    turnIndex++;
    return response;
  }

  // ── Initial message ───────────────────────────────────────────────────────
  let response = await sendTracked({
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
      // ── Final response — flush PostHog before returning ──────────────────
      await phClient.shutdown();     // ensures buffered events are flushed

      const rawText = parts.find((p) => p.text)?.text ?? "";
      const cleaned = rawText.replace(/```json|```/gi, "").trim();

      let result: AnalysisResult;
      try {
        result = JSON.parse(cleaned);
      } catch {
        throw new Error(`Failed to parse Gemini final JSON:\n${rawText}`);
      }

      if (result.contradiction) {
        result.contradiction.label = scoreToLabel(result.contradiction.score);
      }
      if (result.alignment) {
        result.alignment.label = scoreToLabel(result.alignment.score);
        result.alignment.boostedImpactScore = Math.min(100, result.alignment.boostedImpactScore);
      }

      result.newTickersInserted  = result.newTickersInserted  ?? [];
      result.tweet1              = result.tweet1              ?? "";
      result.tweet2              = result.tweet2              ?? "";
      result.tweet1PostResult    = result.tweet1PostResult    ?? { posted: false, reason: "not_attempted" };
      result.tweet2PostResult    = result.tweet2PostResult    ?? null;
      result.tweet2AlgoDecision  = result.tweet2AlgoDecision  ?? "";

      return result;
    }

    // ── Execute tool calls ────────────────────────────────────────────────
    const toolResults = await Promise.all(
      functionCallParts.map(async (part) => {
        const { name, args } = part.functionCall!;
        if (!name) throw new Error("Tool call had no name.");

        logger.info(`🔧 Tool call → ${name}`);
        logger.debug(`Args: ${JSON.stringify(args, null, 2)}`);

        const impl = toolImplementations[name];
        if (!impl) throw new Error(`No implementation for tool: ${name}`);

        const toolResult = await impl(args as Record<string, unknown>);
        logger.debug(`   ✅ Result: ${JSON.stringify(toolResult, null, 2)}`);

        return {
          functionResponse: { name, response: toolResult },
        } as Part;
      })
    );

    // ✅ sendMessage for tool results is also tracked
    response = await sendTracked({ message: toolResults });
  }
}


// ─────────────────────────────────────────────
// EXAMPLE USAGE
// ─────────────────────────────────────────────

export async function main() {
  const exampleNews: NewsObject = {
  id: "news-20260314-001",
  headline: "Brent crude settles above $103 for first time since 2022 as Strait of Hormuz closure enters third week, S&P 500 posts third straight weekly loss",
  body: `Brent crude futures settled at $103.14 per barrel on Friday, crossing the $100 threshold for the first time since August 2022, as the U.S.-Israel war with Iran kept the Strait of Hormuz virtually shut for a third consecutive week. West Texas Intermediate settled at $98.71, up 3.11% on the day.

  The closure is disrupting an estimated 7.5% of global oil supply according to the International Energy Agency, which coordinated an emergency release of 400 million barrels from member stockpiles — a move that did little to cool prices. U.S. Energy Secretary Chris Wright told CNBC the Navy is "simply not ready" to escort tankers through the strait, adding operations could begin "relatively soon."

  Equity markets absorbed another brutal session. The S&P 500 fell 1.6% for the week, posting its first three-week losing streak in nearly a year and setting a new 2026 low. The Dow shed 2% week-to-date. Stagflation fears are mounting after the Commerce Department revised Q4 2025 GDP growth down to 0.7% from 1.4%, while January PCE inflation held at 2.8% year-over-year — data that predates the oil shock entirely.

  Goldman Sachs and Bank of America both revised oil price forecasts higher Friday. The CME FedWatch Tool now shows rate cut odds above 50% pushed out to September at the earliest, with two-cut scenarios for 2026 collapsing from 85% a month ago to 35% today. Energy was the only S&P 500 sector to close higher. Occidental Petroleum, EOG Resources and Marathon Petroleum hit fresh 52-week highs.`,
  source: "CNBC",
  url: "https://www.cnbc.com/2026/03/12/stock-market-today-live-updates.html",
  publishedAt: new Date("2026-03-14T20:45:00.000Z").toISOString(),
  category: "macro",
  metadata: {
    sentiment: "negative",
    region: "global",
    sector: "Energy/Macro"
  }
};

  logger.info(`📰 Analyzing news: ${exampleNews.headline}`);

  try {
    const result = await analyzeNews(exampleNews);
    logger.info(`📊 ANALYSIS COMPLETE\n${JSON.stringify(result, null, 2)}`);

    // Tweet 1 post result
    if (result.tweet1PostResult.posted) {
      logger.info(`✅ Tweet 1 posted: ${result.tweet1PostResult.tweetUrl}`);
    } else {
      logger.warn(`⚠️  Tweet 1 not posted: ${result.tweet1PostResult.reason}`);
    }

    // Tweet 2 algo decision + post result
    logger.info(`🤖 Tweet 2 algo decision: ${result.tweet2AlgoDecision}`);
    if (result.tweet2PostResult === null) {
      logger.info(`⏭️  Tweet 2 skipped (low engagement potential)`);
    } else if (result.tweet2PostResult.posted) {
      logger.info(`✅ Tweet 2 posted after ${result.tweet2PostResult.delayMinutes} min: ${result.tweet2PostResult.tweetUrl}`);
    } else {
      logger.warn(`❌ Tweet 2 failed: ${result.tweet2PostResult.reason}`);
    }

    if (result.newTickersInserted.length > 0) {
      logger.info(`📝 New tickers added to stocks DB: ${result.newTickersInserted}`);
    }
  } catch (err) {
    logger.error(`❌ Analysis failed: ${err}`);
  }
}