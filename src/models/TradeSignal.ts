export interface TradeSignal {
  id: string;
  timestamp: Date;
  source: 'news' | 'volume';
  confidence: 'high' | 'medium' | 'low';
  riskLevel: 'low' | 'medium' | 'high';
  newsAnalysis?: {
    articleId: string;
    relevanceScore: number;
    keywordMatches: string[];
  };
  volumeAnalysis?: {
    spikePercentage: number;
    timeFrame: string;
    averageVolume: number;
    currentVolume: number;
  };
  validationStatus: 'pending' | 'approved' | 'rejected';
  tweetId?: string;
}