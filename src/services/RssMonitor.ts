import dns from 'dns';
import https from 'https';
import crypto from 'crypto';
import axios, { type AxiosInstance } from 'axios';
import { XMLParser } from 'fast-xml-parser';
import CacheableLookup from 'cacheable-lookup';

import { getRssSources } from '../config/sources.js';
import { analyzeNews, type NewsObject } from './GeminiService.js';
import { logger } from '../utils/Logger.js';

// ─────────────────────────────────────────────
// PURPOSE
// ─────────────────────────────────────────────
// Polls multiple RSS feeds every 30 minutes.
// For each new article found, builds a clean NewsObject and passes it
// directly to analyzeNews() — the AI agent handles everything after that.
//
// Single responsibility: RSS → NewsObject → analyzeNews()
// ─────────────────────────────────────────────

const POLL_INTERVAL_MS  = 30 * 60 * 1000;      // 30 minutes
const SEEN_WINDOW_MS    = 24 * 60 * 60 * 1000; // forget seen URLs after 24 hours
const JACCARD_THRESHOLD = 0.30;                 // headlines 30%+ similar = same story
const CLUSTER_WINDOW_MS = 30 * 1000;            // wait 30s for corroborating sources

// ─────────────────────────────────────────────
// SEEN URL CACHE
// ─────────────────────────────────────────────
// Prevents the same article being sent to analyzeNews() twice.
// In-memory only — resets on restart, but the AI agent's
// check_news_in_database tool acts as the persistent fallback.

const seenUrls = new Map<string, number>();

function hasBeenSeen(url: string): boolean {
  return seenUrls.has(url);
}

function markSeen(url: string): void {
  seenUrls.set(url, Date.now());
}

function evictExpired(): void {
  const cutoff = Date.now() - SEEN_WINDOW_MS;
  for (const [url, ts] of seenUrls) {
    if (ts < cutoff) seenUrls.delete(url);
  }
}

// ─────────────────────────────────────────────
// DNS RESOLVER POOL
// ─────────────────────────────────────────────
// Rotates through Google → Cloudflare → Quad9 on network failure.
// Prevents a single DNS provider outage from breaking all feed fetches.

const DNS_SERVERS = [
  ["8.8.8.8",  "8.8.4.4"],
  ["1.1.1.1",  "1.0.0.1"],
  ["9.9.9.9",  "149.112.112.112"],
];

function buildResolverPool(): AxiosInstance[] {
  dns.setDefaultResultOrder("ipv4first");

  return DNS_SERVERS.map((servers) => {
    const resolver = new dns.Resolver();
    resolver.setServers(servers);

    const lookup = new CacheableLookup({ resolver, maxTtl: 60 });
    const agent  = new https.Agent({
      keepAlive:          true,
      rejectUnauthorized: process.env.NODE_ENV === "production",
    });
    lookup.install(agent);

    return axios.create({
      httpsAgent: agent,
      timeout:    20_000,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; NewsAnalyzer/1.0)",
        "Accept":     "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
  });
}

const resolverPool = buildResolverPool();

async function fetchXml(url: string): Promise<string> {
  let lastError: unknown;

  for (const client of resolverPool) {
    try {
      const res = await client.get<string>(url, { responseType: "text" });
      return res.data;
    } catch (err: unknown) {
      lastError = err;
      const code = (err as Record<string, string>).code ?? "";
      const retryable = ["ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"];
      if (!retryable.includes(code)) break; // non-network error — stop retrying
    }
  }

  throw lastError;
}

// ─────────────────────────────────────────────
// XML PARSER
// ─────────────────────────────────────────────

const xmlParser = new XMLParser({
  ignoreAttributes:    false,
  attributeNamePrefix: "@_",
  isArray: (name) => ["item", "entry"].includes(name),
});

// ─────────────────────────────────────────────
// HTML CLEANING
// ─────────────────────────────────────────────

function clean(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi,   " ")
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g,       "")
    .replace(/<[^>]+>/g,     " ")
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/\s+/g,    " ")
    .trim();
}

// ─────────────────────────────────────────────
// CATEGORY INFERENCE
// ─────────────────────────────────────────────
// 1. Read <category> tag directly from the RSS item (most accurate)
// 2. Fall back to a slug match against the feed URL
// 3. Default to "general"

