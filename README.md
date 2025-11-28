# Politician Scrapping API

**Overview**

- **What:** A news-monitoring and Twitter bot service that scrapes RSS and HTML news sources, extracts relevant political/business keywords and tickers, runs light AI analysis, stores and logs results, and optionally posts tweets. The project is implemented in TypeScript, uses Express for the HTTP surface, Redis (Valkey) for caching/coordination, and Supabase for persistence.
- **Why:** Monitor political and economic news for signals that may indicate market-moving events and optionally post updates to Twitter.

**Quick Summary**

- Language: TypeScript (ESM)
- Runtime: Node.js (tested on Node 22.x, works with 18+)
- Main components: RSS/HTML scrapers, keyword matching & scoring, AI analysis (Gemini/OpenAI), Redis for caching (Valkey), Supabase as DB, Twitter integration for posting

**Repository Layout (important files)**

- `src/index.ts` : Application entry point, Express server, main scheduler loop
- `src/config/environmentalVariables.ts` : Central env var loader and config object
- `src/config/supabase.ts` : Supabase client (now optional if env vars missing)
- `src/config/valkey.ts` : Valkey/Redis initialization helpers
- `src/services/NewsMonitoringService.ts` : RSS + HTML scraping, keyword matching, TF-IDF prep
- `src/services/TwitterService.ts` : Twitter API integration and tweet quota handling
- `src/database/supabase.database.ts` : DB repository wrapping Supabase calls (checks if client exists)
- `src/templates/TweetTemplates.ts` : Tweet-building templates
- `src/utils/Logger.ts` : Logging wrapper
- `src/models/` : Domain models like `Article`, `TradeSignal`
- `src/prompts/` : AI prompt templates (ticker extraction, etc.)

**Environment variables**

- The application reads environment variables from `process.env`. For local development a `.env` in the project root is used (only loaded in non-production mode).

Critical variables (set these in Railway or your environment manager):

- `PORT` : Port for the Express server (or `node_port` in `config`)
- Redis / Valkey:
  - `REDIS_SERVICE_URI` : Full URI for Valkey/Redis connection (recommended)
  - `REDIS_HOST` : Redis host (alternative)
  - `REDIS_PORT` : Redis port
  - `REDIS_PASSWORD` : Redis password
  - `REDIS_USERNAME` : (optional) Redis username
- Twitter (required if you want to post):
  - `TWITTER_API_KEY`
  - `TWITTER_API_KEY_SECRET`
  - `TWITTER_BEARER_TOKEN` (optional depending on endpoints used)
  - `TWITTER_ACCESS_TOKEN`
  - `TWITTER_ACCESS_TOKEN_SECRET`
- AI analysis:
  - `GEMINI_API_KEY` or `OPENAI_API_KEY` (Gemini is referenced in code)
