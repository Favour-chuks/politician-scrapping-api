export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "13.0.5"
  }
  public: {
    Tables: {
      article_stocks: {
        Row: {
          article_id: string
          confidence: number
          created_at: string | null
          explanation: string | null
          id: string
          impact_level: string | null
          ticker: string
          trend: string | null
        }
        Insert: {
          article_id: string
          confidence: number
          created_at?: string | null
          explanation?: string | null
          id?: string
          impact_level?: string | null
          ticker: string
          trend?: string | null
        }
        Update: {
          article_id?: string
          confidence?: number
          created_at?: string | null
          explanation?: string | null
          id?: string
          impact_level?: string | null
          ticker?: string
          trend?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "article_stocks_article_id_fkey"
            columns: ["article_id"]
            isOneToOne: false
            referencedRelation: "articles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "article_stocks_ticker_fkey"
            columns: ["ticker"]
            isOneToOne: false
            referencedRelation: "stocks"
            referencedColumns: ["ticker"]
          },
        ]
      }
      articles: {
        Row: {
          content: string | null
          created_at: string | null
          id: string
          keywords: string[] | null
          metadata: Json | null
          published_at: string | null
          relevance_score: number | null
          scraped_at: string | null
          source: string | null
          title: string
          updated_at: string | null
          url: string
        }
        Insert: {
          content?: string | null
          created_at?: string | null
          id?: string
          keywords?: string[] | null
          metadata?: Json | null
          published_at?: string | null
          relevance_score?: number | null
          scraped_at?: string | null
          source?: string | null
          title: string
          updated_at?: string | null
          url: string
        }
        Update: {
          content?: string | null
          created_at?: string | null
          id?: string
          keywords?: string[] | null
          metadata?: Json | null
          published_at?: string | null
          relevance_score?: number | null
          scraped_at?: string | null
          source?: string | null
          title?: string
          updated_at?: string | null
          url?: string
        }
        Relationships: []
      }
      scraping_logs: {
        Row: {
          created_at: string | null
          errors: Json | null
          id: string
          source: string
          started_at: string
          status: string | null
        }
        Insert: {
          created_at?: string | null
          errors?: Json | null
          id?: string
          source: string
          started_at: string
          status?: string | null
        }
        Update: {
          created_at?: string | null
          errors?: Json | null
          id?: string
          source?: string
          started_at?: string
          status?: string | null
        }
        Relationships: []
      }
      stocks: {
        Row: {
          company_name: string
          created_at: string | null
          market_cap: number | null
          sector: string | null
          ticker: string
          updated_at: string | null
        }
        Insert: {
          company_name: string
          created_at?: string | null
          market_cap?: number | null
          sector?: string | null
          ticker: string
          updated_at?: string | null
        }
        Update: {
          company_name?: string
          created_at?: string | null
          market_cap?: number | null
          sector?: string | null
          ticker?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      tweet_quota: {
        Row: {
          created_at: string | null
          daily_tweets_sent: number | null
          last_tweet_date: string
          month: string
          tweets_sent: number | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          daily_tweets_sent?: number | null
          last_tweet_date: string
          month: string
          tweets_sent?: number | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          daily_tweets_sent?: number | null
          last_tweet_date?: string
          month?: string
          tweets_sent?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      increment_tweet_count: {
        Args: { month_param: string }
        Returns: {
          daily_tweets_sent: number
          tweets_sent: number
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
