import { type Article as TemplateData } from "../models/Article.js";
import { type AiAssignmentType } from "../services/AiAssignment.js";
import { logger } from "../utils/Logger.js";

const template = [
  {
    name: 'Template 1',
    format: (data: TemplateData) => {
      if (!data.aiAnalysis || data.aiAnalysis.length === 0) return null;
      
      const stocks = data.aiAnalysis
        .map((s: AiAssignmentType) => `$${s.label} ${Math.round(s.confidence * 100)}%`)
        .join(' | ');
      
      return `🚨 ${data.title}\n📊 ${stocks}\n🎯 ${data.relevanceScore}/100\n\n${data.url}`;
    }
  },
  
  {
    name: 'Template 2',
    format: async (data: TemplateData) => {
      if (!data.aiAnalysis || data.aiAnalysis.length === 0) return null;
      
      const trend = data.trend? data.trend : ''
      const primary = data.aiAnalysis.reduce((max, item) =>
        item.confidence > max.confidence ? item : max
      );
      const others = data.aiAnalysis.filter(item => item !== primary);
      const icon = trend === "bullish" ? "📈" : "📉";
      
      const ripples = others.length 
        ? `\n\n⚡ ${others.map(s => `$${s.label} ${Math.round(s.confidence * 100)}%`).join(' ')}`
        : '';

      return `${icon} $${primary.label} | ${trend.toUpperCase()}\n\n${data.title}${ripples}\n\n🎯 ${Math.min(data.relevanceScore, 100)}/100\n\n${data.url}`;
    }
  },
  
  {
    name: 'Template 3 - Terminal Style',
    format: (data: TemplateData) => {
      if (!data.aiAnalysis || data.aiAnalysis.length === 0) return null;
      
      const top = data.aiAnalysis.reduce((max, item) =>
        item.confidence > max.confidence ? item : max
      );
      const others = data.aiAnalysis.slice(1, 3).map(s => `$${s.label}`).join(' ');
      const moreCount = data.aiAnalysis.length > 3 ? `+${data.aiAnalysis.length - 3}` : '';
      
      return `[ALERT] ${data.title}\n\nPRIMARY: $${top.label} ${Math.round(top.confidence * 100)}%\nRELATED: ${others} ${moreCount}\nIMPACT: ${data.relevanceScore}/100\n\n${data.url}`;
    }
  },
  
  {
    name: 'Template 4 - News Brief',
    format: async (data: TemplateData) => {
      if (!data.aiAnalysis || data.aiAnalysis.length === 0) return null;
      
      const trend = data.trend? data.trend : ''
      const tickers = data.aiAnalysis.slice(0, 3).map(s => `$${s.label}`).join(', ');
      
      return `📰 ${data.title}\n\nAffected equities: ${tickers}\nMarket view: ${trend}\nRelevance: ${data.relevanceScore}/100\n\n${data.url}`;
    }
  },
  
  {
    name: 'Template 5 - Flow Alert',
    format: async (data: TemplateData) => {
      if (!data.aiAnalysis || data.aiAnalysis.length === 0) return null;
      
      const trend = data.trend? data.trend : ''
      const emoji = trend === "bullish" ? "🐂" : "🐻";
      const primary = data.aiAnalysis.reduce((max, item) =>
        item.confidence > max.confidence ? item : max
      );
      const vol = data.aiAnalysis.length;
      
      return `${emoji} FLOW DETECTED\n\n${data.title}\n\n$${primary.label} • ${Math.round(primary.confidence * 100)}% confidence\n${vol} tickers flagged • Score: ${data.relevanceScore}\n\n${data.url}`;
    }
  },
  
  {
    name: 'Template 6 - Analysis Brief',
    format: (data: TemplateData) => {
      if (!data.aiAnalysis || data.aiAnalysis.length === 0) return null;
      
      const high = data.aiAnalysis.filter(s => s.confidence >= 0.7);
      const med = data.aiAnalysis.filter(s => s.confidence >= 0.4 && s.confidence < 0.7);
      
      const rating = data.relevanceScore >= 80 ? "STRONG" : data.relevanceScore >= 60 ? "MODERATE" : "WATCH";
      const stocks = [...high.slice(0, 2), ...med.slice(0, 1)].map(s => `$${s.label}`).join(' ');
      
      return `📊 ${rating} IMPACT\n\n${data.title}\n\nTickers: ${stocks}\nAnalysis score: ${data.relevanceScore}/100\n\n${data.url}`;
    }
  },
  
  {
    name: 'Template 7 - Sentiment Watch',
    format: async (data: TemplateData) => {
      if (!data.aiAnalysis || data.aiAnalysis.length === 0) return null;
      
      const trend = data.trend? data.trend : ''
      const mood = trend === "bullish" ? "🟢 BULLISH WATCH" : "🔴 BEARISH WATCH";
      const stocks = data.aiAnalysis.slice(0, 4).map(s => `$${s.label}`).join(' ');
      
      return `${mood}\n\n${data.title}\n\nWatching: ${stocks}\nCommunity relevance: ${data.relevanceScore}\n\n${data.url}`;
    }
  },
  
  {
    name: 'Template 8 - Position Alert',
    format: (data: TemplateData) => {
      if (!data.aiAnalysis || data.aiAnalysis.length === 0) return null;
      
      const lead = data.aiAnalysis.reduce((max, item) =>
        item.confidence > max.confidence ? item : max
      );
      const supporting = data.aiAnalysis.slice(1, 3).map(s => `$${s.label} (${Math.round(s.confidence * 100)}%)`).join(', ');
      
      return `⚠️ POSITION WATCH\n\n${data.title}\n\nLead: $${lead.label} ${Math.round(lead.confidence * 100)}%\nSecondary: ${supporting}\n\n${data.url}`;
    }
  },
  
  {
    name: 'Template 9 - Data Signal',
    format: async (data: TemplateData) => {
      if (!data.aiAnalysis || data.aiAnalysis.length === 0) return null;
      
      const trend = data.trend? data.trend : ''
      const avg = Math.round(data.aiAnalysis.reduce((sum, s) => sum + s.confidence, 0) / data.aiAnalysis.length * 100);
      const tickers = data.aiAnalysis.map(s => `$${s.label}`).join(' ');
      
      return `📡 SIGNAL: ${trend.toUpperCase()}\n\n${data.title}\n\n${tickers}\nAvg confidence: ${avg}% | Score: ${data.relevanceScore}\n\n${data.url}`;
    }
  }
];

