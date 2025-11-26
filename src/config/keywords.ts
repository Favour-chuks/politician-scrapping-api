export const keywordCategories = {
  highImpact: {
    points: 10,
    keywords: [
      // Legal/Criminal/Regulatory
      'impeachment',
      'resignation',
      'scandal',
      'investigation',
      'indictment',
      'criminal charge',
      'corruption',
      'fraud',
      'federal probe',
      'DOJ investigation',
      'securities fraud',
      'RICO charges',
      'money laundering',
      'insider trading',
      'market manipulation',
      
      // Elections/Democracy
      'election',
      'electoral fraud',
      'voter fraud',
      'ballot',
      'campaign finance',
      'campaign donation',
      'election interference',
      'vote rigging',
      'contested election',
      'presidential race',
      'election results',
      
      // Executive Actions
      'executive order',
      'emergency declaration',
      'presidential directive',
      'national emergency',
      'martial law',
      'federal intervention',
      'emergency powers',
      'federal mandate',
      'regulatory crackdown',
      'federal seizure',
      
      // Major Events/Crises
      'constitutional crisis',
      'coup attempt',
      'insurrection',
      'civil unrest',
      'state of emergency',
      'terror attack',
      'cyber attack',
      'critical infrastructure',
      'national security threat',
      'military conflict',
      'war declaration',
      'armed conflict',
      'military operation',
      'nuclear threat',
      'missile launch',
      
      // Financial Crises
      'market crash',
      'financial crisis',
      'bank collapse',
      'systemic risk',
      'financial contagion',
      'bank run',
      'market manipulation',
      'trading halt',
      'circuit breaker',
      'market closure',
      'bubble',
      
      // Natural/Health Disasters
      'pandemic',
      'epidemic',
      'health emergency',
      'natural disaster',
      'catastrophic event',
      'mass evacuation',
      'environmental disaster',
      'nuclear incident',
      'chemical spill',
      'critical shortage',
      
      // International Conflicts
      'diplomatic crisis',
      'international conflict',
      'sanctions regime',
      'trade embargo',
      'asset freeze',
      'military buildup',
      'naval blockade',
      'border closure',
      'airspace violation',
      'sovereign default',
      'freeze',
      
      // Tech/Infrastructure
      'critical vulnerability',
      'massive data breach',
      'infrastructure failure',
      'grid collapse',
      'communications blackout',
      'internet shutdown',
      'ransomware attack',
      'supply chain attack',
      'critical zero-day',
      'mass outage',
      
    ]
  },

  // Policy-related keywords (medium-high points)
  policy: {
    points: 7,
    keywords: [
      // Legislative Process
      'bill passed',
      'legislation',
      'reform',
      'regulation',
      'deregulation',
      'policy change',
      'amendment',
      'vote',
      'filibuster',
      'veto',
      'override',
      
      // Policy Areas
      'healthcare reform',
      'tax reform',
      'immigration reform',
      'climate policy',
      'defense spending',
      'infrastructure bill',
      'budget proposal',
      'debt ceiling',
      'subsidies',
      'subsidy',
      'welfare reform',
      
      // International
      'trade agreement',
      'sanctions',
      'sanction',
      'diplomatic relations',
      'treaty',
      'international agreement',
      'international trade',
      'international relations'
    ]
  },

  // Economic indicators (medium points)
  economic: {
    points: 5,
    keywords: [
      // Monetary Policy & Central Bank
      'federal reserve',
      'interest rate',
      'inflation',
      'deflation',
      'monetary policy',
      'quantitative easing',
      'rate hike',
      'rate cut',
      'fed minutes',
      'fed meeting',
      'hawkish',
      'dovish',
      'powell',
      'fomc',
      'basis points',
      'bond yields',
      'treasury yields',
      'yield curve',
      'inverted yield',
      
      // Economic Indicators
      'gdp',
      'unemployment',
      'job report',
      'nonfarm payrolls',
      'economic growth',
      'recession',
      'depression',
      'market crash',
      'bear market',
      'bull market',
      'consumer confidence',
      'retail sales',
      'housing starts',
      'building permits',
      'existing home sales',
      'new home sales',
      'durable goods',
      'industrial production',
      'manufacturing pmi',
      'services pmi',
      'ism index',
      'cpi data',
      'ppi data',
      'inflation rate',
      'core inflation',
      
      // Fiscal Policy & Government
      'fiscal policy',
      'stimulus package',
      'economic relief',
      'bailout',
      'federal budget',
      'deficit spending',
      'national debt',
      'tax revenue',
      'tax reform',
      'infrastructure spending',
      'government shutdown',
      'debt ceiling',
      'austerity',
      'fiscal cliff',
      
      // Trade & International
      'trade deficit',
      'trade surplus',
      'tariffs',
      'trade war',
      'currency manipulation',
      'exchange rate',
      'forex',
      'dollar index',
      'euro dollar',
      'yuan',
      'devaluation',
      'trade balance',
      'current account',
      'capital flows',
      'foreign investment',
      
      // Market Indicators
      'volatility index',
      'vix',
      'market volatility',
      'risk appetite',
      'risk aversion',
      'safe haven',
      'flight to safety',
      'margin debt',
      'fund flows',
      'market liquidity',
      'trading volume',
      'short interest',
      'put call ratio',
      'market breadth',
      'technical levels',
      'resistance level',
      'support level',
      
      // Commodities & Energy
      'oil prices',
      'natural gas',
      'gold prices',
      'gold',
      'silver',
      'lithium',
      'silver prices',
      'commodity index',
      'energy prices',
      'opec',
      'oil production',
      'strategic reserves',
      'metals prices',
      'rare earth metals',
      'rare-earth',
      'agricultural prices'
    ]
  },

  // Political positions (medium-low points)
  positions: {
    points: 3,
    keywords: [
      // Appointments/Changes
      'appointed',
      'nominated',
      'confirmed',
      'resigned',
      'stepping down',
      'successor',
      'interim',
      
      // Legislative Positions
      'committee chair',
      'chairman',
      'chairwoman',
      'majority leader',
      'minority leader',
      'whip',
      'speaker of the house',
      
      // Executive Positions
      'secretary of state',
      'attorney general',
      'cabinet secretary',
      'chief of staff',
      'spokesperson',
      'press secretary',
      'national security advisor',
      
      // Elected Officials
      'president',
      'vice president',
      'congressman',
      'congresswoman',
      'representative',
      'senator',
      'governor',
      'mayor',
      
      // Diplomatic
      'ambassador',
      'envoy',
      'diplomat',
      'consul',
      'attaché'
    ]
  },

  // General political terms (low points)
  business: {
    points: 6,
    keywords: [
      // Growth & Success

      'record profit',
      'earnings beat',
      'stock surge',
      'revenue growth',
      'market expansion',
      'acquisition',
      'aquisitions',
      'merger',
      'IPO',
      'new investment',
      'investment',
      'invest',
      'invested',
      'new investors',
      'investor',
      'investor',
      'funding round',
      'market leader',
      'breakthrough',
      'innovation',
      'innovated',
      'market share gain',
      'guidance raised',
      'outperform',
      'strong buy',
      'upgrade',
      'price target raised',
      'buy rating',
      'overweight rating',
      'all-time high',
      'record sales',
      'blockbuster earnings',
      'exceeds expectations',
      'positive outlook',
      'dividend increase',
      'stock buyback',
      'share repurchase',
      
      // Business Challenges
      'bankruptcy',
      'stock plunge',
      'earnings miss',
      'revenue decline',
      'layoffs',
      'lay off',
      'mass layoffs',
      'job cuts',
      'downsizing',
      'restructuring',
      'losses',
      'debt default',
      'credit downgrade',
      'market exit',
      'guidance lowered',
      'underperform',
      'sell rating',
      'downgrade',
      'price target cut',
      'profit warning',
      'missed estimates',
      'negative outlook',
      'dividend cut',
      'dividend suspended',
      'going concern',
      'liquidity issues',
      'cash burn',
      'default risk',
      
      // Corporate Events
      'CEO departure',
      'executive change',
      'strategic review',
      'spinoff',
      '',
      'divestment',
      'hostile takeover',
      'shareholder revolt',
      'activist investor',
      'board shakeup',
      'management change',
      'insider trading',
      'proxy fight',
      'tender offer',
      'poison pill',
      'golden parachute',
      'corporate governance',
      'succession plan',
      'executive compensation',
      'shareholder lawsuit',
      'proxy battle',
      
      // Regulatory & Legal
      'SEC investigation',
      'regulatory approval',
      'antitrust',
      'patent dispute',
      'class action',
      'settlement',
      'corporate fraud',
      'CFIUS review',
      'FDA approval',
      'clinical trial',
      'phase 3 results',
      'regulatory clearance',
      'consent decree',
      'compliance violation',
      'regulatory fine',
      'whistleblower',
      'data breach',
      'cybersecurity',
      'privacy violation',
      'product recall',
      'safety concern',
      
      // Market Position & Strategy
      'market dominance',
      'competitive advantage',
      'industry leader',
      'market disruption',
      'business transformation',
      'digital transformation',
      'market penetration',
      'new product launch',
      'product pipeline',
      'strategic partnership',
      'joint venture',
      'exclusive deal',
      'contract win',
      'contract',
      'government contractor',
      'market expansion',
      'global expansion',
      'new market entry',
      'market consolidation',
      'industry consolidation',
      
      // Financial Metrics & Performance
      'profit margin',
      'revenue growth',
      'market cap',
      'valuation',
      'cash flow',
      'debt ratio',
      'operating costs',
      'EBITDA growth',
      'free cash flow',
      'operating margin',
      'gross margin',
      'net income',
      'earnings per share',
      'revenue forecast',
      'cost reduction',
      'synergy targets',
      'debt restructuring',
      'capital raise',
      'equity offering',
      'debt offering',
      'convertible notes',
      
      // Industry-Specific
      'chip shortage',
      'supply chain',
      'raw materials',
      'commodity prices',
      'energy costs',
      'labor shortage',
      'union contract',
      'strike',
      'work stoppage',
      'facility closure',
      'capacity expansion',
      'new facility',
      'production issues',
      'inventory levels',
      'backlog',
      'order book',
    ]
  },

  general: {
    points: 1,
    keywords: [
      // Communications
      'statement',
      'announcement',
      'press release',
      'press briefing',
      'news conference',
      'press conference',
      'media briefing',
      'interview',
      'comment',
      'response',
      'remarks',
      
      // Political Actions
      'campaign',
      'rally',
      'debate',
      'speech',
      'address',
      'testimony',
      'hearing',
      'subpoena',
      
      // Meetings/Events
      'summit',
      'bilateral meeting',
      'state visit',
      'diplomatic meeting',
      'official visit',
      'ceremony',
      
      // Public Opinion
      'poll',
      'approval rating',
      'public opinion',
      'controversy',
      'backlash',
      'protest'
    ]
  }
};

