import { createClient } from '@supabase/supabase-js';
import type { Database } from '../types/database.types.js';
import { config } from './environmentalVariables.js';

const { supabase_url, supabase_service_role_key } = config;

let supabase: ReturnType<typeof createClient<Database>> | null = null;

if (!supabase_service_role_key || !supabase_url) {
  console.warn('[⚠️  WARNING] Missing Supabase environment variables. Database operations will not work.');
  console.warn('[⚠️  Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables to enable database features');
} else {
  supabase = createClient<Database>(supabase_url, supabase_service_role_key);
}

export { supabase };
