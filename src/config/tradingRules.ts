// Scoring thresholds for trade signals
export const tradingRules = {
  // Minimum scores required for different confidence levels
  scoreThresholds: {
    high: 15, // High confidence when total score exceeds this
    medium: 10, // Medium confidence when total score exceeds this
    low: 5 // Low confidence when total score exceeds this
  },

  // Volume spike thresholds
  volumeThresholds: {
    significant: 50, // 50% increase from average
    moderate: 25, // 25% increase from average
    minor: 10 // 10% increase from average
  },

  // Time windows for analysis (in minutes)
  timeWindows: {
    volumeSpike: 15, // Check volume changes over 15 minutes
    newsRelevance: 60, // Consider news from last hour
    trendAnalysis: 240 // Look at 4-hour trend for context
  },

  // Risk assessment rules
  riskLevels: {
    low: {
      requiredSignals: 2, // Both news and volume signals positive
      minimumConfidence: 'high',
      minimumScore: 15
    },
    medium: {
      requiredSignals: 1, // At least one signal positive
      minimumConfidence: 'medium',
      minimumScore: 10
    },
    high: {
      requiredSignals: 1,
      minimumConfidence: 'low',
      minimumScore: 5
    }
  },

  // Validation rules
  validation: {
    minimumKeywords: 3, // Minimum unique keywords in article
    maximumAge: 120, // Maximum age of news in minutes
    requiredCategories: 2, // Minimum number of different keyword categories
    blackoutPeriod: 30 // Minimum minutes between trades
  }
};