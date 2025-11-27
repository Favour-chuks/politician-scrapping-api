import dotenv from 'dotenv';
import path from "path";
import { fileURLToPath } from "url";


if (process.env.NODE_ENV !== "production") {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  dotenv.config({ path: path.resolve(__dirname, "../../.env") });
}


export const config = {
 node_port: process.env.PORT,
 redis_service_uri: process.env.REDIS_SERVICE_URI,
 redis_port: process.env.REDIS_PORT,
 redis_host: process.env.REDIS_HOST,
 redis_password: process.env.REDIS_PASSWORD,
 redis_username: process.env.REDIS_USERNAME,
 openai_api_key: process.env.OPENAI_API_KEY,
 gemini_api_key: process.env.GEMINI_API_KEY,
 twitter_api_key: process.env.TWITTER_API_KEY,
 twitter_key_secret: process.env.TWITTER_API_KEY_SECRET,
 twitter_bearer_token: process.env.TWITTER_BEARER_TOKEN,
 twitter_access_token: process.env.TWITTER_ACCESS_TOKEN,
 twitter_access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
 supabase_api_key: process.env.SUPABASE_API_KEY,
 supabase_url: process.env.SUPABASE_URL,
 supabase_service_role_key: process.env.SUPABASE_SERVICE_ROLE_KEY
}