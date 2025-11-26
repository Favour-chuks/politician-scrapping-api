export type HtmlSelectors = {
  // CSS selectors to help find article lists/links and extract title/content
  articleListSelector?: string; // page that lists articles
  articleLinkSelector?: string; // selector inside list to get href
  titleSelector?: string; // selector on the article page to get title
  contentSelector?: string; // selector on the article page to get article body
};

export type NewsSource = {
  id: string;
  name: string;
  baseUrl: string;
  hasRss: boolean;
  rssUrls?: string[]; // empty array when unknown
  rssPreferred?: boolean; // prefer RSS when available
  htmlSelectors?: HtmlSelectors;
  htmlUrls?: string[]; // pages to scrape for HTML changes if no RSS
  notes?: string;
};

export const newsSources: NewsSource[] = [
  {
    id: 'bbc',
    name: 'BBC News',
    baseUrl: 'https://www.bbc.co.uk',
    hasRss: true,
    rssUrls: ['https://feeds.bbci.co.uk/news/rss.xml'],
    rssPreferred: true,
  },
  {
    id: 'nytimes',
    name: 'The New York Times',
    baseUrl: 'https://www.nytimes.com/section/business/dealbook',
    hasRss: true,
    rssUrls: ['https://rss.nytimes.com/services/xml/rss/nyt/Dealbook.xml'],
    rssPreferred: true,
    notes: 'NYTimes content sometimes behind paywall; scraping may require special handling.'
  },
  {
    id: 'theguardian',
    name: 'The Guardian',
    baseUrl: 'https://www.theguardian.com',
    hasRss: true,
    rssUrls: [
      'https://www.theguardian.com/world/rss',
      'https://www.theguardian.com/us/business/rss',
      'https://www.theguardian.com/business/stock-markets/rss',
      'https://www.theguardian.com/business/economics/rss',
    ],
    rssPreferred: true
  },
  {
    id: 'politico',
    name: 'Politico',
    baseUrl: 'https://www.politico.com',
    hasRss: true,
    rssUrls: [
      'https://rss.politico.com/healthcare.xml',
      'https://rss.politico.com/energy.xml',
      'https://rss.politico.com/economy.xml',
      'https://rss.politico.com/defense.xml',
      'https://rss.politico.com/congress.xml',
    ],
    rssPreferred: true
  },
  {
    id: 'cnn',
    name: 'CNN',
    baseUrl: 'https://edition.cnn.com/business',
    hasRss: false,
    rssUrls: ['http://rss.cnn.com/rss/edition.rss'],
    rssPreferred: false
  },
  {
    id: 'fox',
    name: 'Fox News',
    baseUrl: 'https://www.foxnews.com',
    hasRss: true,
    rssUrls: [
      'https://moxie.foxbusiness.com/google-publisher/latest.xml',
      'https://www.foxbusiness.com/rss.xml?tag=US Markets',
      'https://www.foxbusiness.com/rss.xml?tag=Cryptocurrency',
      'https://www.foxbusiness.com/rss.xml?tag=Stocks',
      'https://moxie.foxbusiness.com/google-publisher/economy.xml',
      'https://moxie.foxbusiness.com/google-publisher/real-estate.xml',
    ],
    rssPreferred: true
  },
  {
    id: 'bloomberg',
    name: 'Bloomberg',
    baseUrl: 'https://www.bloomberg.com',
    hasRss: true,
    rssUrls: ['https://www.bloomberg.com/feed/podcast/etf-report.xml'], // placeholder — Bloomberg has many feeds
    htmlUrls: [
      'https://www.bloomberg.com/wealth',
      'https://www.bloomberg.com/economics',
      'https://www.bloomberg.com/technology',
      'https://www.bloomberg.com/industries/finance',
      'https://www.bloomberg.com/industries',
      'https://www.bloomberg.com/industries/energy'
    ],
    rssPreferred: true
  },
  {
    id: 'washingtonpost',
    name: 'The Washington Post',
    baseUrl: 'https://www.washingtonpost.com',
    hasRss: true,
    rssUrls: ['https://feeds.washingtonpost.com/rss/business?itid=lk_inline_manual_27'],
    rssPreferred: true,
    notes: 'WaPo offers RSS but the exact feeds may vary; often paywalled.'
  },
];

export function getRssSources(): NewsSource[] {
  return newsSources.filter(s => s.hasRss && s.rssUrls && s.rssUrls.length > 0);
}

export function getHtmlOnlySources(): NewsSource[] {
  return newsSources.filter(s => !s.hasRss || (s.rssUrls && s.rssUrls.length === 0));
}

// Usage notes (edit this file to add/remove sources):
// - Fill `rssUrls` with exact feed URLs when available. For many large outlets there are topic/section feeds.
// - If a site is paywalled or blocks scraping, prefer RSS or use a proxy/official API where available.
// - Update `htmlSelectors` for better scraping accuracy per site.
