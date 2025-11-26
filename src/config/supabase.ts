import { createClient } from '@supabase/supabase-js';
import type { Database } from '../types/database.types.js';
import { config } from './environmentalVariables.js';

const { supabase_url, supabase_service_role_key } = config

if (!supabase_service_role_key || !supabase_url) {
  throw new Error('Missing Supabase environment variables');
}

// TODO: remember to remove this 
const options = {
  db: {
    schema: 'public',
  },
  auth: {
    autoRefreshToken: false,   
    persistSession: false,     
    detectSessionInUrl: false
  },
  global: {
    headers: { 'x-app-name': 'stock-news-scraper' },
  },
} as const

export const supabase = createClient<Database>(supabase_url, supabase_service_role_key);