const FEED_URL_CATEGORIES: Record<string, string> = {
  "dealbook":    "finance",
  "economy":     "economy",
  "energy":      "energy",
  "defense":     "defense",
  "congress":    "politics",
  "healthcare":  "healthcare",
  "real-estate": "real-estate",
  "stocks":      "stocks",
  "markets":     "markets",
  "crypto":      "crypto",
  "technology":  "technology",
  "business":    "business",
  "economics":   "economics",
};

function inferCategory(item: Record<string, unknown>, feedUrl: string): string {
  // Try item-level category tag first
  const raw = item.category;
  if (raw) {
    const first = Array.isArray(raw) ? raw[0] : raw;
    const value = typeof first === "object"
      ? String((first as Record<string, unknown>)?.["#text"] ?? "")
      : String(first);
    const cleaned = clean(value).toLowerCase().trim();
    if (cleaned) return cleaned;
  }

  // Fall back to feed URL slug
  const lower = feedUrl.toLowerCase();
  for (const [slug, cat] of Object.entries(FEED_URL_CATEGORIES)) {
    if (lower.includes(slug)) return cat;
  }

  return "general";
}

// ─────────────────────────────────────────────
// FEED PARSING
// ─────────────────────────────────────────────
// Parses a single RSS/Atom feed and returns clean NewsObjects ready
// for the AI agent. Nothing else happens here.

interface RawArticle {
  news:       NewsObject;
  sourceName: string;
  sourceId:   string;
  tokens:     Set<string>;
}

const STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for",
  "of","with","by","from","as","is","was","are","were","be",
  "been","has","have","had","will","would","could","should",
  "its","it","this","that","these","those","their","they",
  "says","said","after","before","over","under","more","also",
  "new","about","between","into","through","than","up","out",
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP_WORDS.has(t))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = [...a].filter((x) => b.has(x)).length;
  return intersection / new Set([...a, ...b]).size;
}

async function parseFeed(
  feedUrl:    string,
  sourceName: string,
  sourceId:   string,
): Promise<RawArticle[]> {
  const rawXml = await fetchXml(feedUrl);
  const parsed = xmlParser.parse(rawXml) as Record<string, unknown>;

  // RSS 2.0 → rss.channel.item | Atom → feed.entry
  const channel  = (parsed?.rss as Record<string, unknown>)?.channel as
    Record<string, unknown> | undefined;
  const rawItems = (
    channel?.item ??
    (parsed?.feed as Record<string, unknown>)?.entry ??
    []
  ) as Record<string, unknown>[];

  const articles: RawArticle[] = [];

  for (const it of rawItems) {
    const headline = clean(String(it.title ?? "")).trim();

    // RSS 2.0: plain string link | Atom: <link href="..."> attribute or <id>
    const rawLink = it.link;
    const url = clean(
      typeof rawLink === "string"
        ? rawLink
        : (rawLink as Record<string, unknown>)?.["@_href"] as string
          ?? String(it.id ?? "")
    ).trim();

    if (!headline || !url) continue;
    if (hasBeenSeen(url))  continue;

    // Body: prefer full content over snippet or description
    const rawBody =
      (it["content:encoded"] as string | undefined) ??
      (typeof it.content === "object"
        ? (it.content as Record<string, unknown>)?.["#text"] as string
        : it.content as string | undefined) ??
      (it.description as string | undefined) ??
      (it.summary     as string | undefined) ??
      "";

    const body = clean(String(rawBody)) || headline;

    const publishedAt = new Date(
      (it.pubDate ?? it.published ?? it.updated ?? Date.now()) as string | number
    ).toISOString();

    const category = inferCategory(it, feedUrl);

    const id = `rss-${crypto
      .createHash("sha1")
      .update(url)
      .digest("hex")
      .slice(0, 16)}`;

    articles.push({
      news: {
        id,
        headline,
        body,
        source:      sourceName,
        url,
        publishedAt,
        category,
        metadata: { sourceId, feedUrl },
      },
      sourceName,
      sourceId,
      tokens: tokenize(headline),
    });
  }

  return articles;
}

import { createClient } from '@supabase/supabase-js';
import { config } from '../config/environmentalVariables.js';

const supabase = createClient(
  config.supabase_url!,
  config.supabase_service_role_key!
);