- Supabase (optional; app starts without these now):
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_KEY` depending on your setup)
  - `SUPABASE_API_KEY` (if used elsewhere)

Notes on required vs optional:

- `SUPABASE_*` : Optional — the codebase now logs a warning and will run without Supabase (DB operations become no-ops), but you will lose persistence and some features.
- `REDIS_SERVICE_URI` : Highly recommended/required for normal operation. `index.ts` initialization expects Redis/Valkey to be reachable and will throw if the initialization check fails. Without Redis the scheduled scraping is not started.
- `TWITTER_*` : Required if you want tweeting behavior. The `TwitterService` constructor checks for credentials and will throw if missing when instantiated. The app will handle thrown errors in the scraping cycle, but tweeting won't function.
- `GEMINI_API_KEY` / `OPENAI_API_KEY` : Required for AI analysis tasks (ticker extraction, sentiment, etc.)

**Local setup**

1. Install Node.js (recommended v18+; code tested with Node 22.x as seen in logs)
2. Clone the repo and install dependencies:

```powershell
cd c:\path\to\politician-scrapping-api
npm install
```

3. Create a `.env` in the repo root for development (example below). The `.env` file is only loaded in non-production mode.

Example `.env` (local development):

```text
PORT=3000
REDIS_SERVICE_URI=redis://:password@localhost:6379
TWITTER_API_KEY=your_key
TWITTER_API_KEY_SECRET=your_secret
TWITTER_ACCESS_TOKEN=your_access_token
TWITTER_ACCESS_TOKEN_SECRET=your_access_secret
GEMINI_API_KEY=your_gemini_key
SUPABASE_URL=https://xyz.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_supabase_key
```

4. Build and run:

```powershell
npm run build
npm start
```

5. Development (iterate code): run TypeScript watcher (if available in your local scripts). If not present, re-run `npm run build` on changes.

**Common commands**

- Build: `npm run build` (runs `tsc -p tsconfig.json`)
- Start (production): `npm start` (runs compiled `dist/index.js`)
- Health check endpoint: `GET /health` → returns JSON with status and some runtime info
- Trigger manual scraping: `POST /trigger-scrape` → schedules & runs a single scrape cycle (returns 409 if scraping already in progress)

**Deployment notes (Railway)**

- Set environment variables in Railway's environment variables / secrets panel. Use the names above.
- Node version on Railway should match local (22.x recommended; Node 18+ should work).
- If you don't set `SUPABASE_*`, the app will still start but DB features are disabled.
- If `REDIS_SERVICE_URI` is missing or invalid, initialization will fail. Add `REDIS_SERVICE_URI` to Railway to enable Valkey/Redis.

**Troubleshooting**

- Error: `Missing Supabase environment variables` — older versions of `src/config/supabase.ts` threw this at module load. The repo now logs a warning and continues; ensure you have `SUPABASE_*` set if you want DB features.
- App crashes at startup due to Redis/Valkey: ensure `REDIS_SERVICE_URI` is set and reachable. If your environment does not need Valkey, add a guard or temporary stub in `src/config/valkey.ts` (not recommended in production).
- Twitter errors / `Cannot read properties of null (reading 'response')` — these can be runtime errors from API responses; check Twitter credentials, and inspect logs for `Twitter API error` objects. The code logs stack/JSON when available.
- `error is not a function` when processing feeds — often caused by logging `feedError.message` when the caught value is not an `Error` object. The code was updated to log `feedError?.message || String(feedError)` to avoid this.

**Architecture & Flow**

- `index.ts` starts the Express server and then runs `initializeServices()` which:
  - Reads config from `src/config/environmentalVariables.ts`
  - Initializes Valkey/Redis via `src/config/valkey.ts` and `ValkeyOperations`
  - Calls `scrapeAndTweet()` and sets the periodic interval
- `NewsMonitoringService` handles fetching RSS feeds (and HTML when needed), extracts text, runs keyword matching, does AI analysis (optional), composes `Article` objects and returns them to the caller.
- `TwitterService` uses OAuth1.0a to post tweets. It keeps a tweet quota in Supabase (if available) via `tweet_quota` table; if Supabase is not available it uses a runtime fallback quota to avoid throwing during startup.
- `supabase.database.ts` wraps all DB calls; each method checks whether the Supabase client exists and will no-op / return an empty result if not configured.

**Testing**

- There are currently no automated tests included. Recommended quick tests:
  - Unit test for `matchKeywords` to assert keyword detection and scoring
  - Integration test for `monitorRssFeedWithRedis` using a recorded RSS feed

**Developer Notes & Tips**

- Use `console` or `src/utils/Logger.ts` for consistent structured logs (the project uses `pino` formatting style in places).
- The project uses ESM imports; when debugging from the command line ensure you run the compiled `dist` output (via `npm run build` then `npm start`).
- If you want to disable tweeting during local dev but still test scraping, either omit `TWITTER_*` credentials and catch thrown errors, or add a mock/dummy `TwitterService` implementation.

**Next improvements (recommended)**

- Add unit tests for keyword matching and TF-IDF scoring
- Improve error handling around external API calls (retry/backoff, circuit breaker)
- Add CI that builds the project and runs basic smoke tests
- Add a lightweight config validation step at startup which prints missing but optional variables vs missing required ones

**Contributing**

- Fork, create a branch, and open a PR. Keep changes focused and add tests for bugfixes.

**License**

- (Add your license here or indicate private repo)

---

If you want, I can:

- Add this `README.md` file to the repository now, or
- Extend it with diagrams, example `.env.example`, and CI deployment steps for Railway/GitHub Actions.
