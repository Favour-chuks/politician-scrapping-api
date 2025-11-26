import pino, { type LoggerOptions } from 'pino';

const getLogLevel = (): pino.Level => {
  if (process.env.LOG_LEVEL) {
    return process.env.LOG_LEVEL as pino.Level;
  }
  
  switch (process.env.NODE_ENV) {
    case 'production':
      return 'warn';
    case 'test':
      return 'error';
    case 'development':
    default:
      return 'debug';
  }
};

const createLogger = () => {
  const config: LoggerOptions = {
    level: getLogLevel(),
  };
  
  if (process.env.NODE_ENV === 'development') {
    try {
      config.transport = {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname'
        }
      };
    } catch (error) {
      console.warn('pino-pretty not available, using standard output');
    }
  }
  
  return pino(config);
};

export const logger = createLogger();