# Politician Scrapping API

**Overview**

- **What:** A news-monitoring and Twitter bot service that scrapes RSS and HTML news sources, extracts relevant political/business keywords and tickers, runs light AI analysis, stores and logs results, and optionally posts tweets. The project is implemented in TypeScript (ESM), uses Express for the HTTP surface, Redis/Valkey for caching/coordination, and Supabase for persistence.
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

  Additional runtime flags / notes:

  - `REQUIRE_SUPABASE` (not yet implemented in codebase) — recommended pattern: set to `true` in production to enforce a fail-fast startup when Supabase is required. See "Next improvements".

Notes on required vs optional:

- `SUPABASE_*` : Currently the codebase was changed to avoid throwing at module import when Supabase env vars are missing. In that case:
  - `src/config/supabase.ts` exports a `supabase` value that may be `null`.
  - `src/database/supabase.database.ts` methods check for the presence of the client and will no-op / return empty results when the client is not configured. This allows the app to start without Supabase for development or partial deployments, but persistence and DB features will not work.
- `REDIS_SERVICE_URI` : Valkey/Redis is still required at initialization in the current code. `src/config/valkey.ts` will throw if no URI is provided on first initialization and the application will attempt to connect to the URI provided — a misconfigured or unreachable URI will produce connection errors such as `ETIMEDOUT` or `Connection is closed.`. For development you can run a local Redis instance (instructions below) or modify `src/config/valkey.ts` to allow optional behavior.
- `TWITTER_*` : Required if you want tweeting behavior. `TwitterService` has been updated to gracefully handle a missing Supabase client (it uses a runtime fallback tweet-quota when Supabase is not configured), but it will still throw if Twitter credentials are missing when the service is instantiated.
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
  -- If `REDIS_SERVICE_URI` is missing or invalid, initialization will fail. Add `REDIS_SERVICE_URI` to Railway to enable Valkey/Redis. If you get connection errors like `connect ETIMEDOUT` or `Connection is closed.`, see the "Valkey / Redis troubleshooting" section below.

**Troubleshooting**

- Error: `Missing Supabase environment variables` — older versions of `src/config/supabase.ts` threw this at module load. The repo now logs a warning and continues; ensure you have `SUPABASE_*` set if you want DB features.
- App crashes at startup due to Redis/Valkey: ensure `REDIS_SERVICE_URI` is set and reachable. If your environment does not need Valkey, you can change `src/config/valkey.ts` to allow optional initialization (development) — but in the current code the first initialization requires a valid URI. See the Valkey troubleshooting section below.
- Twitter errors / `Cannot read properties of null (reading 'response')` — these can be runtime errors from API responses; check Twitter credentials, and inspect logs for `Twitter API error` objects. `TwitterService` was updated to use a runtime fallback for tweet quota when Supabase is not configured, which prevents startup failures related to missing DB.
- `error is not a function` when processing feeds — often caused by logging `feedError.message` when the caught value is not an `Error` object. The code was updated to log `feedError?.message || String(feedError)` to avoid this.

## Valkey / Redis troubleshooting

- Typical error: `{"error":"connect ETIMEDOUT"}` followed by `Connection is closed.` — this indicates the process cannot reach the Redis/Valkey server at the URI provided.
- Causes:
  - Redis/Valkey server is not running at the host/port in `REDIS_SERVICE_URI`.
  - The URI is incorrect (typo, wrong protocol, missing credentials).
  - Network/firewall rules block the connection (common with managed Redis services that restrict IPs).
- Quick fixes:
  - Run a local Redis for development using Docker:

```powershell
docker run -d -p 6379:6379 redis:7
```

- Set `REDIS_SERVICE_URI=redis://localhost:6379` in your `.env` for local testing.
- If using a managed Valkey service (Aiven etc.), confirm credentials, TLS scheme (`rediss://` / `valkeys://`), and IP allowlist.
- Verify by running `redis-cli -h <host> -p <port> ping` or using a simple Node script that calls `ping()`.

If you want Valkey to be optional during development, consider adding a small guard around the first `initializeValkey()` call in `src/index.ts` or modify `src/config/valkey.ts` to return a stub client when no URI is supplied.

**Architecture & Flow**

- `index.ts` starts the Express server and then runs `initializeServices()` which:
  - Reads config from `src/config/environmentalVariables.ts`
  - Initializes Valkey/Redis via `src/config/valkey.ts` and `ValkeyOperations`
  - Calls `scrapeAndTweet()` and sets the periodic interval
- `NewsMonitoringService` handles fetching RSS feeds (and HTML when needed), extracts text, runs keyword matching, does AI analysis (optional), composes `Article` objects and returns them to the caller.
- `TwitterService` uses OAuth1.0a to post tweets. It keeps a tweet quota in Supabase (if available) via `tweet_quota` table; if Supabase is not available it uses a runtime fallback quota to avoid throwing during startup.
- `supabase.database.ts` wraps all DB calls; each method checks whether the Supabase client exists and will no-op / return an empty result if not configured.

## Additional recent changes

- Supabase optional import: `src/config/supabase.ts` was changed so the module no longer throws when `SUPABASE_*` env vars are missing. Instead it logs a warning and exports a possibly-`null` client. The database repository methods check the client and avoid throwing at import time.
- Database behavior: `src/database/supabase.database.ts` methods now check for the client before performing queries. When the client is not present they return safe defaults (empty arrays / `null`) so the app can continue running without DB persistence.
- TwitterService fallback: `src/services/TwitterService.ts` was updated so quota operations use a local runtime fallback when Supabase is not configured. This prevents startup failures when `SUPABASE_*` are missing while preserving tweet quota persistence when Supabase is available.
- Improved error handling in `src/index.ts`: feed-level `catch` now safely logs `[feedError?.message || String(feedError)]` so non-Error throwables don't crash the logger.
- AiAssignment guard: rate-limiter logic was hardened to guard against an `oldestRequest` being `undefined` (returns a safe fallback wait time) to avoid runtime exceptions in the rate-limiting checks.

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
- Add and enable an enforcement flag such as `REQUIRE_SUPABASE` (recommended): when `true` the app should fail-fast at startup if Supabase env vars are missing — useful for production deployments to avoid silent degraded operation. A TODO for this change exists in the repository.

**Contributing**

- Fork, create a branch, and open a PR. Keep changes focused and add tests for bugfixes.

**License**

- (Add your license here or indicate private repo)

---