// ─────────────────────────────────────────────
// PRE-COMPUTATION (runs BEFORE any Gemini call)
// ─────────────────────────────────────────────
// Everything computed here is free. Results are injected into metadata
// so the agent can skip the equivalent tool calls and use the values directly.
//
// Offloaded from the agent:
//   1. Content quality gate          — no LLM needed
//   2. Exact URL duplicate check     — Supabase, no LLM
//   3. Similar headline check        — Supabase, no LLM
//   4. Repeat subject check          — Supabase ticker overlap, no LLM
//   5. Phase 1 ticker candidates     — regex token scan, no LLM
//   6. Article age in hours          — arithmetic, no LLM
//   7. Rough relevance floor score   — deterministic signals only, no LLM
//
// If the rough score is below MIN_RELEVANCE_FLOOR the article is dropped
// entirely before Gemini is ever called — saves the full ~$0.00056 per run.

const MIN_BODY_LENGTH      = 100;
const MIN_HEADLINE_WORDS   = 5;
const DUPLICATE_WINDOW_H   = 6;
const REPEAT_SUBJECT_WINDOW_H = 24;
const MIN_RELEVANCE_FLOOR  = 30;   // drop articles that can't possibly reach 70

// Financial keyword signals used for the rough floor score only
// (agent does the real semantic scoring — this just filters obvious noise)
const FINANCIAL_KEYWORDS = new Set([
  "earnings","revenue","profit","loss","merger","acquisition","ipo","fed",
  "rate","inflation","gdp","recession","bankruptcy","layoffs","strike",
  "sanctions","tariff","bond","yield","deficit","surplus","trade","oil",
  "price","market","stock","shares","quarterly","annual","guidance",
  "forecast","outlook","deal","agreement","lawsuit","ruling","penalty",
  "dividend","buyback","split","halt","circuit","crash","rally","surge",
]);

function roughRelevanceFloor(news: NewsObject): number {
  let score = 0;
  const text = `${news.headline} ${news.body}`.toLowerCase();

  // Keyword presence — basic signal that this is financial news at all
  let kwHits = 0;
  for (const kw of FINANCIAL_KEYWORDS) {
    if (text.includes(kw)) kwHits++;
    if (kwHits >= 3) break;
  }
  score += kwHits * 5; // max +15

  // Corroborating sources from metadata (already computed by rss-monitor)
  const srcCount = (news.metadata?.corroboratingSourceCount as number) ?? 1;
  if (srcCount >= 3) score += 15;
  else if (srcCount === 2) score += 10;

  // Article age — penalise stale single-source articles
  const ageH = (Date.now() - new Date(news.publishedAt).getTime()) / 3_600_000;
  if (ageH > 6 && srcCount === 1) score -= 15;
  if (ageH <= 2) score += 10;

  return Math.max(0, score);
}

function extractCandidateTickers(text: string): string[] {
  // Phase 1 of the agent's detect_tickers — uppercase token scan
  // Passed to agent in metadata so it can skip re-doing this regex work
  return Array.from(
    new Set((text.match(/\b[A-Z]{1,10}\b/g) ?? []))
  ).filter((t) =>
    // Filter obvious non-tickers: common English words, single letters
    t.length > 1 &&
    !["I","A","THE","AND","OR","BUT","IN","ON","AT","TO","BY","US","UK","EU",
      "CEO","CFO","COO","IPO","ETF","GDP","FED","SEC","NYSE","IMF","WHO",
      "FBI","CIA","NATO","UN","AI","EV","IT","HR","PR","AM","PM","EST","UTC",
    ].includes(t)
  );
}

interface PreComputedContext {
  passes:             boolean;
  skipReason?:        string;
  candidateTickers:   string[];
  articleAgeHours:    number;
  isRepeatSubject:    boolean;
  repeatSubjectTickers?: string[] | undefined;
  roughRelevanceFloor: number;
}

