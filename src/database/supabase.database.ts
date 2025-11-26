import { supabase } from '../config/supabase.js';
import type { Database } from '../types/database.types.js';
import type { Article } from '../models/Article.js';
import { logger } from '../utils/Logger.js';

type ArticleInsert = Database['public']['Tables']['articles']['Insert'];
type StockInsert = Database['public']['Tables']['stocks']['Insert'];

export class DatabaseRepository {
  async ensureStocksExist(stocks: StockInsert[]) {
    const formatted = stocks.map(s => ({
      ticker: s.ticker.toUpperCase(),
      company_name: s.company_name || s.ticker.toUpperCase(),
      sector: s.sector || null
    }));

    const { error } = await supabase
      .from('stocks')
      .upsert(formatted, { onConflict: 'ticker', ignoreDuplicates: true });

    if (error) throw error;
  }

  async getStock(ticker: string) {
    const { data, error } = await supabase
      .from('stocks')
      .select('*')
      .eq('ticker', ticker.toUpperCase())
      .single();

    if (error) throw error;
    return data;
  }

  async getAllStocks() {
    const { data, error } = await supabase
      .from('stocks')
      .select('*')
      .order('ticker');

    if (error) throw error;
    return data;
  }

 async createArticlesBatch(articles: Article[]) {
   if (articles.length === 0) return [];

   const { data: newArticles, error: articleError } = await supabase
     .from('articles')
     .insert(articles.map(a => ({
       title: a.title,
       url: a.url,
       content: a.content ?? null,
       source: a.source ?? null,
       keywords: a.keywords ?? [],
       relevance_score: a.relevanceScore ?? null,
       published_at: a.publishDate?.toISOString() ?? null
     })))
     .select();

    if (articleError) {
      throw articleError;
    }
   if (!newArticles) throw new Error('No articles returned');

   const urlToId = new Map(newArticles.map(a => [a.url, a.id]));

   const articleStocks = articles.flatMap(article => {
     const articleId = urlToId.get(article.url);
     if (!articleId) return [];
     
     return article.aiAnalysis.map(analysis => ({
       article_id: articleId,
       ticker: analysis.label.toUpperCase(),
       confidence: analysis.confidence,
       trend: article.trend ??  null,
       impact_level: null,
       explanation: analysis.explanation ?? null
     }));
   });

   if (articleStocks.length > 0) {
     const { error } = await supabase
       .from('article_stocks')
       .insert(articleStocks);

     if (error) throw error;
   }

   return newArticles;
 }

 async processArticlesInBatches(articles: Article[], batchSize = 10) {
  for (let i = 0; i < articles.length; i += batchSize) {
    const batch = articles.slice(i, i + batchSize);
    await this.createArticlesBatch(batch);
    
    // Allow garbage collection between batches
    if (global.gc) global.gc();
  }
 }

  async createArticle(article: ArticleInsert) {
    const { data, error } = await supabase
      .from('articles')
      .insert({
        title: article.title,
        url: article.url,
        content: article.content || null,
        source: article.source || null,
        keywords: article.keywords || [],
        relevance_score: article.relevance_score || null,
        published_at: article.published_at || null
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async createArticleWithStocks(article: Article) {
  if(article.aiAnalysis.length > 0) {
   const stocksToInsert = article.aiAnalysis.map(s => ({
    ticker: s.label.toUpperCase(),
    company_name: s.name || s.label.toUpperCase(),
    sector: null,
    market_cap: null
   }));
   
   const {error: stockError } = await supabase
   .from('stocks')
   .upsert(stocksToInsert, {onConflict: 'ticker', ignoreDuplicates: true});

   if (stockError) throw stockError;
  }

  const { data: newArticle, error: articleError } = await supabase
  .from('articles')
  .insert({
   title: article.title,
   url: article.url,
   content: article.content ?? null,
   source: article.source ?? null,
   keywords: article.keywords ?? [],
   relevance_score: article.relevanceScore ?? null,
   published_at: article.publishDate ? article.publishDate.toISOString():  null,
  })
  .select()
  .single()

  if (articleError) throw articleError;

  if(article.aiAnalysis.length > 0) {
   const articleStocksToInsert = article.aiAnalysis.map(s => ({
    article_id: newArticle.id,
    ticker: s.label,
    confidence: s.confidence,
    trend: null,
    impact_level:  null,
    explanation: s.explanation ?? null
   }));

   const { error: linkError } = await supabase
       .from('article_stocks') 
       .insert(articleStocksToInsert);

     if (linkError) throw linkError;
  }

  return newArticle;
  }

  async getArticleById(id: string) {
    const { data, error } = await supabase
      .from('articles')
      .select(`
        *,
        article_stocks (
          *,
          stocks (*)
        )
      `)
      .eq('id', id)
      .single();

    if (error) throw error;
    return data;
  }

  async getArticlesBySource(source: string, limit = 50) {
    const { data, error } = await supabase
      .from('articles')
      .select('*')
      .eq('source', source)
      .order('published_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data;
  }

  async getRecentArticles(limit = 50) {
    const { data, error } = await supabase
      .from('articles')
      .select(`
        *,
        article_stocks (
          *,
          stocks (*)
        )
      `)
      .order('scraped_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data;
  }

  async articleExists(url: string): Promise<boolean> {
    const { data } = await supabase
      .from('articles')
      .select('id')
      .eq('url', url)
      .single();

    return !!data;
  }

  async createArticleStocks(articleId: string, article:Article){
   const { error } = await supabase
   .from('article_stocks')
   .insert(
    article.aiAnalysis.map(s => ({
     article_id: articleId,
     ticker: s.label.toUpperCase(),
     confidence: s.confidence,
     trend: null,
     impact_level: null,
     explanation: s.explanation
    }))
   );

   if(error) throw error;
  }

  async getArticlesByStock(ticker: string, limit = 50) {
    const { data, error } = await supabase
      .from('article_stocks')
      .select(`
        *,
        articles (*)
      `)
      .eq('ticker', ticker.toUpperCase())
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data;
  }

  async getBullishArticles(limit = 50) {
    const { data, error } = await supabase
      .from('article_stocks')
      .select(`*, articles (*)`)
      .eq('trend', 'bullish')
      .order('confidence', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data;
  }

  async logScraping(
    source: string,
    status: 'success' | 'failed' | 'partial',
    errors?: any[]
  ) {
    const { error } = await supabase
      .from('scraping_logs')
      .insert({
        source,
        status,
        errors: errors || null,
        started_at: new Date().toISOString()
      });

    if (error) throw error;
  }

  async getScrapingLogs(source?: string, limit = 100) {
    let query = supabase
      .from('scraping_logs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(limit);

    if (source) {
      query = query.eq('source', source);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data;
  }


}


export const db = new DatabaseRepository();