export const keywordWeights = Object.entries(keywordCategories).flatMap(
  ([category, { points, keywords }]) =>
    keywords.map(keyword => ({
      keyword,
      points,
      category
    }))
);


export const contentThresholds = {
  rss: {
    minimumScore: 15, 
    requiredKeywords: 3 
  },
  html: {
    minimumScore: 60,
    requiredKeywords: 10 
  }
};

// TODO: come back and finish the trend detector
// export const getTrend = async (text: string): Promise<"bearish" | "bullish"> => {
//   return "bullish"
// }

export const getTrend = (text: string): "bearish" | "bullish" => {
  const lowerText = text.toLowerCase();
  
  // Bullish indicators
  const bullishKeywords = [
    'surge', 'soar', 'rally', 'gain', 'rise', 'climb', 'jump', 'spike',
    'record high', 'all-time high', 'breakthrough', 'success', 'beat expectations',
    'outperform', 'upgrade', 'strong buy', 'bullish', 'growth', 'expansion',
    'profit', 'revenue growth', 'earnings beat', 'positive outlook',
    'optimistic', 'boost', 'uptick', 'improvement', 'recovering', 'momentum',
    'exceeds', 'confidence', 'strength', 'robust', 'thriving'
  ];
  
  // Bearish indicators
  const bearishKeywords = [
    'plunge', 'crash', 'fall', 'drop', 'decline', 'sink', 'tumble', 'slump',
    'collapse', 'downturn', 'losses', 'miss', 'disappointing', 'weak',
    'downgrade', 'bearish', 'recession', 'layoffs', 'bankruptcy', 'default',
    'crisis', 'concern', 'worry', 'fear', 'warning', 'risk', 'threat',
    'negative outlook', 'underperform', 'struggling', 'vulnerable', 'pressure',
    'cut', 'reduce', 'suspension', 'investigation', 'fraud', 'scandal'
  ];
  
  let bullishScore = 0;
  let bearishScore = 0;
  
  // Count bullish keywords
  for (const keyword of bullishKeywords) {
    const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
    const matches = lowerText.match(regex);
    if (matches) {
      bullishScore += matches.length;
    }
  }
  
  // Count bearish keywords
  for (const keyword of bearishKeywords) {
    const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
    const matches = lowerText.match(regex);
    if (matches) {
      bearishScore += matches.length;
    }
  }
  
  // Return trend based on scores
  // Default to bullish if neutral (equal scores)
  return bearishScore > bullishScore ? 'bearish' : 'bullish';
};