async function preCompute(news: NewsObject): Promise<PreComputedContext> {
  // ── 1. Content quality ────────────────────────────────────────────────────
  if (news.headline.trim().split(/\s+/).length < MIN_HEADLINE_WORDS) {
    return { passes: false, skipReason: "short_headline",
             candidateTickers: [], articleAgeHours: 0,
             isRepeatSubject: false, roughRelevanceFloor: 0 };
  }
  if (news.body.length < MIN_BODY_LENGTH) {
    return { passes: false, skipReason: "stub_body",
             candidateTickers: [], articleAgeHours: 0,
             isRepeatSubject: false, roughRelevanceFloor: 0 };
  }

  // ── 2. Exact URL duplicate ────────────────────────────────────────────────
  const { data: byUrl } = await supabase
    .from("articles").select("id").eq("url", news.url).maybeSingle();
  if (byUrl) {
    return { passes: false, skipReason: "url_duplicate",
             candidateTickers: [], articleAgeHours: 0,
             isRepeatSubject: false, roughRelevanceFloor: 0 };
  }

  // ── 3. Similar headline in last DUPLICATE_WINDOW_H hours ─────────────────
  const dupSince  = new Date(Date.now() - DUPLICATE_WINDOW_H * 3_600_000).toISOString();
  const snippet   = news.headline.slice(0, 60);
  const { data: byTitle } = await supabase
    .from("articles").select("id")
    .ilike("title", `%${snippet}%`)
    .gte("scraped_at", dupSince).limit(1);
  if (byTitle && byTitle.length > 0) {
    return { passes: false, skipReason: "headline_duplicate",
             candidateTickers: [], articleAgeHours: 0,
             isRepeatSubject: false, roughRelevanceFloor: 0 };
  }

  // ── 4. Phase 1 ticker scan (offloaded from agent STEP 1) ─────────────────
  const candidateTickers = extractCandidateTickers(`${news.headline} ${news.body}`);

  // ── 5. Repeat subject check (offloaded from agent STEP 6.5) ──────────────
  // Check if any recently analyzed articles share 2+ tickers with this one.
  // The agent still saves the analysis — but now it knows upfront not to post.
  let isRepeatSubject    = false;
  let repeatSubjectTickers: string[] | undefined;

  if (candidateTickers.length >= 2) {
    const repeatSince = new Date(Date.now() - REPEAT_SUBJECT_WINDOW_H * 3_600_000).toISOString();
    const { data: recentArticles } = await supabase
      .from("articles")
      .select("tickers")
      .overlaps("tickers", candidateTickers)
      .gte("analyzed_at", repeatSince)
      .limit(10);

    if (recentArticles && recentArticles.length > 0) {
      for (const row of recentArticles) {
        const overlap = (row.tickers as string[]).filter(
          (t: string) => candidateTickers.includes(t)
        );
        if (overlap.length >= 2) {
          isRepeatSubject       = true;
          repeatSubjectTickers  = overlap;
          break;
        }
      }
    }
  }

  // ── 6. Article age ────────────────────────────────────────────────────────
  const articleAgeHours = (Date.now() - new Date(news.publishedAt).getTime()) / 3_600_000;

  // ── 7. Rough relevance floor ──────────────────────────────────────────────
  const floor = roughRelevanceFloor(news);
  if (floor < MIN_RELEVANCE_FLOOR) {
    logger.debug(`  ⏭ Pre-compute SKIP (floor score ${floor} < ${MIN_RELEVANCE_FLOOR}): "${news.headline}"`);
    return { passes: false, skipReason: "below_relevance_floor",
             candidateTickers, articleAgeHours, isRepeatSubject,
             roughRelevanceFloor: floor };
  }

  return {
    passes:              true,
    candidateTickers,
    articleAgeHours,
    isRepeatSubject,
    repeatSubjectTickers,
    roughRelevanceFloor: floor,
  };
}

// ─────────────────────────────────────────────
// CONCURRENCY QUEUE
// ─────────────────────────────────────────────
// Controls how many analyzeNews() calls run simultaneously.
//
// MAX_CONCURRENT = 5   — up to 5 analyses running at once
// MAX_QUEUE_SIZE = 50  — if backlog exceeds this, oldest item is dropped
//                        to keep the queue fresh with recent news
//
// Flow: dispatch() → enqueue() → drainQueue() → analyzeNews()

const MAX_CONCURRENT = 5;
const MAX_QUEUE_SIZE = 250;  // large enough to hold a full poll cycle without drops

let   activeCount  = 0;
const queue: { news: NewsObject; tag: string }[] = [];

