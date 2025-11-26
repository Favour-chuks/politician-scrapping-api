import type { AiAssignmentType } from "../services/AiAssignment.js";

export type Article = {
  id: string;
  title: string;
  content: string;
  url: string;
  source: string;
  publishDate: Date;
  keywords: string[];
  relevanceScore: number;
  isRssFeed: boolean;
  rippleValidity?: 'HIGH' | 'MODERATE' | 'LOW',
  trend?: "bearish" | "bullish",
  aiAnalysis: AiAssignmentType[];
}

export interface KeywordWeight {
  keyword: string;
  points: number;
  category?: string | undefined;
}

export interface ArticleAnalysis {
  article: Article;
  keywordMatches: Array<{
    keyword: string;
    count: number;
    points: number;
  }>;
  totalScore: number;
  tradingSignal: 'green' | 'yellow' | 'red';
}