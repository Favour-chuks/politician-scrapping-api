import express from 'express';
import cors from 'cors';

import { config } from './config/environmentalVariables.js';

import { initializeValkey } from './config/valkey.js';
import ValkeyOperations from './services/ValkeyOperations.js';

import { NewsMonitoringService } from './services/NewsMonitoringService.js';
import { TwitterService } from './services/TwitterService.js';

import { getRandomTweetTemplate } from './templates/TweetTemplates.js';
import { getRssSources } from './config/sources.js';
import { logger } from './utils/Logger.js';


const app = express();
app.use(cors());
app.use(express.json());

const SCRAPE_INTERVAL = 5 * 60 * 1000;

let isScrapingInProgress = false;
let lastRunTime: Date | null = null;
let nextRunTime: Date | null = null;
let scraperInterval: NodeJS.Timeout | null = null;

async function scrapeAndTweet() {
  if (isScrapingInProgress) {
    logger.info('Scraping already in progress, skipping this run');
    return;
  }

  isScrapingInProgress = true;
  lastRunTime = new Date();
  logger.info({ time: lastRunTime.toISOString() }, 'Starting scrape cycle');

  try {
    const feeds = getRssSources();
    const newsMonitoringService = new NewsMonitoringService();  
    const twitter = new TwitterService();

    let totalArticles = 0;
    let totalTweets = 0;

    for (const feed of feeds) {
      if (!feed.rssUrls || feed.rssUrls.length === 0) {
        logger.warn({ feed: feed.name }, 'Skipping feed - no RSS URLs');
        continue;
      }

      for (const url of feed.rssUrls) {
        try {
          logger.info({ feed: feed.name, url }, 'Processing RSS feed');
          const rssFeed = await newsMonitoringService.monitorRssFeedWithRedis(url);
          totalArticles += rssFeed.length;
          
          for (const article of rssFeed) {
            try {
              const tweet = await getRandomTweetTemplate(article);
              
              if (!tweet) {
                logger.warn({ articleUrl: article.url }, 'Skipping article - no valid tweet generated');
                continue;
              }

              logger.debug({ tweet }, 'Generated tweet');

              const tweetResponse = await twitter.tweet(tweet);
              logger.info({ tweetId: tweetResponse.data.id }, 'Tweet posted successfully');
              totalTweets++;

              await new Promise(resolve => setTimeout(resolve, 5000));

            } catch (tweetError: any) {
              logger.error({ error: tweetError.message, articleUrl: article.url }, 'Failed to tweet article');
            }
          }
          
          logger.info({ feed: feed.name, url, articlesFound: rssFeed.length }, 'RSS feed processing completed');
        } catch (feedError: any) {
          logger.error({ feed: feed.name, url, error: feedError.message }, 'Error processing RSS feed');
        }
      }
    }

    logger.info(
      { 
        totalArticles, 
        totalTweets, 
        duration: Date.now() - lastRunTime.getTime() 
      }, 
      'Scrape cycle completed'
    );

  } catch (error: any) {
    logger.error({ error: error.message }, 'Error during scraping cycle');
  } finally {
    isScrapingInProgress = false;
    nextRunTime = new Date(Date.now() + SCRAPE_INTERVAL);
    logger.info({ nextRun: nextRunTime.toISOString() }, 'Next run scheduled');
  }
}

async function initializeServices() {
  try {
    const { redis_host, redis_port, redis_password, redis_service_uri } = config;
    
    if (!redis_host || !redis_port || !redis_password || !redis_service_uri) {
      throw new Error("Error initializing the redis connection");
    }
    
    initializeValkey({
      uri: redis_service_uri,
    });

    const ops = new ValkeyOperations();
    const isHealthy = await ops.pingValkey();
    
    logger.info('Redis connection established');
    
    if (!isHealthy || isHealthy === undefined) {
      throw new Error("Connection to Redis server is not healthy");
    }
    
    logger.info({ intervalMinutes: SCRAPE_INTERVAL / 1000 / 60 }, 'All services initialized successfully');
    
    await scrapeAndTweet();
    
    scraperInterval = setInterval(scrapeAndTweet, SCRAPE_INTERVAL);
    
  } catch (error: any) {
    logger.error({ error: error.message }, 'Fatal error during initialization');
    throw error;
  }
}

app.get('/', (req, res) => {
  res.json({
    status: 'running',
    service: 'News Monitoring & Twitter Bot',
    scrapeInterval: `${SCRAPE_INTERVAL / 1000 / 60} minutes`,
    lastRun: lastRunTime?.toISOString() || 'Not yet run',
    nextRun: nextRunTime?.toISOString() || 'Calculating...',
    isScrapingInProgress
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    redis: 'connected',
    scraper: isScrapingInProgress ? 'running' : 'idle'
  });
});

app.post('/trigger-scrape', async (req, res) => {
  if (isScrapingInProgress) {
    logger.warn('Manual scrape rejected - already in progress');
    return res.status(409).json({ 
      error: 'Scraping already in progress',
      lastRun: lastRunTime?.toISOString()
    });
  }

  logger.info('Manual scrape triggered');
  res.json({ 
    message: 'Scraping triggered manually',
    startedAt: new Date().toISOString()
  });

  scrapeAndTweet().catch(error => {
    logger.error({ error: error.message }, 'Error in manual scrape');
  });
});

app.get('/status', (req, res) => {
  res.json({
    isScrapingInProgress,
    lastRunTime: lastRunTime?.toISOString() || null,
    nextRunTime: nextRunTime?.toISOString() || null,
    intervalMinutes: SCRAPE_INTERVAL / 1000 / 60,
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  
  if (scraperInterval) {
    clearInterval(scraperInterval);
  }
  
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  
  if (scraperInterval) {
    clearInterval(scraperInterval);
  }
  
  process.exit(0);
});

app.listen(config.node_port, () => {
  logger.info({ port: config.node_port }, 'Server started');
  logger.info('Initializing services');
  
  initializeServices().catch(error => {
    logger.error({ error: error.message }, 'Failed to initialize services');
    process.exit(1);
  });
});