function enqueue(news: NewsObject, tag: string): void {
  // If already at capacity, drop the oldest item to make room for newer news
  if (queue.length >= MAX_QUEUE_SIZE) {
    const dropped = queue.shift()!;
    logger.warn(
      `⚠️  Queue full (${MAX_QUEUE_SIZE}) — dropped oldest: "${dropped.news.headline}"`
    );
  }

  queue.push({ news, tag });
  logger.debug(
    `  📥 Queued [${queue.length}/${MAX_QUEUE_SIZE}]: "${news.headline}"`
  );

  drainQueue();
}

function drainQueue(): void {
  // Spin up as many workers as the concurrency limit allows
  while (activeCount < MAX_CONCURRENT && queue.length > 0) {
    const item = queue.shift()!;
    activeCount++;

    logger.info(
      `${item.tag} → analyzeNews() [active: ${activeCount}/${MAX_CONCURRENT}, ` +
      `queued: ${queue.length}]: "${item.news.headline}"`
    );

    // Run all free pre-computation before burning any Gemini tokens.
    // Results are injected into metadata so the agent skips redundant work.
    preCompute(item.news)
      .then((ctx) => {
        if (!ctx.passes) {
          logger.debug(`  ⏭ Skipped [${ctx.skipReason}]: "${item.news.headline}"`);
          activeCount--;
          drainQueue();
          return;
        }

        // ── Body truncation ───────────────────────────────────────────────
        // The agent only needs enough body to extract data points and assess
        // signal quality. Full articles add ~1,000+ tokens per turn × 10 turns.
        // 600 chars captures the lead paragraph which contains all key facts.
        const MAX_BODY_CHARS = 600;
        const truncatedBody  = item.news.body.length > MAX_BODY_CHARS
          ? item.news.body.slice(0, MAX_BODY_CHARS).replace(/\s+\S*$/, "") + "…"
          : item.news.body;

        // Inject pre-computed context into metadata — agent reads these directly
        const enrichedNews: NewsObject = {
          ...item.news,
          body: truncatedBody,
          metadata: {
            ...item.news.metadata,
            candidateTickers:     ctx.candidateTickers,
            articleAgeHours:      Math.round(ctx.articleAgeHours * 10) / 10,
            isRepeatSubject:      ctx.isRepeatSubject,
            repeatSubjectTickers: ctx.repeatSubjectTickers ?? [],
            roughRelevanceFloor:  ctx.roughRelevanceFloor,
          },
        };

        if (ctx.isRepeatSubject) {
          logger.info(
            `♻️  Repeat subject [${ctx.repeatSubjectTickers?.join(", ")}] — ` +
            `agent will save analysis but skip posting: "${item.news.headline}"`
          );
        }

        return analyzeNews(enrichedNews)
          .catch((err) => {
            logger.error(`analyzeNews() failed for "${item.news.headline}": ${err}`);
            seenUrls.delete(item.news.url);
          });
      })
      .finally(() => {
        activeCount--;
        drainQueue();
      });
  }
}

// ─────────────────────────────────────────────
// CROSS-SOURCE CLUSTERING
// ─────────────────────────────────────────────
// When the same story is reported by multiple sources within 2 minutes,
// they are grouped into a single cluster. The cluster is dispatched as
// one analyzeNews() call with a corroboration count in the metadata.
//
// This lets the AI agent know:
//   - How many sources are reporting the same story
//   - Which sources they are (named in tweet2)
//   - Whether to treat it as a high-conviction signal
//
// If only one source reports a story, it still gets dispatched — the
// corroboration count is just 1 and the agent treats it as a normal article.

interface PendingCluster {
  items: RawArticle[];
  timer: ReturnType<typeof setTimeout>;
}

const pendingClusters: PendingCluster[] = [];