const truncateTitle = (title: string, maxLength: number): string => {
  if (title.length <= maxLength) return title;
  
  const truncated = title.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  
  if (lastSpace > maxLength * 0.7) { 
    return truncated.slice(0, lastSpace) + '...';
  }
  
  return truncated + '...';
};

const cleanHashtags = (keywords: string[]): string[] => {
  return keywords
    .map(k => k.trim().replace(/\s+/g, ''))  
    .filter(k => k.length > 0)               
    .map(k => k.startsWith('#') ? k : `#${k}`); 
};

const fitHashtags = (hashtags: string[], availableSpace: number): string => {
  if (hashtags.length === 0 || availableSpace < 5) return '';
  
  const hashtagsCopy = [...hashtags];
  let result = hashtagsCopy.join(' ');
  
  while (result.length > availableSpace && hashtagsCopy.length > 0) {
    hashtagsCopy.pop();
    result = hashtagsCopy.join(' ');
  }
  
  return result;
};

const estimateTemplateOverhead = (templateIndex: number): number => {
  
  const overheads = [
    30,  
    50,  
    60,  
    50,  
    70,  
    50,  
    50,  
    60,  
    50   
  ];
  
  return overheads[templateIndex] || 50;
};

const getRandomTweetTemplate = async (
  data: TemplateData, 
  retries = 5
): Promise<string | null> => {
  if (!data.aiAnalysis || data.aiAnalysis.length === 0 || data.aiAnalysis[0]?.name === 'UNKNOWN') {
    logger.warn('Skipping tweet - no AI analysis available');
    return null;
  }

  const TWEET_LIMIT = 280;
  const urlLength = data.url.length;
  const cleanedHashtags = cleanHashtags(data.keywords);
  
  const URL_SPACE = urlLength + 4; 
  
  const tickerSpace = data.aiAnalysis
    .slice(0, 3)
    .map(s => `$${s.label} ${Math.round(s.confidence * 100)}%`)
    .join(' | ')
    .length;
  
  
  for (let attempt = 0; attempt < retries; attempt++) {
    const idx = Math.floor(Math.random() * template.length);
    const templateOverhead = estimateTemplateOverhead(idx);
    
    const spaceForTitleAndHashtags = TWEET_LIMIT - URL_SPACE - tickerSpace - templateOverhead;
  
    const minHashtagSpace = Math.min(20, cleanedHashtags.join(' ').length);
    const maxTitleLength = spaceForTitleAndHashtags - minHashtagSpace;
    
    const modifiedData = {
      ...data,
      title: truncateTitle(data.title, Math.max(maxTitleLength, 30)) 
    };
    
    
    const tweet = await template[idx]?.format(modifiedData);
    
    if (!tweet) continue;
    
    if (tweet.length <= TWEET_LIMIT) {
    
      const remainingSpace = TWEET_LIMIT - tweet.length - 2; 
      const hashtagString = fitHashtags(cleanedHashtags, remainingSpace);
      
      if (hashtagString) {
        return `${tweet}\n\n${hashtagString}`;
      }
      
      return tweet;
    }
  }
  
  const primary = data.aiAnalysis.reduce((max, item) =>
    item.confidence > max.confidence ? item : max
  );
  
  const fallbackOverhead = 30; 
  const fallbackTitleLength = TWEET_LIMIT - URL_SPACE - fallbackOverhead - 20; 
  
  const shortTitle = truncateTitle(data.title, Math.max(fallbackTitleLength, 40));
  const fallbackTweet = `$${primary.label} ${Math.round(primary.confidence * 100)}% • ${shortTitle}\n\n${data.url}`;
  
  const remainingSpace = TWEET_LIMIT - fallbackTweet.length - 2;
  const hashtagString = fitHashtags(cleanedHashtags, remainingSpace);
  
  if (hashtagString) {
    return `${fallbackTweet}\n\n${hashtagString}`;
  }
  
  return fallbackTweet;
};

export { template, type TemplateData, getRandomTweetTemplate };