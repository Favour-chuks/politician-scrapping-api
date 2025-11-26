import {Redis, type RedisOptions} from 'ioredis';
import { logger } from '../utils/Logger.js';
interface ValkeyConfig {
  uri?: string;
}

class ValkeyClient {
  private client:any;
  private static instance: ValkeyClient;

  private constructor(config: ValkeyConfig) {
    const { uri} = config;

   if(!uri) {
     throw new Error("Aiven Valkey configuration is incomplete");
   }

    this.client = new Redis(uri);
    // Connection events
    this.client.on('connect', () => {
      logger.info("Connected to Aiven Valkey")
    });

    this.client.on('error', (err:any) => {
      logger.error({error: err.message}, 'Valkey connection error');

      this.client.disconnect();
    });

    this.client.on('close', () => {
      logger.info('Valkey connection closed');
    });
  }

  public static getInstance(config?: ValkeyConfig): ValkeyClient {
    if (!ValkeyClient.instance) {
      if (!config) {
        throw new Error('Config required for first initialization');
      }
      ValkeyClient.instance = new ValkeyClient(config);
    }
    return ValkeyClient.instance;
  }

  public getClient() {
    return this.client;
  }

  public async disconnect(): Promise<void> {
    await this.client.quit();
  }

  public async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      return false;
    }
  }
}

export const initializeValkey = (config: ValkeyConfig) => {
  return ValkeyClient.getInstance(config);
};

export const getValkeyClient = () => {
  return ValkeyClient.getInstance().getClient();
};

export default ValkeyClient;