function dispatch(cluster: PendingCluster): void {
  const idx = pendingClusters.indexOf(cluster);
  if (idx !== -1) pendingClusters.splice(idx, 1);

  // Use the article with the longest body as the primary — most complete version
  const primary = cluster.items.reduce((best, c) =>
    c.news.body.length > best.news.body.length ? c : best
  );

  // Count unique source names — Guardian and Fox may appear twice (2 feeds each)
  // but should count as one corroborating source
  const uniqueSources = [...new Set(cluster.items.map((i) => i.sourceName))];
  const sourceCount   = uniqueSources.length;

  // Build the final NewsObject the AI agent will receive
  const newsObject: NewsObject = {
    id:          primary.news.id,
    headline:    primary.news.headline,
    body:        primary.news.body,
    source:      primary.news.source,
    url:         primary.news.url,
    publishedAt: primary.news.publishedAt,
    category:    primary.news.category ?? "general",
    metadata: {
      // The AI agent reads these three fields from the system prompt to:
      //   1. Boost market confidence (+8 for 2 sources, +15 for 3, +20 for 4+)
      //   2. Near-guarantee tweet2 POST when 3+ sources are reporting
      //   3. Name sources in tweet2: "BBC AND Reuters are both reporting this"
      corroboratingSourceCount: sourceCount,
      corroboratingSources:     uniqueSources,
      isMultiSourceStory:       sourceCount >= 2,
    },
  };

  const tag =
    sourceCount >= 3 ? `🔥 HIGH-CONVICTION (${sourceCount} sources)` :
    sourceCount === 2 ? `⚡ MULTI-SOURCE (${sourceCount} sources)`    :
    `📰 Single source`;

  // Hand off to the concurrency queue — never call analyzeNews() directly
  enqueue(newsObject, tag);
}


function addToCluster(article: RawArticle): void {
  // Try to find an existing cluster this article belongs to
  for (const cluster of pendingClusters) {
    const firstItem = cluster.items[0];
    if (!firstItem) continue;
    
    if (jaccard(article.tokens, firstItem.tokens) >= JACCARD_THRESHOLD) {
      // Same story — add if this source isn't already in the cluster
      const duplicate = cluster.items.some((i) => i.sourceId === article.sourceId);
      if (!duplicate) cluster.items.push(article);

      // Reset timer — wait to see if more sources pick this up
      clearTimeout(cluster.timer);
      cluster.timer = setTimeout(() => dispatch(cluster), CLUSTER_WINDOW_MS);
      return;
    }
  }

  // No match — start a new cluster for this story
  const newCluster: PendingCluster = {
    items: [article],
    timer: setTimeout(() => dispatch(newCluster), CLUSTER_WINDOW_MS),
  };
  pendingClusters.push(newCluster);
}

// ─────────────────────────────────────────────
// POLL CYCLE
// ─────────────────────────────────────────────

async function poll(): Promise<void> {
  evictExpired();

  const sources  = getRssSources();
  const feedUrls = sources.flatMap((s) => s.rssUrls ?? []);

  logger.info(
    `🔄 RSS poll starting — ${sources.length} source(s), ${feedUrls.length} feed(s)`
  );

  let totalNew = 0;

  // Fetch all feeds in parallel
  // Promise.allSettled ensures one failing feed never blocks the others
  const results = await Promise.allSettled(
    sources.flatMap((source) =>
      (source.rssUrls ?? []).map(async (feedUrl) => {
        const articles = await parseFeed(feedUrl, source.name, source.id);

        for (const article of articles) {
          markSeen(article.news.url);
          addToCluster(article);
          totalNew++;
        }

        if (articles.length > 0) {
          logger.debug(`  📡 ${source.name} [${feedUrl}]: ${articles.length} new item(s)`);
        }
      })
    )
  );

  // Log any feed-level failures without crashing the cycle
  for (const result of results) {
    if (result.status === "rejected") {
      logger.warn(`  ⚠️  Feed fetch failed: ${result.reason}`);
    }
  }

  logger.info(
    totalNew > 0
      ? `✅ Poll complete — ${totalNew} new article(s) queued for analysis`
      : `✅ Poll complete — no new articles this cycle`
  );
}

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

/**
 * Call this once inside your app.listen() callback.
 * Runs an immediate poll on startup then every 30 minutes after.
 *
 * @example
 * app.listen(config.node_port, async () => {
 *   await startRssMonitor();
 * });
 */
export async function startRssMonitor(): Promise<void> {
  logger.info("📰 RSS monitor starting...");

  await poll();

  setInterval(() => {
    poll().catch((err) => logger.error(`Poll error: ${err}`));
  }, POLL_INTERVAL_MS);

  logger.info(`✅ RSS monitor running — next poll in ${POLL_INTERVAL_MS / 60_000} minutes`);
}