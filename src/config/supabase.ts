import { createClient } from '@supabase/supabase-js';
import type { Database } from '../types/database.types.js';
import { config } from './environmentalVariables.js';

const { supabase_url, supabase_service_role_key } = config

if (!supabase_service_role_key || !supabase_url) {
  throw new Error('Missing Supabase environment variables');
}

export const supabase = createClient<Database>(supabase_url, supabase_service_role_key);
